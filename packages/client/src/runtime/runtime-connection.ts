import { randomUUID } from "node:crypto";
import {
  RUNTIME_PROTOCOL_VERSION,
  runtimeWebSocketUrl,
  ServerRuntimeFrameSchema,
  type ServerWelcomeFrame,
} from "@opentag/shared";
import WebSocket from "ws";
import { OpenTagApiError } from "../api.js";
import type { AccessTokenProvider } from "../auth/token-provider.js";
import type { ComputerIdentity } from "./computer-identity.js";

export class RuntimeConnectionError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = "RuntimeConnectionError";
  }
}

export interface RuntimeConnectionOptions {
  arch: string;
  clientVersion: string;
  computer: ComputerIdentity;
  displayName: string;
  jitter?: () => number;
  handshakeTimeoutMs?: number;
  instanceId: string;
  log?: (message: string) => void;
  platform: "darwin" | "linux" | "win32";
  tokenProvider: AccessTokenProvider;
  waitForRetry?: (milliseconds: number) => Promise<void>;
  webSocketFactory?: (url: string) => WebSocket;
}

export class RuntimeConnection {
  readonly #options: RuntimeConnectionOptions;
  #active?: WebSocket;
  #stopped = false;
  #forceRefresh = false;
  #wakeBackoff?: () => void;

  constructor(options: RuntimeConnectionOptions) {
    this.#options = options;
  }

  async run(): Promise<void> {
    let attempt = 0;
    while (!this.#stopped) {
      try {
        await this.#connectOnce(() => {
          attempt = 0;
        });
      } catch (error) {
        if (this.#stopped) return;
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
        if (this.#options.waitForRetry) {
          await this.#options.waitForRetry(delay);
        } else {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            this.#wakeBackoff = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        this.#wakeBackoff = undefined;
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#wakeBackoff?.();
    if (this.#active?.readyState === WebSocket.CONNECTING) this.#active.terminate();
    else this.#active?.close(1000, "Daemon shutting down");
  }

  async #connectOnce(onRegistered: () => void): Promise<void> {
    const lease = await this.#options.tokenProvider.getAccessTokenLease(this.#forceRefresh);
    this.#forceRefresh = false;
    if (this.#stopped) return;
    const socket =
      this.#options.webSocketFactory?.(runtimeWebSocketUrl(this.#options.computer.serverUrl)) ??
      new WebSocket(runtimeWebSocketUrl(this.#options.computer.serverUrl), { maxPayload: 64 * 1024 });
    this.#active = socket;
    const instanceId = this.#options.instanceId;

    await new Promise<void>((resolve, reject) => {
      let state: "welcome" | "auth" | "register" | "registered" = "welcome";
      let welcome: ServerWelcomeFrame | undefined;
      let heartbeatTimer: NodeJS.Timeout | undefined;
      let handshakeTimer: NodeJS.Timeout | undefined;
      let silenceTimer: NodeJS.Timeout | undefined;
      let tokenTimer: NodeJS.Timeout | undefined;
      let serverTokenExpiresAt: string | undefined;
      let settled = false;
      let established = false;
      let pendingHeartbeatRequestId: string | undefined;

      const clearTimers = () => {
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        if (handshakeTimer) clearTimeout(handshakeTimer);
        if (silenceTimer) clearTimeout(silenceTimer);
        if (tokenTimer) clearTimeout(tokenTimer);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (this.#active === socket) this.#active = undefined;
        error ? reject(error) : resolve();
      };
      const armSilence = () => {
        if (!welcome) return;
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => socket.terminate(), welcome.heartbeatTimeoutMs);
      };
      const send = (frame: unknown) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
      };
      const scheduleHeartbeat = () => {
        if (!welcome || settled || pendingHeartbeatRequestId) return;
        heartbeatTimer = setTimeout(() => {
          pendingHeartbeatRequestId = randomUUID();
          send({
            type: "heartbeat",
            requestId: pendingHeartbeatRequestId,
            computerId: this.#options.computer.computerId,
            instanceId,
          });
        }, welcome.heartbeatIntervalMs);
      };

      handshakeTimer = setTimeout(() => {
        socket.terminate();
        finish(new RuntimeConnectionError("The runtime handshake timed out", false));
      }, this.#options.handshakeTimeoutMs ?? 10_000);

      socket.on("message", (data) => {
        const parsed = ServerRuntimeFrameSchema.safeParse(safeJson(data.toString()));
        if (!parsed.success) {
          socket.close(4400, "Invalid server frame");
          finish(new RuntimeConnectionError("The server sent an invalid runtime frame", true));
          return;
        }
        const frame = parsed.data;
        armSilence();
        if (state === "welcome" && frame.type === "server:welcome") {
          if (frame.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
            finish(new RuntimeConnectionError("The runtime protocol version is unsupported", true));
            socket.close(4400, "Protocol mismatch");
            return;
          }
          welcome = frame;
          state = "auth";
          send({ type: "auth", requestId: randomUUID(), accessToken: lease.accessToken });
          return;
        }
        if (state === "auth" && frame.type === "auth:result" && frame.ok) {
          serverTokenExpiresAt = frame.tokenExpiresAt;
          state = "register";
          send({
            type: "computer:register",
            requestId: randomUUID(),
            computerId: this.#options.computer.computerId,
            instanceId,
            displayName: this.#options.displayName,
            platform: this.#options.platform,
            arch: this.#options.arch,
            clientVersion: this.#options.clientVersion,
          });
          return;
        }
        if (state === "register" && frame.type === "computer:register:result" && frame.ok && welcome) {
          state = "registered";
          established = true;
          onRegistered();
          if (handshakeTimer) clearTimeout(handshakeTimer);
          this.#options.log?.(`Computer ${this.#options.computer.computerId} connected`);
          scheduleHeartbeat();
          const remaining = Date.parse(serverTokenExpiresAt ?? lease.expiresAt) - Date.now();
          tokenTimer = setTimeout(
            () => {
              this.#forceRefresh = true;
              socket.close(4000, "Refreshing access token");
            },
            Math.max(1, Math.floor(remaining * 0.8)),
          );
          return;
        }
        if (state === "registered" && frame.type === "heartbeat:result" && frame.ok) {
          if (frame.requestId !== pendingHeartbeatRequestId) {
            finish(new RuntimeConnectionError("The server returned an unmatched heartbeat result", true));
            socket.close(4400, "Heartbeat request mismatch");
            return;
          }
          pendingHeartbeatRequestId = undefined;
          scheduleHeartbeat();
          return;
        }
        if (frame.type === "error") {
          if (state === "registered" && frame.code === "AUTH_INVALID_TOKEN") {
            this.#forceRefresh = true;
            finish();
            socket.close(4000, "Refreshing access token");
            return;
          }
          const fatal = frame.code !== "INTERNAL_ERROR" && frame.code !== "SERVICE_UNAVAILABLE";
          finish(new RuntimeConnectionError(frame.message, fatal));
          socket.close(fatal ? 4403 : 1011, frame.message.slice(0, 120));
          return;
        }
        finish(new RuntimeConnectionError("The server runtime frame arrived out of order", true));
        socket.close(4400, "Frame out of order");
      });
      socket.on("close", (code) => {
        if (this.#stopped) return finish();
        if (code === 4000) return finish();
        if (code === 4001 || (code >= 4400 && code < 4500)) {
          return finish(new RuntimeConnectionError("The runtime connection was rejected", true));
        }
        finish(
          new RuntimeConnectionError(
            established ? "The runtime connection closed" : "Could not establish runtime connection",
            false,
          ),
        );
      });
      socket.on("error", () => undefined);
      socket.on("open", () => armSilence());
    });
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
