import { randomBytes } from "node:crypto";
import type { WebFetchResult, WebSearchResult } from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import { executeGatewayCall, type WebGatewayDispatch } from "../runtime/web-tools-gateway.js";
import {
  type NativeSandbox,
  NativeSandboxError,
  SANDBOX_NODE,
  SANDBOX_WEB_BRIDGE_DIRECTORY,
  type SandboxExecDuplex,
} from "./native-sandbox.js";
import { WEB_BRIDGE_BUDGET_PATTERN, WEB_BRIDGE_MAX_FRAME_BYTES, WEB_BRIDGE_SOURCE } from "./web-bridge.js";

/** Kernel-bound Unix socket path used by the in-Sandbox bridge; leave headroom below 104. */
const BRIDGE_SOCKET_PATH_MAX_BYTES = 90;
const DEFAULT_BRIDGE_STARTUP_TIMEOUT_MS = 10_000;
const BRIDGE_SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * Trusted execution authority for the native web gateway. The parent Runner supplies this only
 * for a live, Server-authorized execution with web scopes for this exact Sandbox. The
 * `executionIdentity` is a nonsecret per-execution value: every authority opens its own bridge
 * process and its own listener, so no successor execution can ever inherit an older endpoint or
 * an older authority field.
 *
 * Production Cloud turns build this from the `runtime:web:gateway` bearer the Server issued for the
 * exact execution; the bootstrap credential is never accepted as an authority. The E3 acceptance
 * harness may inject its own authority through `RunnerServeOptions.webAuthority`. A call with no
 * opened channel is refused as web_disabled.
 */
/**
 * The Sandbox surface a web channel needs: its name (fenced against the owning gateway) and the
 * verified duplex entry. Narrower than the full NativeSandbox so a test double can stand in without
 * a fake filesystem, while production still passes the real thing.
 */
export type NativeWebSandbox = Pick<NativeSandbox, "name" | "openDuplex">;

export interface NativeWebExecutionAuthority {
  /** Nonsecret identity of the exact execution; one channel binds exactly one value. */
  readonly executionIdentity: string;
  /** Revocation/close signal from the execution owner; aborts in-flight work and the channel. */
  readonly signal?: AbortSignal;
  dispatch(input: Parameters<WebGatewayDispatch>[0], signal: AbortSignal): Promise<WebSearchResult | WebFetchResult>;
}

export interface NativeSandboxWebGatewayOptions {
  /** Exact Sandbox name this gateway belongs to. */
  readonly sandboxName: string;
  readonly logger?: Pick<ClientLogger, "debug" | "warn">;
}

/** One live execution channel: a dedicated bridge process and its own in-Sandbox listener. */
export class NativeWebExecutionChannel {
  readonly #authority: NativeWebExecutionAuthority;
  readonly #duplex: SandboxExecDuplex;
  readonly #logger: Pick<ClientLogger, "debug" | "warn">;
  readonly #now: () => number;
  readonly #inflight = new Map<number, AbortController>();
  readonly #decoder = new FrameDecoder();
  #closed = false;
  #terminated = false;
  #closeNotified = false;
  #closePromise?: Promise<void>;
  #readySettled = false;
  #readyResolve: () => void = () => undefined;
  #readyReject: (error: unknown) => void = () => undefined;
  readonly #readyPromise: Promise<void>;
  readonly #closedPromise: Promise<void>;
  readonly #onClosed?: () => void;
  #closedResolve: () => void = () => undefined;

  /** Nonsecret descriptor for Pi's `OPENTAG_WEB_TOOLS_SOCKET` inside the Sandbox. */
  readonly socketPath: string;

  private constructor(
    socketPath: string,
    duplex: SandboxExecDuplex,
    authority: NativeWebExecutionAuthority,
    logger: Pick<ClientLogger, "debug" | "warn">,
    now: () => number,
    onClosed?: () => void,
  ) {
    this.socketPath = socketPath;
    this.#duplex = duplex;
    this.#authority = authority;
    this.#logger = logger;
    this.#now = now;
    this.#onClosed = onClosed;
    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#closedPromise = new Promise<void>((resolve) => {
      this.#closedResolve = resolve;
    });
    this.#duplex.onData((chunk) => this.#onData(chunk));
    this.#duplex.onStderr((chunk) => {
      try {
        this.#logger.debug(
          { code: "native_web_bridge_stderr", bytes: chunk.byteLength },
          "Sandbox web bridge wrote to stderr",
        );
      } catch {
        // Diagnostics must never break the channel.
      }
    });
    this.#duplex.onError((error) => this.#fail(error));
    this.#duplex.onExit((code, signal) => {
      this.#fail(new NativeSandboxError("exec_failed", `Sandbox web bridge exited (${code ?? signal ?? "unknown"})`));
    });
  }

  static async open(input: {
    sandbox: NativeWebSandbox;
    authority: NativeWebExecutionAuthority;
    logger?: Pick<ClientLogger, "debug" | "warn">;
    now?: () => number;
    startupTimeoutMs?: number;
    /** Synchronous exactly-once notification when the channel closes by any path. */
    onClosed?: () => void;
  }): Promise<NativeWebExecutionChannel> {
    if (!input.authority.executionIdentity)
      throw new NativeSandboxError("launch_failed", "A web execution authority needs a nonempty identity");
    if (input.authority.signal?.aborted) {
      throw new NativeSandboxError("exec_failed", "The web execution authority is already revoked");
    }
    const socketPath = `${SANDBOX_WEB_BRIDGE_DIRECTORY}/opentag-web-${randomBytes(8).toString("hex")}.sock`;
    if (Buffer.byteLength(socketPath) > BRIDGE_SOCKET_PATH_MAX_BYTES) {
      throw new NativeSandboxError("launch_failed", "The sandbox web bridge socket path exceeds the platform bound");
    }
    const duplex = input.sandbox.openDuplex(SANDBOX_NODE, ["-e", WEB_BRIDGE_SOURCE, socketPath]);
    const logger = input.logger ?? createLogger("native-web-gateway");
    const channel = new NativeWebExecutionChannel(
      socketPath,
      duplex,
      input.authority,
      logger,
      input.now ?? Date.now,
      input.onClosed,
    );
    try {
      await channel.#waitForReady(input.startupTimeoutMs ?? DEFAULT_BRIDGE_STARTUP_TIMEOUT_MS);
    } catch (error) {
      await channel.close();
      throw error;
    }
    input.authority.signal?.addEventListener("abort", () => void channel.close(), { once: true });
    if (input.authority.signal?.aborted) await channel.close();
    return channel;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Resolves once the channel is closed by any path (explicit close, exit, or revocation). */
  get whenClosed(): Promise<void> {
    return this.#closedPromise;
  }

  /**
   * Cancel in-flight work, stop the bridge, and let the bridge remove only its own listener.
   * Concurrent/repeated calls await the same in-progress close instead of falsely reporting
   * completion before the listener and bridge process are actually gone.
   */
  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#inflight.values()) controller.abort(new Error("web execution channel closed"));
    this.#inflight.clear();
    this.#failReadyIfPending(new NativeSandboxError("exec_failed", "The sandbox web bridge closed before ready"));
    if (this.#terminated) {
      this.#notifyClosed();
      this.#closedResolve();
      return;
    }
    this.#terminated = true;
    // EOF is the graceful path: the bridge unlinks its own socket and exits.
    this.#duplex.end();
    if (!(await this.#waitForExit(BRIDGE_SHUTDOWN_TIMEOUT_MS))) {
      this.#duplex.kill("SIGKILL");
      await this.#waitForExit(BRIDGE_SHUTDOWN_TIMEOUT_MS);
    }
    this.#notifyClosed();
    this.#closedResolve();
  }

  #onData(chunk: Buffer): void {
    if (this.#closed) return;
    let frames: unknown[];
    try {
      frames = this.#decoder.push(chunk);
    } catch {
      this.#duplex.kill("SIGKILL");
      this.#fail(new NativeSandboxError("exec_failed", "The sandbox web bridge sent an invalid frame"));
      return;
    }
    for (const frame of frames) this.#handleFrame(frame);
  }

  #handleFrame(frame: unknown): void {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
    const record = frame as Record<string, unknown>;
    if (record.t === "ready") {
      if (!this.#readySettled) {
        this.#readySettled = true;
        this.#readyResolve();
      }
      return;
    }
    if (record.t === "request") {
      void this.#handleRequest(record).catch(() => undefined);
      return;
    }
    if (record.t === "cancel" && Number.isSafeInteger(record.id)) {
      this.#inflight.get(record.id as number)?.abort(new Error("web request cancelled"));
    }
  }

  async #handleRequest(frame: Record<string, unknown>): Promise<void> {
    if (this.#closed) return;
    const id = frame.id;
    if (!Number.isSafeInteger(id)) return;
    const path = frame.path;
    const operation = path === "/web/search" ? "search" : path === "/web/fetch" ? "fetch" : undefined;
    if (operation === undefined) {
      this.#writeResponse(
        id as number,
        404,
        JSON.stringify({ error: { code: "invalid_request", message: "Unknown web gateway operation" } }),
      );
      return;
    }
    const rawBody = decodeBridgeBody(frame.body);
    if (!rawBody) {
      this.#writeResponse(
        id as number,
        400,
        JSON.stringify({ error: { code: "invalid_request", message: "The web gateway request is not valid base64" } }),
      );
      return;
    }
    // The bridge recomputes the remaining budget after the body read; the pipe hop must never
    // restart the full cap, so a missing/malformed remainder is rejected here.
    const remaining = frame.remaining;
    if (typeof remaining !== "string" || !WEB_BRIDGE_BUDGET_PATTERN.test(remaining) || Number(remaining) < 1) {
      this.#writeResponse(
        id as number,
        400,
        JSON.stringify({ error: { code: "invalid_request", message: "The web bridge request budget is invalid" } }),
      );
      return;
    }
    const controller = new AbortController();
    this.#inflight.set(id as number, controller);
    try {
      const outcome = await executeGatewayCall({
        operation,
        rawBody,
        remainingHeader: remaining,
        dispatch: (input, signal) => this.#authority.dispatch(input, signal),
        signal: controller.signal,
        now: this.#now,
        logger: this.#logger,
      });
      this.#writeResponse(id as number, outcome.status, outcome.body);
    } finally {
      this.#inflight.delete(id as number);
    }
  }

  #writeResponse(id: number, status: number, body: string): void {
    if (this.#closed) return;
    this.#duplex.write(encodeFrame({ t: "response", id, status, body }));
  }

  async #waitForReady(startupTimeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#readyPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new NativeSandboxError("exec_failed", "The sandbox web bridge did not become ready")),
            startupTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #failReadyIfPending(error: unknown): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#readyReject(error);
  }

  #fail(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.#failReadyIfPending(normalized);
    this.#duplex.kill("SIGKILL");
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#inflight.values()) controller.abort(normalized);
    this.#inflight.clear();
    this.#notifyClosed();
    this.#closedResolve();
  }

  #notifyClosed(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    try {
      this.#onClosed?.();
    } catch {
      // An owner notification must never break channel teardown.
    }
  }

  #exitPromise?: Promise<void>;

  #waitForExit(timeoutMs: number): Promise<boolean> {
    this.#exitPromise ??= new Promise<void>((resolve) => {
      this.#duplex.onExit(() => resolve());
      this.#duplex.onError(() => resolve());
    });
    return Promise.race([
      this.#exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  }
}

/** Strict length-prefixed frame decoder; any malformed size is a fatal channel condition. */
class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: unknown[] = [];
    for (;;) {
      if (this.#buffer.length < 4) break;
      const size = this.#buffer.readUInt32BE(0);
      if (size > WEB_BRIDGE_MAX_FRAME_BYTES) throw new Error("The sandbox web bridge frame exceeds the bound");
      if (this.#buffer.length < 4 + size) break;
      const payload = this.#buffer.subarray(4, 4 + size);
      this.#buffer = this.#buffer.subarray(4 + size);
      frames.push(JSON.parse(payload.toString("utf8")));
    }
    return frames;
  }
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeBridgeBody(raw: unknown): Buffer | undefined {
  if (typeof raw !== "string" || raw.length > WEB_BRIDGE_MAX_FRAME_BYTES) return undefined;
  const decoded = Buffer.from(raw, "base64");
  // Buffer.from is lenient; a canonical round-trip proves the frame really carried base64.
  if (decoded.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) return undefined;
  return decoded;
}

/**
 * Native Sandbox parent boundary for web tools. There is no parent-side or network listener:
 * one verified `sandbox exec` duplex pipe per exact execution carries strict bounded frames to a
 * listener inside the Sandbox namespace. Because every execution opens its own bridge process
 * and socket descriptor, an old process can never reach a successor execution, and revocation
 * cancels in-flight dispatches and lets the bridge remove only its own listener.
 */
export class NativeSandboxWebGateway {
  readonly #sandboxName: string;
  readonly #logger: Pick<ClientLogger, "debug" | "warn">;
  readonly #now: () => number;
  #active?: NativeWebExecutionChannel;
  #opening = false;
  #closePromise?: Promise<void>;
  #closed = false;

  private constructor(options: NativeSandboxWebGatewayOptions, now: () => number) {
    this.#sandboxName = options.sandboxName;
    this.#logger = options.logger ?? createLogger("native-web-gateway");
    this.#now = now;
  }

  get sandboxName(): string {
    return this.#sandboxName;
  }

  /** No listener is created at start; production stays fail-closed until an execution opens one. */
  static async start(
    options: NativeSandboxWebGatewayOptions & { readonly now?: () => number },
  ): Promise<NativeSandboxWebGateway> {
    return new NativeSandboxWebGateway(options, options.now ?? Date.now);
  }

  /**
   * Open the dedicated channel for one exact execution: a fresh bridge process and a fresh
   * nonsecret socket descriptor inside the Sandbox. One gateway holds at most one channel, so
   * replacing an authority requires closing the predecessor first; there is no retarget path.
   * A close/revoke fully releases the slot (synchronously, before `close()` resolves) so the same
   * long-lived gateway can serve a successor execution; a second overlapping open or an
   * already-revoked authority fails before any bridge process is spawned.
   */
  async openExecution(input: {
    sandbox: NativeWebSandbox;
    authority: NativeWebExecutionAuthority;
    startupTimeoutMs?: number;
  }): Promise<NativeWebExecutionChannel> {
    if (this.#closed) throw new NativeSandboxError("exec_failed", "The native web gateway is closed");
    if (this.#active || this.#opening) {
      throw new NativeSandboxError(
        "exec_failed",
        "The native web gateway already has an active execution channel; close it before opening a successor",
      );
    }
    if (input.sandbox.name !== this.#sandboxName) {
      throw new NativeSandboxError("exec_failed", "The web execution channel must target this Sandbox");
    }
    if (input.authority.signal?.aborted) {
      throw new NativeSandboxError("exec_failed", "The web execution authority is already revoked");
    }
    this.#opening = true;
    let channel: NativeWebExecutionChannel | undefined;
    try {
      channel = await NativeWebExecutionChannel.open({
        sandbox: input.sandbox,
        authority: input.authority,
        logger: this.#logger,
        now: this.#now,
        onClosed: () => {
          if (this.#active === channel) this.#active = undefined;
        },
        ...(input.startupTimeoutMs !== undefined ? { startupTimeoutMs: input.startupTimeoutMs } : {}),
      });
      this.#active = channel;
      return channel;
    } finally {
      this.#opening = false;
    }
  }

  /** Close the active execution channel (when any) and refuse all future openings. Idempotent. */
  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    const active = this.#active;
    this.#active = undefined;
    await active?.close().catch(() => undefined);
  }
}
