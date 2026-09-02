import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { type ClientLogger, createLogger } from "../../observability/logger.js";
import { signalWatchedProcess, spawnWatchedProcess } from "../process-owner.js";

export const CODEX_APP_SERVER_MAX_LINE_BYTES = 1024 * 1024;
export const CODEX_APP_SERVER_MAX_STDERR_BYTES = 64 * 1024;
export const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 60_000;

export class CodexAppServerError extends Error {
  readonly errno?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly killed?: boolean;

  constructor(
    readonly code: "aborted" | "exited" | "protocol" | "spawn" | "timeout" | "write",
    message: string,
    evidence: {
      readonly errno?: string;
      readonly exitCode?: number | null;
      readonly signal?: NodeJS.Signals | null;
      readonly killed?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "CodexAppServerError";
    if (evidence.errno !== undefined) this.errno = evidence.errno;
    if (evidence.exitCode !== undefined) this.exitCode = evidence.exitCode;
    if (evidence.signal !== undefined) this.signal = evidence.signal;
    if (evidence.killed !== undefined) this.killed = evidence.killed;
  }
}

export interface CodexAppServerMessage {
  [key: string]: unknown;
}

export interface CodexAppServerRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params: unknown;
}

export interface CodexSpawnOptions {
  args?: string[];
  command?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  expectedCodexHome?: string;
  maxLineBytes?: number;
  maxStderrBytes?: number;
  requestTimeoutMs?: number;
  logger?: ClientLogger;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: CodexProcessSpawnOptions,
  ) => ChildProcessWithoutNullStreams;
}

export interface CodexProcessSpawnOptions {
  cwd: string;
  detached: boolean;
  env: NodeJS.ProcessEnv;
}

export interface CodexAppServerClient {
  close(graceMs?: number): Promise<void>;
  initialize(clientVersion: string, signal?: AbortSignal): Promise<void>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  notify(method: string, params: unknown): Promise<void>;
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  setDynamicToolHandler?(handler: CodexDynamicToolHandler | undefined): void;
  subscribe(listener: (message: CodexAppServerMessage) => void): () => void;
}

export interface CodexDynamicToolCall {
  arguments: unknown;
  callId: string;
  namespace: string | null;
  threadId: string;
  tool: string;
  turnId: string;
}

export interface CodexDynamicToolResult {
  success: boolean;
  text: string;
}

export type CodexDynamicToolHandler = (call: CodexDynamicToolCall) => Promise<CodexDynamicToolResult>;

export interface InteractiveCodexAppServerClient extends CodexAppServerClient {
  rejectServerRequest(id: number | string, code: number, message: string): Promise<void>;
  respondServerRequest(id: number | string, result: unknown): Promise<void>;
  subscribeServerRequests(listener: (request: CodexAppServerRequest) => void): () => void;
}
interface PendingRequest {
  reject(error: Error): void;
  resolve(value: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

const defaultSpawn = (command: string, args: readonly string[], options: CodexProcessSpawnOptions) =>
  spawnWatchedProcess(command, args, options);

export class CodexAppServerProcess implements InteractiveCodexAppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #expectedCodexHome?: string;
  readonly #maxLineBytes: number;
  readonly #maxStderrBytes: number;
  readonly #requestTimeoutMs: number;
  readonly #logger: ClientLogger;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #listeners = new Set<(message: CodexAppServerMessage) => void>();
  readonly #serverRequestListeners = new Set<(request: CodexAppServerRequest) => void>();
  readonly #seenServerRequests = new Set<number | string>();
  readonly #pendingServerRequests = new Set<number | string>();
  readonly #respondingServerRequests = new Set<number | string>();
  readonly #duplicateServerRequests = new Set<number | string>();
  readonly #exit: Promise<void>;
  #resolveExit: (() => void) | undefined;
  #buffer = Buffer.alloc(0);
  #stderr = Buffer.alloc(0);
  #nextId = 1;
  #closed = false;
  #closing = false;
  #failure?: Error;
  #dynamicToolHandler?: CodexDynamicToolHandler;

  constructor(options: CodexSpawnOptions) {
    this.#expectedCodexHome = options.expectedCodexHome;
    this.#maxLineBytes = options.maxLineBytes ?? CODEX_APP_SERVER_MAX_LINE_BYTES;
    this.#maxStderrBytes = options.maxStderrBytes ?? CODEX_APP_SERVER_MAX_STDERR_BYTES;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? CODEX_APP_SERVER_REQUEST_TIMEOUT_MS;
    validateOptions(this.#maxLineBytes, this.#maxStderrBytes, this.#requestTimeoutMs);
    this.#logger = options.logger ?? createLogger("provider-codex");
    this.#exit = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    try {
      this.#child = (options.spawnProcess ?? defaultSpawn)(
        options.command ?? "codex",
        options.args ?? ["app-server", "--stdio"],
        { cwd: options.cwd, env: options.env, detached: process.platform !== "win32" },
      );
    } catch (error) {
      this.#logger.debug({ code: "spawn_failed", error: String(error) }, "Codex App Server process spawn failed");
      throw new CodexAppServerError(
        "spawn",
        error instanceof Error ? error.message : "Codex could not be started",
        spawnEvidence(error),
      );
    }
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => this.#onStderr(chunk));
    this.#child.on("error", (error) =>
      this.#fail(new CodexAppServerError("spawn", error.message, spawnEvidence(error))),
    );
    this.#child.on("exit", (exitCode, signal) => {
      this.#closed = true;
      this.#resolveExit?.();
      this.#resolveExit = undefined;
      if (!this.#failure && !this.#closing) {
        const error =
          this.#buffer.byteLength > 0
            ? new CodexAppServerError("protocol", this.#exitMessage("Codex exited with a truncated JSONL line"))
            : new CodexAppServerError("exited", this.#exitMessage(), { exitCode, signal });
        this.#fail(error);
      }
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  subscribe(listener: (message: CodexAppServerMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setDynamicToolHandler(handler: CodexDynamicToolHandler | undefined): void {
    this.#dynamicToolHandler = handler;
  }

  subscribeServerRequests(listener: (request: CodexAppServerRequest) => void): () => void {
    this.#serverRequestListeners.add(listener);
    return () => this.#serverRequestListeners.delete(listener);
  }

  async respondServerRequest(id: number | string, result: unknown): Promise<void> {
    await this.#writeServerResponse(id, { id, result });
  }

  async rejectServerRequest(id: number | string, code: number, message: string): Promise<void> {
    await this.#writeServerResponse(id, { id, error: { code, message } });
  }

  async initialize(clientVersion: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(
      "initialize",
      {
        clientInfo: { name: "opentag", title: "OpenTag", version: clientVersion },
        capabilities: { experimentalApi: true },
      },
      signal,
    );
    const initialized = requireRecord(response, "Codex returned an invalid initialize response");
    requireBoundedString(initialized.userAgent, "Codex initialize response has no user agent");
    requireBoundedString(initialized.platformFamily, "Codex initialize response has no platform family");
    requireBoundedString(initialized.platformOs, "Codex initialize response has no platform OS");
    const codexHome = requireBoundedString(initialized.codexHome, "Codex initialize response has no Home");
    if (this.#expectedCodexHome && codexHome !== this.#expectedCodexHome) {
      throw new CodexAppServerError("protocol", "Codex initialized with an unexpected Home");
    }
    await this.notify("initialized", {});
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed || this.#failure) {
      return Promise.reject(this.#failure ?? new CodexAppServerError("exited", "Codex App Server is closed"));
    }
    if (signal?.aborted) return Promise.reject(new CodexAppServerError("aborted", "Codex request was aborted"));
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        const pending = this.#pending.get(id);
        /* v8 ignore else -- cleanup only runs while its own pending entry is registered. */
        if (pending) clearTimeout(pending.timer);
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new CodexAppServerError("aborted", "Codex request was aborted"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new CodexAppServerError("timeout", `Codex request timed out: ${method}`));
      }, this.#requestTimeoutMs);
      timer.unref();
      this.#pending.set(id, {
        timer,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.#write({ id, method, params }).catch((error: unknown) => {
        const pending = this.#pending.get(id);
        pending?.reject(error as Error);
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.#write({ method, params });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId }, AbortSignal.timeout(2_000));
  }

  async close(graceMs = 1_000): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    this.#closed = true;
    const closingError = new CodexAppServerError("aborted", "Codex App Server is closing");
    for (const pending of [...this.#pending.values()]) pending.reject(closingError);
    this.#seenServerRequests.clear();
    this.#pendingServerRequests.clear();
    this.#respondingServerRequests.clear();
    this.#duplicateServerRequests.clear();
    this.#child.stdin.end();
    signalWatchedProcess(this.#child, "SIGTERM");
    if (await settlesWithin(this.#exit, graceMs)) return;
    signalWatchedProcess(this.#child, "SIGKILL");
    if (!(await settlesWithin(this.#exit, graceMs))) {
      throw new CodexAppServerError("exited", "Codex App Server process tree did not exit");
    }
  }

  async #write(message: unknown): Promise<void> {
    if (this.#closed || this.#failure || !this.#child.stdin.writable) {
      throw this.#failure ?? new CodexAppServerError("write", "Codex App Server stdin is unavailable");
    }
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
      throw new CodexAppServerError("protocol", "Codex request exceeds the JSONL line limit");
    }
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(line, (error) => {
        error ? reject(new CodexAppServerError("write", "Codex request could not be written")) : resolve();
      });
    });
  }

  async #writeServerResponse(id: number | string, message: unknown): Promise<void> {
    if (!this.#pendingServerRequests.has(id) || this.#respondingServerRequests.has(id)) {
      throw new CodexAppServerError("protocol", "Codex server request is unknown or already resolved");
    }
    this.#respondingServerRequests.add(id);
    try {
      await this.#write(message);
      this.#pendingServerRequests.delete(id);
    } finally {
      this.#respondingServerRequests.delete(id);
    }
  }

  #onStdout(chunk: Buffer): void {
    if (this.#failure || this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.byteLength > this.#maxLineBytes && !this.#buffer.includes(0x0a)) {
      this.#fail(new CodexAppServerError("protocol", "Codex emitted an oversized JSONL line"));
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      if (line.byteLength > this.#maxLineBytes) {
        this.#fail(new CodexAppServerError("protocol", "Codex emitted an oversized JSONL line"));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line.toString("utf8"));
      } catch {
        this.#logger.debug({ code: "stdout_malformed_json" }, "Codex protocol output was rejected");
        this.#fail(new CodexAppServerError("protocol", "Codex emitted malformed JSONL"));
        return;
      }
      if (!isRecord(message)) {
        this.#fail(new CodexAppServerError("protocol", "Codex emitted an invalid protocol message"));
        return;
      }
      this.#onMessage(message);
      if (this.#failure || this.#closed) return;
    }
    if (this.#buffer.byteLength > this.#maxLineBytes) {
      this.#fail(new CodexAppServerError("protocol", "Codex emitted an oversized JSONL line"));
    }
  }

  #onStderr(chunk: Buffer): void {
    if (this.#stderr.byteLength >= this.#maxStderrBytes) return;
    const remaining = this.#maxStderrBytes - this.#stderr.byteLength;
    this.#stderr = Buffer.concat([this.#stderr, chunk.subarray(0, remaining)]);
  }

  #exitMessage(prefix = "Codex App Server exited"): string {
    const stderr = this.#stderr.toString("utf8").trim();
    return stderr ? `${prefix}: ${stderr}` : prefix;
  }

  #onMessage(message: Record<string, unknown>): void {
    if (typeof message.id === "number" && !Number.isNaN(message.id) && !("method" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.#fail(new CodexAppServerError("protocol", "Codex emitted an unknown or duplicate response ID"));
        return;
      }
      if (message.error !== undefined) {
        const error = isRecord(message.error) ? message.error : undefined;
        const detail = typeof error?.message === "string" ? `: ${error.message}` : "";
        pending.reject(new CodexAppServerError("protocol", `Codex returned a request error${detail}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
      if (message.method === "item/tool/call") {
        if (!this.#claimServerRequest(message.id, true)) return;
        this.#dispatchAutomaticServerRequest(message.id, message.method, message.params);
        return;
      }
      if (this.#serverRequestListeners.size > 0) {
        if (!this.#claimServerRequest(message.id, false)) return;
        const request = { id: message.id, method: message.method, params: message.params };
        for (const listener of this.#serverRequestListeners) {
          try {
            listener(request);
          } catch (error) {
            this.#logger.debug(
              { code: "server_request_listener_failed", error: String(error) },
              "Codex server request listener failed",
            );
            this.#pendingServerRequests.delete(message.id);
            this.#fail(new CodexAppServerError("protocol", "A Codex server request listener failed"));
            return;
          }
        }
        return;
      }
      if (!this.#claimServerRequest(message.id, false)) return;
      this.#dispatchAutomaticServerRequest(message.id, message.method, message.params);
      return;
    }
    if (typeof message.method !== "string" || !("params" in message)) {
      this.#fail(new CodexAppServerError("protocol", "Codex emitted an unknown protocol message"));
      return;
    }
    for (const listener of this.#listeners) {
      try {
        listener(message);
      } catch (error) {
        this.#logger.debug(
          { code: "protocol_listener_failed", error: String(error) },
          "Codex protocol listener failed",
        );
        this.#fail(new CodexAppServerError("protocol", "A Codex protocol listener rejected a message"));
        return;
      }
    }
  }

  async #handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      await this.respondServerRequest(id, { decision: "cancel" }).catch(
        /* v8 ignore next -- best-effort responses on a wire that may already be closing. */ (error: unknown) => {
          this.#logger.debug(
            { code: "approval_response_failed", error: String(error) },
            "Codex approval response failed",
          );
        },
      );
      return;
    }
    if (method === "item/tool/requestUserInput") {
      await this.respondServerRequest(id, { answers: {} }).catch(
        /* v8 ignore next -- best-effort responses on a wire that may already be closing. */ (error: unknown) => {
          this.#logger.debug(
            { code: "user_input_response_failed", error: String(error) },
            "Codex user input response failed",
          );
        },
      );
      return;
    }
    if (method === "item/tool/call") {
      const handler = this.#dynamicToolHandler;
      if (!handler) {
        await this.respondServerRequest(id, {
          contentItems: [{ type: "inputText", text: "OpenTag tool is unavailable." }],
          success: false,
        }).catch(
          /* v8 ignore next -- best-effort responses on a wire that may already be closing. */ (error: unknown) => {
            this.#logger.debug(
              { code: "tool_unavailable_response_failed", error: String(error) },
              "Codex unavailable tool response failed",
            );
          },
        );
        return;
      }
      try {
        const call = parseDynamicToolCall(params);
        const result = await handler(call);
        const text = requireBoundedString(result.text, "OpenTag tool returned invalid output");
        await this.respondServerRequest(id, {
          contentItems: [{ type: "inputText", text }],
          success: result.success,
        });
      } catch (error) {
        this.#logger.debug({ code: "tool_request_failed", error: String(error) }, "Codex dynamic tool request failed");
        await this.respondServerRequest(id, {
          contentItems: [{ type: "inputText", text: "OpenTag tool request failed." }],
          success: false,
        }).catch(
          /* v8 ignore next -- best-effort responses on a wire that may already be closing. */ (
            responseError: unknown,
          ) => {
            this.#logger.debug(
              {
                code: "tool_error_response_failed",
                error: String(responseError),
              },
              "Codex dynamic tool error response failed",
            );
          },
        );
      }
      return;
    }
    await this.rejectServerRequest(id, -32601, "Unsupported unattended server request").catch(
      /* v8 ignore next -- best-effort responses on a wire that may already be closing. */ (error: unknown) => {
        this.#logger.debug(
          { code: "unsupported_request_response_failed", error: String(error) },
          "Codex unsupported request response failed",
        );
      },
    );
    this.#fail(new CodexAppServerError("protocol", `Codex requested an unsupported method: ${method}`));
  }

  #claimServerRequest(id: number | string, deferDuplicateFailure: boolean): boolean {
    if (!this.#seenServerRequests.has(id)) {
      this.#seenServerRequests.add(id);
      this.#pendingServerRequests.add(id);
      return true;
    }
    if (deferDuplicateFailure && this.#pendingServerRequests.has(id)) this.#duplicateServerRequests.add(id);
    else this.#fail(new CodexAppServerError("protocol", "Codex emitted a duplicate server request ID"));
    return false;
  }

  #dispatchAutomaticServerRequest(id: number | string, method: string, params: unknown): void {
    void this.#handleServerRequest(id, method, params).finally(() => {
      this.#pendingServerRequests.delete(id);
      if (!this.#duplicateServerRequests.delete(id) || this.#failure) return;
      const timer = setTimeout(
        () => this.#fail(new CodexAppServerError("protocol", "Codex emitted a duplicate server request ID")),
        10,
      );
      timer.unref();
    });
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const pending of [...this.#pending.values()]) pending.reject(error);
    this.#seenServerRequests.clear();
    this.#pendingServerRequests.clear();
    this.#respondingServerRequests.clear();
    this.#duplicateServerRequests.clear();
    for (const listener of this.#listeners) {
      try {
        listener({ method: "opentag/processError", params: { error } });
      } catch (listenerError) {
        this.#logger.debug(
          {
            code: "process_error_listener_failed",
            error: String(listenerError),
          },
          "Codex process error listener failed",
        );
        // The process boundary is already failed; listener failures cannot widen it.
      }
    }
    if (!this.#closed) {
      signalWatchedProcess(this.#child, "SIGTERM");
      const timer = setTimeout(() => {
        /* v8 ignore else -- the SIGKILL escalation timer only matters while the child is still open. */
        if (!this.#closed) signalWatchedProcess(this.#child, "SIGKILL");
      }, 1_000);
      timer.unref();
    }
  }
}

function parseDynamicToolCall(value: unknown): CodexDynamicToolCall {
  const params = requireRecord(value, "Codex returned invalid dynamic tool parameters");
  const namespace = params.namespace;
  if (namespace !== null && typeof namespace !== "string") {
    throw new CodexAppServerError("protocol", "Codex returned invalid dynamic tool namespace");
  }
  return {
    arguments: params.arguments,
    callId: requireBoundedString(params.callId, "Codex returned invalid dynamic tool call ID"),
    namespace,
    threadId: requireBoundedString(params.threadId, "Codex returned invalid dynamic tool Thread ID"),
    tool: requireBoundedString(params.tool, "Codex returned invalid dynamic tool name"),
    turnId: requireBoundedString(params.turnId, "Codex returned invalid dynamic tool Turn ID"),
  };
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref();
  });
  const settled = await Promise.race([promise.then(() => true as const), timeout]);
  /* v8 ignore else -- the timer is always armed before the race settles. */
  if (timer) clearTimeout(timer);
  return settled;
}

function spawnEvidence(error: unknown): { readonly errno?: string } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? { errno: code } : {};
}

function validateOptions(maxLineBytes: number, maxStderrBytes: number, requestTimeoutMs: number): void {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1024) {
    throw new Error("maxLineBytes must be a safe integer of at least 1024");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error("requestTimeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxStderrBytes) || maxStderrBytes < 0) {
    throw new Error("maxStderrBytes must be a non-negative safe integer");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CodexAppServerError("protocol", message);
  return value;
}

function requireBoundedString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096) {
    throw new CodexAppServerError("protocol", message);
  }
  return value;
}
