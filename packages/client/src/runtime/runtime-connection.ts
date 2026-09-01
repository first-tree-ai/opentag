import { randomUUID } from "node:crypto";
import {
  type AgentRuntimeProvider,
  IM_CLI_PROVIDERS,
  missingRuntimeCapabilities,
  negotiateRuntimeCapabilities,
  PROVIDER_READINESS_V1_HEADER,
  RUNTIME_CLIENT_CAPABILITY_OFFERS,
  RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_V1,
  RUNTIME_PROTOCOL_V2,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_REQUIRED_SERVER_CAPABILITIES,
  RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
  type RuntimeChannelTarget,
  type RuntimeClientCapabilities,
  RuntimeFrameEnvelopeSchema,
  type RuntimeImCliReadinessCollection,
  type RuntimeImCliReadinessObservation,
  type RuntimeNegotiatedCapabilities,
  type RuntimeProtocolVersion,
  type RuntimeProviderReadinessCollection,
  type RuntimeProviderReadinessObservation,
  runtimeFrameByteLength,
  runtimeNegotiatedCapabilitiesEqual,
  runtimeWebSocketUrl,
  ServerRuntimeBusinessFrameSchema,
  ServerRuntimeFrameSchema,
  type ServerWelcomeFrame,
} from "@opentag/shared";
import WebSocket, { type ClientOptions } from "ws";
import { OpenTagApiError } from "../api.js";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import { RuntimeStorageError } from "../storage/durable-file.js";
import type { ComputerIdentity } from "./computer-identity.js";
import { notifyTarget, rawDataBuffer, safeJson } from "./runtime-connection-helpers.js";

const SERVER_CONTROL_FRAME_TYPES = new Set([
  "server:welcome",
  "auth:result",
  "computer:register:result",
  "heartbeat:result",
  "error",
]);

const PRIORITIES = ["control", "result", "report", "trace"] as const;

export type RuntimeConnectionState =
  | "stopped"
  | "connecting"
  | "authenticating"
  | "welcoming"
  | "registering"
  | "registered";

export type RuntimeSendPriority = (typeof PRIORITIES)[number];
export type RuntimeBusinessFrame = Readonly<Record<string, unknown>> & { readonly type: string };

export interface RuntimeSendOptions {
  deadline?: number;
  priority?: RuntimeSendPriority;
  signal?: AbortSignal;
}

export interface RuntimeQueueLimits {
  control: number;
  result: number;
  report: number;
  trace: number;
}

export type RuntimeSendErrorCode = "aborted" | "deadline" | "frame_too_large" | "overflow" | "unavailable";

export class RuntimeConnectionError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = "RuntimeConnectionError";
  }
}

export class RuntimeSendError extends Error {
  constructor(
    readonly code: RuntimeSendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeSendError";
  }
}

class RuntimeProtocolFallbackError extends Error {
  constructor() {
    super("The Server explicitly requires runtime protocol v1");
    this.name = "RuntimeProtocolFallbackError";
  }
}

interface RuntimeScheduler {
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
}

export interface RuntimeConnectionOptions {
  arch: string;
  backpressureDeadlineMs?: number;
  clientVersion: string;
  computer: ComputerIdentity;
  displayName: string;
  handshakeTimeoutMs?: number;
  instanceId: string;
  jitter?: () => number;
  logger?: ClientLogger;
  machineToken: string;
  now?: () => number;
  onChannelTarget?: (target: RuntimeChannelTarget) => void;
  parseBusinessFrame?: (value: unknown) => RuntimeBusinessFrame | undefined;
  platform: "darwin" | "linux" | "win32";
  queueLimits?: Partial<RuntimeQueueLimits>;
  scheduler?: RuntimeScheduler;
  waitForRetry?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  webSocketFactory?: (url: string, options: ClientOptions) => WebSocket;
}

interface RegisteredWaiter {
  cleanup(): void;
  reject(error: Error): void;
  resolve(): void;
}

interface QueuedFrame {
  deadline: number;
  priority: RuntimeSendPriority;
  reject(error: Error): void;
  resolve(): void;
  serialized: string;
  settled: boolean;
  signal?: AbortSignal;
  socket: WebSocket;
  timeout?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

const defaultScheduler: RuntimeScheduler = {
  clearTimeout: (timer) => clearTimeout(timer),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
};

const defaultQueueLimits: RuntimeQueueLimits = {
  control: 32,
  result: 128,
  report: 128,
  trace: 256,
};

export class RuntimeConnection {
  readonly #options: RuntimeConnectionOptions;
  readonly #logger: ClientLogger;
  readonly #scheduler: RuntimeScheduler;
  readonly #now: () => number;
  readonly #queueLimits: RuntimeQueueLimits;
  readonly #queues = new Map<RuntimeSendPriority, QueuedFrame[]>(PRIORITIES.map((priority) => [priority, []]));
  readonly #stateListeners = new Set<(state: RuntimeConnectionState) => void>();
  readonly #businessListeners = new Set<(frame: RuntimeBusinessFrame) => void | Promise<void>>();
  readonly #registeredWaiters = new Set<RegisteredWaiter>();
  readonly #lifecycleAbort = new AbortController();
  #active?: WebSocket;
  #connectionId?: string;
  #hasRun = false;
  #running = false;
  #sendInFlight?: QueuedFrame;
  #state: RuntimeConnectionState = "stopped";
  #stopped = false;
  #protocolVersion: RuntimeProtocolVersion = RUNTIME_PROTOCOL_VERSION;
  #negotiatedCapabilities: RuntimeNegotiatedCapabilities = {};
  #verifiedCapabilities: RuntimeClientCapabilities = { imCredentialGrant: 0 };
  #verifiedCapabilitiesExpiresAt = 0;
  readonly #providerReadiness = new Map<
    AgentRuntimeProvider,
    { observation: RuntimeProviderReadinessObservation; expiresAt: number }
  >();
  readonly #providerReadinessLeases = new Map<
    AgentRuntimeProvider,
    { observation: RuntimeProviderReadinessObservation; token: symbol }
  >();
  readonly #imCliReadiness = new Map<
    RuntimeImCliReadinessObservation["provider"],
    { observation: RuntimeImCliReadinessObservation; expiresAt: number }
  >();

  constructor(options: RuntimeConnectionOptions) {
    this.#options = options;
    this.#logger = (options.logger ?? createLogger("connection")).child({
      installationId: options.computer.computerId,
      instanceId: options.instanceId,
    });
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#now = options.now ?? Date.now;
    this.#queueLimits = { ...defaultQueueLimits, ...options.queueLimits };
    for (const priority of PRIORITIES) {
      if (!Number.isSafeInteger(this.#queueLimits[priority]) || this.#queueLimits[priority] < 1) {
        throw new Error(`Runtime ${priority} queue limit must be a positive safe integer`);
      }
    }
  }

  get state(): RuntimeConnectionState {
    return this.#state;
  }

  get installationId(): string {
    return this.#options.computer.computerId;
  }

  get instanceId(): string {
    return this.#options.instanceId;
  }

  supportsCapability(capability: string): boolean {
    return this.#state === "registered" && this.#negotiatedCapabilities[capability] !== undefined;
  }

  capabilityVersion(capability: string): number | undefined {
    return this.#state === "registered" ? this.#negotiatedCapabilities[capability] : undefined;
  }

  setVerifiedCapabilities(
    capabilities: RuntimeClientCapabilities,
    validForMs = RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  ): void {
    if (!Number.isSafeInteger(validForMs) || validForMs < 1 || validForMs > RUNTIME_CLIENT_CAPABILITY_TTL_MS) {
      throw new RuntimeConnectionError("Runtime capability validity is invalid", true);
    }
    this.#verifiedCapabilities = { ...capabilities };
    this.#verifiedCapabilitiesExpiresAt = this.#now() + validForMs;
  }

  setProviderReadiness(
    observation: RuntimeProviderReadinessObservation,
    validForMs = RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  ): void {
    if (!Number.isSafeInteger(validForMs) || validForMs < 1 || validForMs > RUNTIME_CLIENT_CAPABILITY_TTL_MS) {
      throw new RuntimeConnectionError("Runtime provider readiness validity is invalid", true);
    }
    this.#providerReadiness.set(observation.provider, {
      observation: { ...observation },
      expiresAt: this.#now() + validForMs,
    });
  }

  leaseProviderReadiness(observation: RuntimeProviderReadinessObservation): () => void {
    this.setProviderReadiness(observation);
    const lease = { observation: { ...observation }, token: Symbol("provider-readiness-lease") };
    this.#providerReadinessLeases.set(observation.provider, lease);
    return () => {
      if (this.#providerReadinessLeases.get(observation.provider)?.token === lease.token) {
        this.#providerReadinessLeases.delete(observation.provider);
      }
    };
  }

  setImCliReadiness(
    observation: RuntimeImCliReadinessObservation,
    validForMs = RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  ): void {
    if (!Number.isSafeInteger(validForMs) || validForMs < 1 || validForMs > RUNTIME_CLIENT_CAPABILITY_TTL_MS) {
      throw new RuntimeConnectionError("IM CLI readiness validity is invalid", true);
    }
    this.#imCliReadiness.set(observation.provider, {
      observation: { ...observation },
      expiresAt: this.#now() + validForMs,
    });
  }

  #currentCapabilities(): RuntimeClientCapabilities {
    return this.#now() <= this.#verifiedCapabilitiesExpiresAt
      ? { ...this.#verifiedCapabilities }
      : { imCredentialGrant: 0 };
  }

  #currentImCliReadiness(): RuntimeImCliReadinessCollection {
    const now = this.#now();
    return IM_CLI_PROVIDERS.flatMap((provider) => {
      const current = this.#imCliReadiness.get(provider);
      return current && now <= current.expiresAt ? [{ ...current.observation }] : [];
    });
  }

  #currentProviderReadiness(providers: readonly AgentRuntimeProvider[]): RuntimeProviderReadinessCollection {
    const now = this.#now();
    return providers.flatMap((provider) => {
      const lease = this.#providerReadinessLeases.get(provider);
      if (lease) return [{ ...lease.observation }];
      const current = this.#providerReadiness.get(provider);
      return current && now <= current.expiresAt ? [{ ...current.observation }] : [];
    });
  }

  subscribeState(listener: (state: RuntimeConnectionState) => void): () => void {
    this.#stateListeners.add(listener);
    this.#notifyStateListener(listener, this.#state);
    return () => this.#stateListeners.delete(listener);
  }

  subscribeBusinessFrames(listener: (frame: RuntimeBusinessFrame) => void | Promise<void>): () => void {
    this.#businessListeners.add(listener);
    return () => this.#businessListeners.delete(listener);
  }

  whenRegistered(signal?: AbortSignal): Promise<void> {
    if (this.#state === "registered") return Promise.resolve();
    if (this.#stopped || (this.#hasRun && !this.#running)) {
      return Promise.reject(new RuntimeSendError("unavailable", "The runtime connection is stopped"));
    }
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      const cleanup = () => {
        this.#registeredWaiters.delete(waiter);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: RegisteredWaiter = {
        cleanup,
        reject: (error) => {
          cleanup();
          reject(error);
        },
        resolve: () => {
          cleanup();
          resolve();
        },
      };
      this.#registeredWaiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async run(): Promise<void> {
    if (this.#hasRun) throw new RuntimeConnectionError("RuntimeConnection can only be run once", true);
    this.#hasRun = true;
    this.#running = true;
    let attempt = 0;
    let terminalError: Error | undefined;
    try {
      while (!this.#stopped) {
        try {
          this.#setState("connecting");
          this.#logger.debug({ attempt: attempt + 1, state: "connecting" }, "Runtime connection attempt started");
          await this.#connectOnce(() => {
            attempt = 0;
          });
        } catch (error) {
          if (this.#stopped || isAbortError(error)) break;
          if (error instanceof RuntimeProtocolFallbackError && this.#protocolVersion === RUNTIME_PROTOCOL_V2) {
            this.#protocolVersion = RUNTIME_PROTOCOL_V1;
            this.#logger.info(
              { protocolVersion: RUNTIME_PROTOCOL_V1, state: this.#state },
              "Runtime protocol fallback selected",
            );
            continue;
          }
          if (error instanceof RuntimeConnectionError && error.fatal) {
            this.#logger.error(
              { attempt: attempt + 1, category: "protocol", state: this.#state },
              "Runtime connection was rejected",
            );
            throw error;
          }
          if (error instanceof OpenTagApiError && !["transient", "rate_limit"].includes(error.category)) {
            this.#logger.error(
              { attempt: attempt + 1, category: error.category, state: this.#state },
              "Runtime authentication failed",
            );
            throw new RuntimeConnectionError(`${error.message}; run computer connect again`, true);
          }
          if (error instanceof Error && error.message.includes("not logged in")) {
            this.#logger.error(
              { attempt: attempt + 1, category: "credential", state: this.#state },
              "Runtime authentication failed",
            );
            throw new RuntimeConnectionError(`${error.message}; run computer connect first`, true);
          }
          attempt += 1;
          const maximum = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
          const jitter = Math.min(1, Math.max(0, this.#options.jitter?.() ?? Math.random()));
          const delay = Math.floor(maximum * jitter);
          this.#logger.warn(
            { attempt, category: connectionErrorCategory(error), delayMs: delay, state: this.#state },
            "Runtime connection lost; retry scheduled",
          );
          try {
            await this.#waitForRetry(delay);
          } catch (retryError) {
            if (this.#stopped || isAbortError(retryError)) break;
            throw retryError;
          }
        }
      }
    } catch (error) {
      terminalError = error instanceof Error ? error : new Error("The runtime connection failed");
      throw terminalError;
    } finally {
      this.#running = false;
      this.#setState("stopped");
      this.#rejectRegisteredWaiters(
        terminalError ?? new RuntimeSendError("unavailable", "The runtime connection is stopped"),
      );
      this.#rejectAllSends(new RuntimeSendError("unavailable", "The runtime connection is stopped"));
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#lifecycleAbort.abort();
    this.#setState("stopped");
    this.#rejectRegisteredWaiters(new RuntimeSendError("unavailable", "The runtime connection is stopped"));
    this.#rejectAllSends(new RuntimeSendError("unavailable", "The runtime connection is stopped"));
    const socket = this.#active;
    if (!socket) return;
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Daemon shutting down");
  }

  send(frame: unknown, options: RuntimeSendOptions = {}): Promise<void> {
    const socket = this.#active;
    if (this.#state !== "registered" || !socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RuntimeSendError("unavailable", "The runtime connection is not registered"));
    }
    if (options.signal?.aborted) return Promise.reject(abortError());
    let serialized: string;
    try {
      serialized = JSON.stringify(this.#outboundFrame(frame));
    } catch (error) {
      if (error instanceof RuntimeSendError) return Promise.reject(error);
      return Promise.reject(new RuntimeSendError("frame_too_large", "The runtime frame cannot be serialized"));
    }
    if (runtimeFrameByteLength(serialized) > RUNTIME_MAX_FRAME_BYTES) {
      return Promise.reject(
        new RuntimeSendError("frame_too_large", `Runtime frames cannot exceed ${RUNTIME_MAX_FRAME_BYTES} bytes`),
      );
    }
    return this.#enqueue(socket, serialized, options);
  }

  async #connectOnce(onRegistered: () => void): Promise<void> {
    const signal = this.#lifecycleAbort.signal;
    signal.throwIfAborted();
    const socketOptions: ClientOptions = {
      headers: { [PROVIDER_READINESS_V1_HEADER]: "1" },
      maxPayload: RUNTIME_MAX_FRAME_BYTES,
    };
    const socketUrl = runtimeWebSocketUrl(this.#options.computer.serverUrl);
    const socket =
      this.#options.webSocketFactory?.(socketUrl, socketOptions) ?? new WebSocket(socketUrl, socketOptions);
    this.#active = socket;
    this.#connectionId = undefined;
    this.#negotiatedCapabilities = {};
    const instanceId = this.#options.instanceId;
    const protocolVersion = this.#protocolVersion;

    await new Promise<void>((resolve, reject) => {
      let welcome: ServerWelcomeFrame | undefined;
      let expectedNegotiatedCapabilities: RuntimeNegotiatedCapabilities | undefined;
      let authRequestId: string | undefined;
      let registerRequestId: string | undefined;
      let pendingHeartbeatRequestId: string | undefined;
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatResultTimer: ReturnType<typeof setTimeout> | undefined;
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      let silenceTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let established = false;

      const clearTimers = () => {
        for (const timer of [heartbeatTimer, heartbeatResultTimer, handshakeTimer, silenceTimer]) {
          if (timer) this.#scheduler.clearTimeout(timer);
        }
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        this.#rejectSocketSends(socket, new RuntimeSendError("unavailable", "The runtime socket closed"));
        if (this.#active === socket) this.#active = undefined;
        this.#connectionId = undefined;
        error ? reject(error) : resolve();
      };
      const failProtocol = (message: string, closeReason: string, fatal = true) => {
        socket.close(4400, closeReason);
        finish(new RuntimeConnectionError(message, fatal));
      };
      const armSilence = () => {
        if (!welcome) return;
        if (silenceTimer) this.#scheduler.clearTimeout(silenceTimer);
        silenceTimer = this.#scheduler.setTimeout(() => socket.terminate(), welcome.heartbeatTimeoutMs);
      };
      const scheduleHeartbeat = () => {
        if (!welcome || settled || pendingHeartbeatRequestId) return;
        const heartbeatPolicy = welcome;
        heartbeatTimer = this.#scheduler.setTimeout(() => {
          if (settled || this.#state !== "registered" || this.#active !== socket) return;
          const requestId = randomUUID();
          pendingHeartbeatRequestId = requestId;
          void this.send(
            {
              type: "heartbeat",
              requestId,
              installationId: this.#options.computer.computerId,
              instanceId,
              capabilities: this.#currentCapabilities(),
              ...(protocolVersion === RUNTIME_PROTOCOL_V2 ? { protocolVersion: RUNTIME_PROTOCOL_V2 } : {}),
              ...(heartbeatPolicy.providerReadiness
                ? {
                    providerReadiness: this.#currentProviderReadiness(heartbeatPolicy.providerReadiness.providers),
                  }
                : {}),
              imCliReadiness: this.#currentImCliReadiness(),
            },
            { priority: "control", deadline: this.#now() + heartbeatPolicy.heartbeatTimeoutMs },
          ).then(
            () => {
              if (settled || pendingHeartbeatRequestId !== requestId) return;
              heartbeatResultTimer = this.#scheduler.setTimeout(
                () => socket.terminate(),
                heartbeatPolicy.heartbeatTimeoutMs,
              );
            },
            () => socket.terminate(),
          );
        }, heartbeatPolicy.heartbeatIntervalMs);
      };

      handshakeTimer = this.#scheduler.setTimeout(() => {
        socket.terminate();
        finish(new RuntimeConnectionError("The runtime handshake timed out", false));
      }, this.#options.handshakeTimeoutMs ?? 10_000);

      socket.on("open", () => {
        if (settled || this.#stopped || this.#active !== socket) return;
        this.#setState("authenticating");
        authRequestId = randomUUID();
        void this.#sendDirect(
          socket,
          protocolVersion === RUNTIME_PROTOCOL_V2
            ? {
                type: "auth",
                requestId: authRequestId,
                protocolVersion: RUNTIME_PROTOCOL_V2,
                supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
                machineToken: this.#options.machineToken,
              }
            : {
                type: "auth",
                requestId: authRequestId,
                protocolVersion: RUNTIME_PROTOCOL_V1,
                machineToken: this.#options.machineToken,
              },
        ).catch((error: unknown) => finish(asError(error)));
      });

      socket.on("message", (data, isBinary) => {
        if (settled || this.#active !== socket) return;
        if (isBinary) {
          failProtocol("The server sent a binary runtime frame", "Binary frames are not supported");
          return;
        }
        const buffer = rawDataBuffer(data);
        if (buffer.byteLength > RUNTIME_MAX_FRAME_BYTES) {
          failProtocol("The server sent an oversized runtime frame", "Runtime frame is too large");
          return;
        }
        const decoded = safeJson(buffer.toString("utf8"));
        const envelope = RuntimeFrameEnvelopeSchema.safeParse(decoded);
        if (!envelope.success) {
          failProtocol("The server sent an invalid runtime frame", "Invalid server frame");
          return;
        }
        if (envelope.data.type === "server:welcome" && envelope.data.protocolVersion !== protocolVersion) {
          socket.close(4400, "Protocol version unsupported");
          finish(new RuntimeConnectionError("The runtime protocol version is unsupported", true));
          return;
        }

        const parsed = ServerRuntimeFrameSchema.safeParse(decoded);
        if (!parsed.success) {
          if (
            this.#state === "registered" &&
            !SERVER_CONTROL_FRAME_TYPES.has(envelope.data.type) &&
            (this.#options.parseBusinessFrame ?? parseServerBusinessFrame)
          ) {
            let businessFrame: RuntimeBusinessFrame | undefined;
            try {
              if (protocolVersion === RUNTIME_PROTOCOL_V2 && envelope.data.connectionId !== this.#connectionId) {
                failProtocol("The server sent a stale runtime connection fence", "Stale connection fence");
                return;
              }
              businessFrame = (this.#options.parseBusinessFrame ?? parseServerBusinessFrame)(
                protocolVersion === RUNTIME_PROTOCOL_V2 ? withoutConnectionId(decoded) : decoded,
              );
            } catch {
              businessFrame = undefined;
            }
            if (businessFrame) {
              armSilence();
              this.#dispatchBusinessFrame(businessFrame);
              return;
            }
          }
          failProtocol("The server sent an invalid runtime frame", "Invalid server frame");
          return;
        }

        const frame = parsed.data;
        armSilence();
        if (this.#state === "authenticating" && frame.type === "auth:result") {
          if (frame.requestId !== authRequestId) {
            failProtocol("The server returned an unmatched auth result", "Auth request mismatch");
            return;
          }
          if (!frame.ok) {
            socket.close(4403, "Authentication rejected");
            finish(new RuntimeConnectionError(`Runtime authentication failed: ${frame.errorCode}`, true));
            return;
          }
          this.#setState("welcoming");
          return;
        }
        if (this.#state === "welcoming" && frame.type === "server:welcome") {
          if (frame.protocolVersion !== protocolVersion) {
            failProtocol("The runtime protocol version is unsupported", "Protocol version unsupported");
            return;
          }
          if (frame.protocolVersion === RUNTIME_PROTOCOL_V2) {
            expectedNegotiatedCapabilities = negotiateRuntimeCapabilities(
              RUNTIME_CLIENT_CAPABILITY_OFFERS,
              frame.supportedCapabilities,
            );
            const missing = [
              ...missingRuntimeCapabilities(frame.requiredClientCapabilities, expectedNegotiatedCapabilities),
              ...missingRuntimeCapabilities(RUNTIME_REQUIRED_SERVER_CAPABILITIES, expectedNegotiatedCapabilities),
            ];
            if (missing.length > 0) {
              failProtocol(
                `Required runtime capabilities are unavailable: ${[...new Set(missing)].sort().join(", ")}`,
                "Required capability unavailable",
              );
              return;
            }
          }
          welcome = frame;
          this.#setState("registering");
          registerRequestId = randomUUID();
          const registration = {
            type: "computer:register",
            requestId: registerRequestId,
            installationId: this.#options.computer.computerId,
            instanceId,
            displayName: this.#options.displayName,
            platform: this.#options.platform,
            arch: this.#options.arch,
            clientVersion: this.#options.clientVersion,
            capabilities: this.#currentCapabilities(),
            ...(welcome.providerReadiness
              ? { providerReadiness: this.#currentProviderReadiness(welcome.providerReadiness.providers) }
              : {}),
            imCliReadiness: this.#currentImCliReadiness(),
          } as const;
          void this.#sendDirect(
            socket,
            protocolVersion === RUNTIME_PROTOCOL_V2
              ? {
                  ...registration,
                  protocolVersion: RUNTIME_PROTOCOL_V2,
                  supportedCapabilities: RUNTIME_CLIENT_CAPABILITY_OFFERS,
                  requiredServerCapabilities: RUNTIME_REQUIRED_SERVER_CAPABILITIES,
                }
              : registration,
          ).catch((error: unknown) => finish(asError(error)));
          return;
        }
        if (this.#state === "registering" && frame.type === "computer:register:result") {
          if (frame.requestId !== registerRequestId) {
            failProtocol("The server returned an unmatched registration result", "Registration request mismatch");
            return;
          }
          if (!frame.ok || !welcome) {
            socket.close(4403, "Computer registration rejected");
            finish(new RuntimeConnectionError(`Computer registration failed: ${frame.errorCode}`, true));
            return;
          }
          if (protocolVersion === RUNTIME_PROTOCOL_V2) {
            if (
              !("protocolVersion" in frame) ||
              frame.protocolVersion !== RUNTIME_PROTOCOL_V2 ||
              !frame.connectionId ||
              !frame.negotiatedCapabilities ||
              !expectedNegotiatedCapabilities ||
              !runtimeNegotiatedCapabilitiesEqual(frame.negotiatedCapabilities, expectedNegotiatedCapabilities)
            ) {
              failProtocol("The Server returned an invalid capability negotiation", "Capability mismatch");
              return;
            }
            this.#connectionId = frame.connectionId;
            this.#negotiatedCapabilities = { ...frame.negotiatedCapabilities };
          } else if ("protocolVersion" in frame) {
            failProtocol("The Server returned an invalid legacy registration", "Registration version mismatch");
            return;
          }
          established = true;
          if (handshakeTimer) this.#scheduler.clearTimeout(handshakeTimer);
          this.#setState("registered");
          this.#resolveRegisteredWaiters();
          onRegistered();
          this.#logger.info({ state: "registered" }, "Runtime connection registered");
          armSilence();
          scheduleHeartbeat();
          return;
        }
        if (this.#state === "registered" && frame.type === "heartbeat:result") {
          if (frame.requestId !== pendingHeartbeatRequestId) {
            failProtocol("The server returned an unmatched heartbeat result", "Heartbeat request mismatch");
            return;
          }
          if (
            (protocolVersion === RUNTIME_PROTOCOL_V2 &&
              (!("protocolVersion" in frame) ||
                frame.protocolVersion !== RUNTIME_PROTOCOL_V2 ||
                frame.connectionId !== this.#connectionId)) ||
            (protocolVersion === RUNTIME_PROTOCOL_V1 && "protocolVersion" in frame)
          ) {
            failProtocol("The Server returned a stale heartbeat fence", "Heartbeat fence mismatch");
            return;
          }
          if (!frame.ok) {
            socket.close(4403, "Heartbeat rejected");
            finish(new RuntimeConnectionError(`Runtime heartbeat failed: ${frame.errorCode}`, true));
            return;
          }
          pendingHeartbeatRequestId = undefined;
          if (heartbeatResultTimer) this.#scheduler.clearTimeout(heartbeatResultTimer);
          notifyTarget(
            protocolVersion,
            this.#negotiatedCapabilities,
            frame,
            this.#options.onChannelTarget,
            this.#logger,
          );
          scheduleHeartbeat();
          return;
        }
        if (frame.type === "error") {
          if (
            this.#state === "authenticating" &&
            protocolVersion === RUNTIME_PROTOCOL_V2 &&
            frame.code === "PROTOCOL_VERSION_UNSUPPORTED" &&
            frame.requestId === authRequestId
          ) {
            socket.close(4400, "Retrying runtime protocol v1");
            finish(new RuntimeProtocolFallbackError());
            return;
          }
          const fatal = frame.code !== "INTERNAL_ERROR" && frame.code !== "SERVICE_UNAVAILABLE";
          socket.close(fatal ? 4403 : 1011, frame.message.slice(0, 120));
          finish(new RuntimeConnectionError(frame.message, fatal));
          return;
        }
        failProtocol("The server runtime frame arrived out of order", "Frame out of order");
      });

      socket.on("close", (code) => {
        if (this.#stopped) {
          finish();
          return;
        }
        if (code === 4000) {
          finish();
          return;
        }
        if (code === 4001 || (code >= 4400 && code < 4500)) {
          finish(new RuntimeConnectionError("The runtime connection was rejected", true));
          return;
        }
        finish(
          new RuntimeConnectionError(
            established ? "The runtime connection closed" : "Could not establish runtime connection",
            false,
          ),
        );
      });
      socket.on("error", () => undefined);
    });
  }

  #enqueue(socket: WebSocket, serialized: string, options: RuntimeSendOptions): Promise<void> {
    const priority = options.priority ?? "result";
    const queue = this.#queues.get(priority);
    if (!queue) return Promise.reject(new RuntimeSendError("overflow", "The runtime send priority is invalid"));
    const inFlightCount = this.#sendInFlight?.priority === priority ? 1 : 0;
    if (queue.length + inFlightCount >= this.#queueLimits[priority]) {
      if (priority !== "trace") socket.terminate();
      return Promise.reject(new RuntimeSendError("overflow", `The runtime ${priority} queue is full`));
    }
    const deadline = options.deadline ?? this.#now() + (this.#options.backpressureDeadlineMs ?? 5_000);
    if (!Number.isFinite(deadline) || deadline <= this.#now()) {
      return Promise.reject(new RuntimeSendError("deadline", "The runtime send deadline has expired"));
    }

    return new Promise<void>((resolve, reject) => {
      const entry: QueuedFrame = {
        deadline,
        priority,
        reject,
        resolve,
        serialized,
        settled: false,
        signal: options.signal,
        socket,
      };
      const expire = () => {
        if (entry.settled) return;
        this.#removeQueuedEntry(entry);
        this.#settleEntry(entry, new RuntimeSendError("deadline", "The runtime send deadline expired"));
        if (priority !== "trace" && socket.readyState === WebSocket.OPEN) socket.terminate();
      };
      entry.timeout = this.#scheduler.setTimeout(expire, Math.max(1, deadline - this.#now()));
      if (entry.signal) {
        entry.onAbort = () => {
          if (entry.settled) return;
          this.#removeQueuedEntry(entry);
          this.#settleEntry(entry, abortError());
        };
        entry.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      queue.push(entry);
      this.#drain();
    });
  }

  #outboundFrame(frame: unknown): unknown {
    if (this.#protocolVersion !== RUNTIME_PROTOCOL_V2) return frame;
    if (!this.#connectionId || !frame || typeof frame !== "object" || Array.isArray(frame)) {
      throw new RuntimeSendError("unavailable", "The runtime connection fence is unavailable");
    }
    const record = frame as Readonly<Record<string, unknown>>;
    if (record.connectionId !== undefined && record.connectionId !== this.#connectionId) {
      throw new RuntimeSendError("unavailable", "The runtime frame carries a stale connection fence");
    }
    return { ...record, connectionId: this.#connectionId };
  }

  #drain(): void {
    if (this.#sendInFlight || this.#state !== "registered") return;
    const socket = this.#active;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    let entry: QueuedFrame | undefined;
    for (const priority of PRIORITIES) {
      const queue = this.#queues.get(priority);
      entry = queue?.shift();
      if (entry) break;
    }
    if (!entry) return;
    if (entry.socket !== socket) {
      this.#settleEntry(entry, new RuntimeSendError("unavailable", "The runtime socket was replaced"));
      this.#drain();
      return;
    }
    if (entry.deadline <= this.#now()) {
      this.#settleEntry(entry, new RuntimeSendError("deadline", "The runtime send deadline expired"));
      if (entry.priority !== "trace") socket.terminate();
      this.#drain();
      return;
    }
    this.#sendInFlight = entry;
    try {
      socket.send(entry.serialized, (error) => {
        if (this.#sendInFlight === entry) this.#sendInFlight = undefined;
        this.#settleEntry(
          entry,
          error ? new RuntimeSendError("unavailable", "The runtime frame could not be sent") : undefined,
        );
        this.#drain();
      });
    } catch {
      this.#sendInFlight = undefined;
      this.#settleEntry(entry, new RuntimeSendError("unavailable", "The runtime frame could not be sent"));
      socket.terminate();
      this.#drain();
    }
  }

  #settleEntry(entry: QueuedFrame, error?: Error): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timeout) this.#scheduler.clearTimeout(entry.timeout);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    error ? entry.reject(error) : entry.resolve();
  }

  #removeQueuedEntry(entry: QueuedFrame): void {
    const queue = this.#queues.get(entry.priority);
    const index = queue?.indexOf(entry) ?? -1;
    if (queue && index >= 0) queue.splice(index, 1);
  }

  #rejectSocketSends(socket: WebSocket, error: Error): void {
    if (this.#sendInFlight?.socket === socket) {
      const inFlight = this.#sendInFlight;
      this.#sendInFlight = undefined;
      this.#settleEntry(inFlight, error);
    }
    for (const queue of this.#queues.values()) {
      for (const entry of [...queue]) {
        if (entry.socket !== socket) continue;
        this.#removeQueuedEntry(entry);
        this.#settleEntry(entry, error);
      }
    }
  }

  #rejectAllSends(error: Error): void {
    if (this.#sendInFlight) {
      const inFlight = this.#sendInFlight;
      this.#sendInFlight = undefined;
      this.#settleEntry(inFlight, error);
    }
    for (const queue of this.#queues.values()) {
      for (const entry of queue.splice(0)) this.#settleEntry(entry, error);
    }
  }

  async #sendDirect(socket: WebSocket, frame: unknown): Promise<void> {
    const serialized = JSON.stringify(frame);
    if (runtimeFrameByteLength(serialized) > RUNTIME_MAX_FRAME_BYTES) {
      throw new RuntimeSendError("frame_too_large", "The runtime control frame is too large");
    }
    if (socket.readyState !== WebSocket.OPEN || this.#active !== socket) {
      throw new RuntimeSendError("unavailable", "The runtime socket is unavailable");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(serialized, (error) => {
        error ? reject(new RuntimeSendError("unavailable", "The runtime control frame could not be sent")) : resolve();
      });
    });
  }

  #dispatchBusinessFrame(frame: RuntimeBusinessFrame): void {
    for (const listener of this.#businessListeners) {
      Promise.resolve()
        .then(() => listener(frame))
        .catch((error: unknown) =>
          this.#logger.warn(
            { category: "listener", errorCategory: listenerFailureCategory(error), frameType: frame.type },
            "Runtime business frame listener failed",
          ),
        );
    }
  }

  #setState(state: RuntimeConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#logger.debug({ state }, "Runtime connection state changed");
    for (const listener of this.#stateListeners) this.#notifyStateListener(listener, state);
  }

  #notifyStateListener(listener: (state: RuntimeConnectionState) => void, state: RuntimeConnectionState): void {
    try {
      listener(state);
    } catch {
      this.#logger.warn({ category: "listener", state }, "Runtime connection state listener failed");
    }
  }

  #resolveRegisteredWaiters(): void {
    for (const waiter of [...this.#registeredWaiters]) waiter.resolve();
  }

  #rejectRegisteredWaiters(error: Error): void {
    for (const waiter of [...this.#registeredWaiters]) waiter.reject(error);
  }

  async #waitForRetry(milliseconds: number): Promise<void> {
    const signal = this.#lifecycleAbort.signal;
    if (this.#options.waitForRetry) {
      await raceWithAbort(this.#options.waitForRetry(milliseconds, signal), signal);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const timer = this.#scheduler.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        this.#scheduler.clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function listenerFailureCategory(error: unknown): string {
  if (error instanceof RuntimeStorageError) return `runtime_storage_${error.code}`;
  if (error instanceof RuntimeSendError) return `runtime_send_${error.code}`;
  if (error instanceof RuntimeConnectionError) return "runtime_connection";
  return error instanceof Error ? "error" : "non_error";
}

function connectionErrorCategory(error: unknown): string {
  if (error instanceof OpenTagApiError) return error.category;
  if (error instanceof RuntimeConnectionError) return error.fatal ? "protocol" : "transport";
  if (error instanceof RuntimeSendError) return error.code;
  return "unexpected";
}

function withoutConnectionId(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const frame = { ...(value as Record<string, unknown>) };
  delete frame.connectionId;
  return frame;
}

function parseServerBusinessFrame(value: unknown): RuntimeBusinessFrame | undefined {
  const parsed = ServerRuntimeBusinessFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function abortError(): RuntimeSendError {
  return new RuntimeSendError("aborted", "The runtime operation was aborted");
}

function isAbortError(error: unknown): boolean {
  return error instanceof RuntimeSendError && error.code === "aborted";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The runtime operation failed");
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
