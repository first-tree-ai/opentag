import { randomUUID } from "node:crypto";
import {
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeClientCapabilities,
  RuntimeFrameEnvelopeSchema,
  runtimeFrameByteLength,
  runtimeWebSocketUrl,
  ServerRuntimeBusinessFrameSchema,
  ServerRuntimeFrameSchema,
  type ServerWelcomeFrame,
} from "@opentag/shared";
import WebSocket, { type RawData } from "ws";
import { OpenTagApiError } from "../api.js";
import type { AccessTokenProvider } from "../auth/token-provider.js";
import type { ComputerIdentity } from "./computer-identity.js";

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
  log?: (message: string) => void;
  now?: () => number;
  parseBusinessFrame?: (value: unknown) => RuntimeBusinessFrame | undefined;
  platform: "darwin" | "linux" | "win32";
  queueLimits?: Partial<RuntimeQueueLimits>;
  scheduler?: RuntimeScheduler;
  tokenProvider: Pick<AccessTokenProvider, "getAccessTokenLease">;
  waitForRetry?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  webSocketFactory?: (url: string) => WebSocket;
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
  readonly #scheduler: RuntimeScheduler;
  readonly #now: () => number;
  readonly #queueLimits: RuntimeQueueLimits;
  readonly #queues = new Map<RuntimeSendPriority, QueuedFrame[]>(PRIORITIES.map((priority) => [priority, []]));
  readonly #stateListeners = new Set<(state: RuntimeConnectionState) => void>();
  readonly #businessListeners = new Set<(frame: RuntimeBusinessFrame) => void | Promise<void>>();
  readonly #registeredWaiters = new Set<RegisteredWaiter>();
  readonly #lifecycleAbort = new AbortController();
  #active?: WebSocket;
  #forceRefresh = false;
  #hasRun = false;
  #running = false;
  #sendInFlight?: QueuedFrame;
  #state: RuntimeConnectionState = "stopped";
  #stopped = false;
  #verifiedCapabilities: RuntimeClientCapabilities = { imMessageTool: 0 };

  constructor(options: RuntimeConnectionOptions) {
    this.#options = options;
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

  get computerId(): string {
    return this.#options.computer.computerId;
  }

  get instanceId(): string {
    return this.#options.instanceId;
  }

  setVerifiedCapabilities(capabilities: RuntimeClientCapabilities): void {
    if (this.#hasRun || this.#state !== "stopped") {
      throw new RuntimeConnectionError("Runtime capabilities must be verified before connecting", true);
    }
    this.#verifiedCapabilities = { ...capabilities };
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
          await this.#connectOnce(() => {
            attempt = 0;
          });
        } catch (error) {
          if (this.#stopped || isAbortError(error)) break;
          if (error instanceof RuntimeConnectionError && error.fatal) throw error;
          if (error instanceof OpenTagApiError && !["transient", "rate_limit"].includes(error.category)) {
            throw new RuntimeConnectionError(`${error.message}; run login again`, true);
          }
          if (error instanceof Error && error.message.includes("not logged in")) {
            throw new RuntimeConnectionError(`${error.message}; run login first`, true);
          }
          attempt += 1;
          const maximum = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
          const jitter = Math.min(1, Math.max(0, this.#options.jitter?.() ?? Math.random()));
          const delay = Math.floor(maximum * jitter);
          this.#options.log?.(`Runtime connection lost; retrying in ${delay}ms`);
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
    let serialized: string;
    try {
      serialized = JSON.stringify(frame);
    } catch {
      return Promise.reject(new RuntimeSendError("frame_too_large", "The runtime frame cannot be serialized"));
    }
    if (runtimeFrameByteLength(serialized) > RUNTIME_MAX_FRAME_BYTES) {
      return Promise.reject(
        new RuntimeSendError("frame_too_large", `Runtime frames cannot exceed ${RUNTIME_MAX_FRAME_BYTES} bytes`),
      );
    }
    const socket = this.#active;
    if (this.#state !== "registered" || !socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RuntimeSendError("unavailable", "The runtime connection is not registered"));
    }
    if (options.signal?.aborted) return Promise.reject(abortError());
    return this.#enqueue(socket, serialized, options);
  }

  async #connectOnce(onRegistered: () => void): Promise<void> {
    const signal = this.#lifecycleAbort.signal;
    const lease = await raceWithAbort(this.#options.tokenProvider.getAccessTokenLease(this.#forceRefresh), signal);
    this.#forceRefresh = false;
    signal.throwIfAborted();
    const socket =
      this.#options.webSocketFactory?.(runtimeWebSocketUrl(this.#options.computer.serverUrl)) ??
      new WebSocket(runtimeWebSocketUrl(this.#options.computer.serverUrl), { maxPayload: RUNTIME_MAX_FRAME_BYTES });
    this.#active = socket;
    const instanceId = this.#options.instanceId;

    await new Promise<void>((resolve, reject) => {
      let welcome: ServerWelcomeFrame | undefined;
      let authRequestId: string | undefined;
      let registerRequestId: string | undefined;
      let pendingHeartbeatRequestId: string | undefined;
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatResultTimer: ReturnType<typeof setTimeout> | undefined;
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      let silenceTimer: ReturnType<typeof setTimeout> | undefined;
      let tokenTimer: ReturnType<typeof setTimeout> | undefined;
      let serverTokenExpiresAt: string | undefined;
      let settled = false;
      let established = false;

      const clearTimers = () => {
        for (const timer of [heartbeatTimer, heartbeatResultTimer, handshakeTimer, silenceTimer, tokenTimer]) {
          if (timer) this.#scheduler.clearTimeout(timer);
        }
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        this.#rejectSocketSends(socket, new RuntimeSendError("unavailable", "The runtime socket closed"));
        if (this.#active === socket) this.#active = undefined;
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
              computerId: this.#options.computer.computerId,
              instanceId,
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
        void this.#sendDirect(socket, {
          type: "auth",
          requestId: authRequestId,
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          accessToken: lease.accessToken,
        }).catch((error: unknown) => finish(asError(error)));
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
        if (envelope.data.type === "server:welcome" && envelope.data.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
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
              businessFrame = (this.#options.parseBusinessFrame ?? parseServerBusinessFrame)(decoded);
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
          serverTokenExpiresAt = frame.tokenExpiresAt;
          this.#setState("welcoming");
          return;
        }
        if (this.#state === "welcoming" && frame.type === "server:welcome") {
          welcome = frame;
          this.#setState("registering");
          registerRequestId = randomUUID();
          void this.#sendDirect(socket, {
            type: "computer:register",
            requestId: registerRequestId,
            computerId: this.#options.computer.computerId,
            instanceId,
            displayName: this.#options.displayName,
            platform: this.#options.platform,
            arch: this.#options.arch,
            clientVersion: this.#options.clientVersion,
            capabilities: this.#verifiedCapabilities,
          }).catch((error: unknown) => finish(asError(error)));
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
          established = true;
          if (handshakeTimer) this.#scheduler.clearTimeout(handshakeTimer);
          this.#setState("registered");
          this.#resolveRegisteredWaiters();
          onRegistered();
          this.#options.log?.(`Computer ${this.#options.computer.computerId} connected`);
          armSilence();
          scheduleHeartbeat();
          const remaining = Date.parse(serverTokenExpiresAt ?? lease.expiresAt) - this.#now();
          tokenTimer = this.#scheduler.setTimeout(
            () => {
              this.#forceRefresh = true;
              socket.close(4000, "Refreshing access token");
            },
            Math.max(1, Math.floor(remaining * 0.8)),
          );
          return;
        }
        if (this.#state === "registered" && frame.type === "heartbeat:result") {
          if (frame.requestId !== pendingHeartbeatRequestId) {
            failProtocol("The server returned an unmatched heartbeat result", "Heartbeat request mismatch");
            return;
          }
          if (!frame.ok) {
            socket.close(4403, "Heartbeat rejected");
            finish(new RuntimeConnectionError(`Runtime heartbeat failed: ${frame.errorCode}`, true));
            return;
          }
          pendingHeartbeatRequestId = undefined;
          if (heartbeatResultTimer) this.#scheduler.clearTimeout(heartbeatResultTimer);
          scheduleHeartbeat();
          return;
        }
        if (frame.type === "error") {
          if (this.#state === "registered" && frame.code === "AUTH_INVALID_TOKEN") {
            this.#forceRefresh = true;
            socket.close(4000, "Refreshing access token");
            finish();
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
        .catch(() => this.#options.log?.("A runtime business frame listener failed"));
    }
  }

  #setState(state: RuntimeConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) this.#notifyStateListener(listener, state);
  }

  #notifyStateListener(listener: (state: RuntimeConnectionState) => void, state: RuntimeConnectionState): void {
    try {
      listener(state);
    } catch {
      this.#options.log?.("A runtime connection state listener failed");
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
