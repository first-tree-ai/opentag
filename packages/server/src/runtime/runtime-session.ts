import {
  ClientRuntimeFrameSchema,
  type ComputerRegisterFrame,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeErrorFrame,
  type ServerRuntimeFrame,
} from "@opentag/shared";
import type WebSocket from "ws";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";
import type { ComputerService } from "../services/computers/index.js";
import type { ConnectionRegistry } from "./connection-registry.js";

export interface RuntimeSessionOptions {
  authTimeoutMs?: number;
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
  readonly #options: Required<Omit<RuntimeSessionOptions, "now">> & { now: () => Date };
  #state: "await-auth" | "await-register" | "registered" | "closed" = "await-auth";
  #timer?: NodeJS.Timeout;
  #tokenTimer?: NodeJS.Timeout;
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
    this.#options = {
      authTimeoutMs: options.authTimeoutMs ?? 5_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 90_000,
      now: options.now ?? (() => new Date()),
      registerTimeoutMs: options.registerTimeoutMs ?? 5_000,
    };
  }

  start(): void {
    this.#send({
      type: "server:welcome",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      heartbeatIntervalMs: this.#options.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.#options.heartbeatTimeoutMs,
    });
    this.#armTimeout(this.#options.authTimeoutMs, "RUNTIME_AUTH_TIMEOUT", "Authentication timed out");
    this.#socket.on("message", (data) => void this.#onMessage(data.toString()));
    this.#socket.on("close", () => void this.#onClose());
    this.#socket.on("error", () => undefined);
  }

  async #onMessage(raw: string): Promise<void> {
    if (this.#state === "closed") return;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return this.#fail("PROTOCOL_ERROR", "The runtime frame is not valid JSON", 4400);
    }
    const parsed = ClientRuntimeFrameSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return this.#fail("PROTOCOL_ERROR", "The runtime frame is invalid", 4400);
    }
    const frame = parsed.data;
    try {
      if (this.#state === "await-auth" && frame.type === "auth") {
        const authenticated = await this.#auth.getAuthenticatedUser(frame.accessToken);
        this.#userId = authenticated.me.user.id;
        this.#send({
          type: "auth:result",
          requestId: frame.requestId,
          ok: true,
          userId: this.#userId,
          tokenExpiresAt: authenticated.tokenExpiresAt.toISOString(),
        });
        this.#state = "await-register";
        this.#armTimeout(
          this.#options.registerTimeoutMs,
          "RUNTIME_REGISTER_TIMEOUT",
          "Computer registration timed out",
        );
        const untilExpiry = authenticated.tokenExpiresAt.getTime() - this.#options.now().getTime();
        this.#tokenTimer = setTimeout(
          () => this.#fail("AUTH_INVALID_TOKEN", "The access token expired", 4401),
          Math.max(1, untilExpiry),
        );
        return;
      }
      if (this.#state === "await-register" && frame.type === "computer:register") {
        await this.#register(frame);
        return;
      }
      if (this.#state === "registered" && frame.type === "heartbeat") {
        await this.#heartbeat(frame.requestId, frame.computerId, frame.instanceId);
        return;
      }
      this.#fail(
        "PROTOCOL_ERROR",
        "The runtime frame is not allowed in the current state",
        4400,
        "requestId" in frame ? frame.requestId : undefined,
      );
    } catch (error) {
      if (error instanceof AuthServiceError) {
        const closeCode = error.statusCode === 409 ? 4409 : error.statusCode === 401 ? 4401 : 4403;
        this.#fail(error.code, error.message, closeCode, "requestId" in frame ? frame.requestId : undefined);
        return;
      }
      this.#fail(
        "INTERNAL_ERROR",
        "The runtime request could not be completed",
        1011,
        "requestId" in frame ? frame.requestId : undefined,
      );
    }
  }

  async #register(frame: ComputerRegisterFrame): Promise<void> {
    if (!this.#userId) throw new Error("Missing authenticated user");
    await this.#computers.register(this.#userId, frame);
    this.#computerId = frame.computerId;
    this.#instanceId = frame.instanceId;
    this.#registry.register({
      computerId: frame.computerId,
      instanceId: frame.instanceId,
      lastHeartbeatAt: this.#options.now().getTime(),
      socket: this.#socket,
      userId: this.#userId,
    });
    this.#state = "registered";
    this.#clearHandshakeTimer();
    this.#send({ type: "computer:register:result", requestId: frame.requestId, ok: true });
  }

  async #heartbeat(requestId: string, computerId: string, instanceId: string): Promise<void> {
    if (!this.#userId || computerId !== this.#computerId || instanceId !== this.#instanceId) {
      return this.#fail("COMPUTER_NOT_REGISTERED", "The Computer instance is not registered", 4409, requestId);
    }
    if (!this.#registry.touch(computerId, instanceId, this.#socket, this.#options.now().getTime())) {
      return this.#fail("COMPUTER_NOT_REGISTERED", "The Computer instance was replaced", 4409, requestId);
    }
    if (!(await this.#computers.heartbeat(this.#userId, computerId, instanceId))) {
      return this.#fail("COMPUTER_NOT_REGISTERED", "The Computer instance was replaced", 4409, requestId);
    }
    this.#send({ type: "heartbeat:result", requestId, ok: true, serverTime: this.#options.now().toISOString() });
  }

  async #onClose(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closed";
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

  #send(frame: ServerRuntimeFrame): void {
    if (this.#socket.readyState === this.#socket.OPEN) {
      this.#socket.send(JSON.stringify(frame));
    }
  }

  #fail(code: RuntimeErrorFrame["code"], message: string, closeCode: number, requestId?: string): void {
    this.#send({ type: "error", code, message, ...(requestId ? { requestId } : {}) });
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
}
