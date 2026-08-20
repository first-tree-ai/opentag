import {
  ClientRuntimeFrameSchema,
  type ComputerRegisterFrame,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_V0_CAPABILITIES,
  type RuntimeClientCapabilities,
  type RuntimeErrorFrame,
  RuntimeFrameEnvelopeSchema,
  type RuntimeProviderReadinessObservation,
  runtimeFrameByteLength,
  type ServerRuntimeFrame,
  ServerWelcomeFrameSchema,
} from "@opentag/shared";
import WebSocket, { type RawData } from "ws";
import {
  endRuntimeConnectionSpan,
  endRuntimeFrameSpan,
  runInRuntimeFrameSpan,
  runtimeAttrs,
  setRuntimeConnectionAttrs,
  startRuntimeConnectionSpan,
  startRuntimeFrameSpan,
} from "../observability/index.js";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";
import type { ComputerService } from "../services/computers/index.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { KeyedTaskScheduler } from "./keyed-task-scheduler.js";

const CLIENT_CONTROL_FRAME_TYPES = new Set(["auth", "computer:register", "heartbeat", "error"]);

export type RuntimeServerBusinessFrame = Readonly<Record<string, unknown>> & { readonly type: string };

export interface RuntimeBusinessContext {
  computerId: string;
  instanceId: string;
  signal: AbortSignal;
  userId: string;
}

export interface RuntimeBusinessOptions {
  failureResult(frame: RuntimeServerBusinessFrame): unknown;
  handle(frame: RuntimeServerBusinessFrame, context: RuntimeBusinessContext): Promise<unknown> | unknown;
  laneKey(frame: RuntimeServerBusinessFrame): string;
  maxConcurrent?: number;
  maxQueuedPerKey?: number;
  maxQueuedTotal?: number;
  overloadResult(frame: RuntimeServerBusinessFrame): unknown;
  parse(frame: unknown): RuntimeServerBusinessFrame | undefined;
}

export interface RuntimeSessionOptions {
  authTimeoutMs?: number;
  business?: RuntimeBusinessOptions;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  now?: () => Date;
  registerTimeoutMs?: number;
}

export class RuntimeSession {
  readonly #auth: UserAuthService;
  readonly #computers: ComputerService;
  readonly #registry: ConnectionRegistry;
  readonly #socket: WebSocket;
  readonly #options: Required<Omit<RuntimeSessionOptions, "business" | "now">> & {
    business?: RuntimeBusinessOptions;
    now: () => Date;
  };
  readonly #abort = new AbortController();
  readonly #businessScheduler?: KeyedTaskScheduler;
  #state: "await-auth" | "await-register" | "registered" | "closing" | "closed" = "await-auth";
  #timer?: ReturnType<typeof setTimeout>;
  #tokenTimer?: ReturnType<typeof setTimeout>;
  #handshakeInFlight = false;
  #heartbeatInFlight = false;
  #userId?: string;
  #computerId?: string;
  #instanceId?: string;

  constructor(
    socket: WebSocket,
    auth: UserAuthService,
    computers: ComputerService,
    registry: ConnectionRegistry,
    options: RuntimeSessionOptions = {},
  ) {
    this.#socket = socket;
    this.#auth = auth;
    this.#computers = computers;
    this.#registry = registry;
    const heartbeat = ServerWelcomeFrameSchema.parse({
      type: "server:welcome",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      capabilities: RUNTIME_V0_CAPABILITIES,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 90_000,
    });
    this.#options = {
      authTimeoutMs: positiveTimeout(options.authTimeoutMs ?? 5_000, "authTimeoutMs"),
      business: options.business,
      heartbeatIntervalMs: heartbeat.heartbeatIntervalMs,
      heartbeatTimeoutMs: heartbeat.heartbeatTimeoutMs,
      now: options.now ?? (() => new Date()),
      registerTimeoutMs: positiveTimeout(options.registerTimeoutMs ?? 5_000, "registerTimeoutMs"),
    };
    if (options.business) {
      this.#businessScheduler = new KeyedTaskScheduler({
        maxConcurrent: options.business.maxConcurrent ?? 16,
        maxQueuedPerKey: options.business.maxQueuedPerKey ?? 32,
        maxQueuedTotal: options.business.maxQueuedTotal ?? 256,
      });
    }
  }

  start(): void {
    startRuntimeConnectionSpan(this.#socket);
    this.#armTimeout(this.#options.authTimeoutMs, "RUNTIME_AUTH_TIMEOUT", "Authentication timed out");
    this.#socket.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
    this.#socket.on("close", (code) => void this.#onClose(code));
    this.#socket.on("error", () => undefined);
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    if (this.#isClosing()) return;
    if (isBinary) {
      this.#fail("PROTOCOL_ERROR", "Binary runtime frames are not supported", 4400);
      return;
    }
    const buffer = rawDataBuffer(data);
    if (buffer.byteLength > RUNTIME_MAX_FRAME_BYTES) {
      this.#fail("PROTOCOL_ERROR", "The runtime frame is too large", 4400);
      return;
    }
    const decoded = safeJson(buffer.toString("utf8"));
    const envelope = RuntimeFrameEnvelopeSchema.safeParse(decoded);
    if (!envelope.success) {
      this.#fail("PROTOCOL_ERROR", "The runtime frame is invalid", 4400);
      return;
    }

    if (this.#state === "await-auth") {
      if (this.#handshakeInFlight) {
        this.#fail("PROTOCOL_ERROR", "A runtime handshake request is already in progress", 4400);
        return;
      }
      if (envelope.data.type === "auth" && envelope.data.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
        this.#fail(
          "PROTOCOL_VERSION_UNSUPPORTED",
          "The runtime protocol version is unsupported",
          4400,
          envelope.data.requestId,
        );
        return;
      }
      const parsed = ClientRuntimeFrameSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.type !== "auth") {
        this.#fail("PROTOCOL_ERROR", "Authentication must be the first runtime frame", 4400, envelope.data.requestId);
        return;
      }
      this.#handshakeInFlight = true;
      void this.#authenticate(parsed.data).finally(() => {
        this.#handshakeInFlight = false;
      });
      return;
    }

    if (this.#state === "await-register") {
      if (this.#handshakeInFlight) {
        this.#fail("PROTOCOL_ERROR", "A runtime handshake request is already in progress", 4400);
        return;
      }
      const parsed = ClientRuntimeFrameSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.type !== "computer:register") {
        this.#fail("PROTOCOL_ERROR", "Computer registration must follow authentication", 4400, envelope.data.requestId);
        return;
      }
      this.#handshakeInFlight = true;
      void this.#register(parsed.data).finally(() => {
        this.#handshakeInFlight = false;
      });
      return;
    }

    if (this.#state !== "registered") return;
    if (envelope.data.type === "heartbeat") {
      const parsed = ClientRuntimeFrameSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.type !== "heartbeat") {
        this.#fail("PROTOCOL_ERROR", "The heartbeat frame is invalid", 4400, envelope.data.requestId);
        return;
      }
      if (this.#heartbeatInFlight) {
        this.#fail("PROTOCOL_ERROR", "A heartbeat is already in progress", 4400, parsed.data.requestId);
        return;
      }
      this.#heartbeatInFlight = true;
      void this.#heartbeat(
        parsed.data.requestId,
        parsed.data.computerId,
        parsed.data.instanceId,
        parsed.data.capabilities,
        parsed.data.providerReadiness,
      ).finally(() => {
        this.#heartbeatInFlight = false;
      });
      return;
    }
    if (CLIENT_CONTROL_FRAME_TYPES.has(envelope.data.type)) {
      this.#fail(
        "PROTOCOL_ERROR",
        "The runtime control frame is not allowed in the current state",
        4400,
        envelope.data.requestId,
      );
      return;
    }
    this.#scheduleBusinessFrame(decoded, envelope.data.requestId);
  }

  async #authenticate(frame: { accessToken: string; requestId: string }): Promise<void> {
    try {
      const authenticated = await this.#auth.getAuthenticatedUser(frame.accessToken);
      if (this.#isClosing()) return;
      this.#userId = authenticated.me.user.id;
      this.#state = "await-register";
      this.#armTimeout(this.#options.registerTimeoutMs, "RUNTIME_REGISTER_TIMEOUT", "Computer registration timed out");
      this.#send({
        type: "auth:result",
        requestId: frame.requestId,
        ok: true,
        userId: this.#userId,
        tokenExpiresAt: authenticated.tokenExpiresAt.toISOString(),
      });
      this.#send({
        type: "server:welcome",
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        capabilities: RUNTIME_V0_CAPABILITIES,
        heartbeatIntervalMs: this.#options.heartbeatIntervalMs,
        heartbeatTimeoutMs: this.#options.heartbeatTimeoutMs,
      });
      const untilExpiry = authenticated.tokenExpiresAt.getTime() - this.#options.now().getTime();
      this.#tokenTimer = setTimeout(
        () => this.#fail("AUTH_INVALID_TOKEN", "The access token expired", 4401),
        Math.max(1, untilExpiry),
      );
    } catch (error) {
      this.#handleRequestError(error, frame.requestId);
    }
  }

  async #register(frame: ComputerRegisterFrame): Promise<void> {
    if (!this.#userId) {
      this.#fail("PROTOCOL_ERROR", "Missing authenticated runtime user", 4400, frame.requestId);
      return;
    }
    try {
      const userId = this.#userId;
      await this.#registry.register(
        {
          capabilities: frame.capabilities,
          capabilitiesUpdatedAt: this.#options.now().getTime(),
          computerId: frame.computerId,
          instanceId: frame.instanceId,
          lastHeartbeatAt: this.#options.now().getTime(),
          providerReadiness: frame.providerReadiness,
          providerReadinessObservedAt: frame.providerReadiness ? this.#options.now().getTime() : undefined,
          socket: this.#socket,
          userId,
        },
        () => this.#computers.register(userId, frame),
      );
      if (this.#isClosing()) {
        if (this.#registry.remove(frame.computerId, frame.instanceId, this.#socket)) {
          await this.#computers.disconnect(frame.computerId, frame.instanceId).catch(() => undefined);
        }
        return;
      }
      this.#computerId = frame.computerId;
      this.#instanceId = frame.instanceId;
      setRuntimeConnectionAttrs(
        this.#socket,
        runtimeAttrs({ computerId: frame.computerId, instanceId: frame.instanceId }),
      );
      this.#state = "registered";
      this.#clearHandshakeTimer();
      this.#send({ type: "computer:register:result", requestId: frame.requestId, ok: true });
    } catch (error) {
      this.#handleRequestError(error, frame.requestId);
    }
  }

  async #heartbeat(
    requestId: string,
    computerId: string,
    instanceId: string,
    capabilities: RuntimeClientCapabilities,
    providerReadiness?: RuntimeProviderReadinessObservation,
  ): Promise<void> {
    try {
      if (!this.#userId || computerId !== this.#computerId || instanceId !== this.#instanceId) {
        this.#fail("COMPUTER_NOT_REGISTERED", "The Computer instance is not registered", 4409, requestId);
        return;
      }
      if (
        !this.#registry.touch(
          computerId,
          instanceId,
          this.#socket,
          this.#options.now().getTime(),
          capabilities,
          providerReadiness,
        )
      ) {
        this.#fail("COMPUTER_NOT_REGISTERED", "The Computer instance was replaced", 4409, requestId);
        return;
      }
      if (!(await this.#computers.heartbeat(this.#userId, computerId, instanceId))) {
        this.#fail("COMPUTER_NOT_REGISTERED", "The Computer instance was replaced", 4409, requestId);
        return;
      }
      if (this.#isClosing()) return;
      this.#send({ type: "heartbeat:result", requestId, ok: true, serverTime: this.#options.now().toISOString() });
    } catch (error) {
      this.#handleRequestError(error, requestId);
    }
  }

  #scheduleBusinessFrame(decoded: unknown, requestId?: string): void {
    const business = this.#options.business;
    const scheduler = this.#businessScheduler;
    if (!business || !scheduler || !this.#userId || !this.#computerId || !this.#instanceId) {
      this.#fail("PROTOCOL_ERROR", "The runtime business frame type is unknown", 4400, requestId);
      return;
    }
    let frame: RuntimeServerBusinessFrame | undefined;
    let key: string | undefined;
    try {
      frame = business.parse(decoded);
      if (frame) key = business.laneKey(frame);
    } catch {
      frame = undefined;
    }
    if (!frame || !key) {
      this.#fail("PROTOCOL_ERROR", "The runtime business frame is invalid", 4400, requestId);
      return;
    }
    const context: RuntimeBusinessContext = {
      computerId: this.#computerId,
      instanceId: this.#instanceId,
      signal: this.#abort.signal,
      userId: this.#userId,
    };
    const frameTrace = startRuntimeFrameSpan(this.#socket, frame.type, runtimeBusinessFrameAttrs(frame, context));
    const accepted = scheduler.enqueue(
      key,
      async () => {
        let outcome = "failed";
        let errorCode: string | undefined = "RUNTIME_FRAME_FAILED";
        try {
          if (!this.#canSendBusiness(context)) {
            outcome = "stale_connection";
            errorCode = "RUNTIME_CONNECTION_STALE";
            return;
          }
          const result = await runInRuntimeFrameSpan(frameTrace, () => business.handle(frame, context));
          if (!this.#canSendBusiness(context)) {
            outcome = "stale_connection";
            errorCode = "RUNTIME_CONNECTION_STALE";
            return;
          }
          this.#sendBusinessResult(result);
          outcome = "handled";
          errorCode = undefined;
        } catch {
          if (this.#canSendBusiness(context)) this.#sendBusinessResult(business.failureResult(frame));
        } finally {
          endRuntimeFrameSpan(frameTrace, outcome, errorCode);
        }
      },
      () => endRuntimeFrameSpan(frameTrace, "stale_connection", "RUNTIME_CONNECTION_STALE"),
    );
    if (!accepted) {
      endRuntimeFrameSpan(frameTrace, "overloaded", "RUNTIME_SCHEDULER_OVERLOADED");
      this.#sendBusinessResult(business.overloadResult(frame));
    }
  }

  #canSendBusiness(context: RuntimeBusinessContext): boolean {
    return (
      !context.signal.aborted &&
      this.#state === "registered" &&
      this.#registry.isCurrent(context.computerId, context.instanceId, this.#socket)
    );
  }

  #sendBusinessResult(result: unknown): void {
    if (result === undefined) return;
    if (Array.isArray(result)) {
      for (const frame of result) this.#send(frame);
      return;
    }
    this.#send(result);
  }

  async #onClose(code?: number): Promise<void> {
    if (this.#state === "closed") return;
    endRuntimeConnectionSpan(this.#socket, code);
    this.#state = "closed";
    this.#abort.abort();
    this.#businessScheduler?.close();
    this.#clearHandshakeTimer();
    if (this.#tokenTimer) clearTimeout(this.#tokenTimer);
    if (
      this.#computerId &&
      this.#instanceId &&
      this.#registry.remove(this.#computerId, this.#instanceId, this.#socket)
    ) {
      await this.#computers.disconnect(this.#computerId, this.#instanceId).catch(() => undefined);
    }
  }

  #send(frame: unknown): void {
    let serialized: string;
    try {
      serialized = JSON.stringify(frame);
    } catch {
      this.#fail("INTERNAL_ERROR", "The runtime response could not be serialized", 1011);
      return;
    }
    if (runtimeFrameByteLength(serialized) > RUNTIME_MAX_FRAME_BYTES) {
      this.#fail("INTERNAL_ERROR", "The runtime response is too large", 1011);
      return;
    }
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.send(serialized);
  }

  #handleRequestError(error: unknown, requestId?: string): void {
    if (error instanceof AuthServiceError) {
      const closeCode = error.statusCode === 409 ? 4409 : error.statusCode === 401 ? 4401 : 4403;
      this.#fail(error.code, error.message, closeCode, requestId);
      return;
    }
    this.#fail("INTERNAL_ERROR", "The runtime request could not be completed", 1011, requestId);
  }

  #fail(code: RuntimeErrorFrame["code"], message: string, closeCode: number, requestId?: string): void {
    if (this.#isClosing()) return;
    this.#state = "closing";
    this.#abort.abort();
    this.#businessScheduler?.close();
    this.#clearHandshakeTimer();
    if (this.#tokenTimer) clearTimeout(this.#tokenTimer);
    this.#send({ type: "error", code, message, ...(requestId ? { requestId } : {}) } satisfies ServerRuntimeFrame);
    endRuntimeConnectionSpan(this.#socket, closeCode);
    this.#socket.close(closeCode, message.slice(0, 120));
  }

  #armTimeout(milliseconds: number, code: RuntimeErrorFrame["code"], message: string): void {
    this.#clearHandshakeTimer();
    this.#timer = setTimeout(() => this.#fail(code, message, 4408), milliseconds);
  }

  #clearHandshakeTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #isClosing(): boolean {
    return this.#state === "closing" || this.#state === "closed";
  }
}

function runtimeBusinessFrameAttrs(
  frame: RuntimeServerBusinessFrame,
  runtime: RuntimeBusinessContext,
): Record<string, unknown> {
  return runtimeAttrs({
    frameType: frame.type,
    requestId: stringField(frame, "requestId"),
    deliveryId: stringField(frame, "deliveryId"),
    messageId: stringField(frame, "imMessageId"),
    sessionId: stringField(frame, "sessionId"),
    agentId: stringField(frame, "agentId"),
    computerId: runtime.computerId,
    instanceId: runtime.instanceId,
    placementGeneration: numberField(frame, "placementGeneration"),
  });
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: Readonly<Record<string, unknown>>, key: string): number | undefined {
  return typeof value[key] === "number" ? value[key] : undefined;
}

function positiveTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
