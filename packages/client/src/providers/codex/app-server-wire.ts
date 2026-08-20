import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { signalWatchedProcess, spawnWatchedProcess } from "../process-owner.js";

export const CODEX_APP_SERVER_MAX_LINE_BYTES = 1024 * 1024;
export const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 60_000;

export class CodexAppServerError extends Error {
  constructor(
    readonly code: "aborted" | "exited" | "protocol" | "spawn" | "timeout" | "write",
    message: string,
  ) {
    super(message);
    this.name = "CodexAppServerError";
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
  requestTimeoutMs?: number;
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
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #listeners = new Set<(message: CodexAppServerMessage) => void>();
  readonly #serverRequestListeners = new Set<(request: CodexAppServerRequest) => void>();
  readonly #pendingServerRequests = new Set<number | string>();
  readonly #respondingServerRequests = new Set<number | string>();
  readonly #exit: Promise<void>;
  #resolveExit: (() => void) | undefined;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #closed = false;
  #closing = false;
  #failure?: Error;
  #dynamicToolHandler?: CodexDynamicToolHandler;

  constructor(options: CodexSpawnOptions) {
    this.#expectedCodexHome = options.expectedCodexHome;
    this.#maxLineBytes = options.maxLineBytes ?? CODEX_APP_SERVER_MAX_LINE_BYTES;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? CODEX_APP_SERVER_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#maxLineBytes) || this.#maxLineBytes < 1024) {
      throw new Error("maxLineBytes must be a safe integer of at least 1024");
    }
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
      throw new Error("requestTimeoutMs must be a positive safe integer");
    }
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
      throw new CodexAppServerError("spawn", error instanceof Error ? error.message : "Codex could not be started");
    }
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    this.#child.stderr.on("data", () => undefined);
    this.#child.on("error", (error) => this.#fail(new CodexAppServerError("spawn", error.message)));
    this.#child.on("exit", () => {
      this.#closed = true;
      this.#resolveExit?.();
      this.#resolveExit = undefined;
      if (!this.#failure && !this.#closing) {
        const error =
          this.#buffer.byteLength > 0
            ? new CodexAppServerError("protocol", "Codex exited with a truncated JSONL line")
            : new CodexAppServerError("exited", "Codex App Server exited");
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
        capabilities: { experimentalApi: false },
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
    this.#pendingServerRequests.clear();
    this.#respondingServerRequests.clear();
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
    if (this.#failure) return;
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
        this.#fail(new CodexAppServerError("protocol", "Codex emitted malformed JSONL"));
        return;
      }
      if (!isRecord(message)) {
        this.#fail(new CodexAppServerError("protocol", "Codex emitted an invalid protocol message"));
        return;
      }
      this.#onMessage(message);
    }
    if (this.#buffer.byteLength > this.#maxLineBytes) {
      this.#fail(new CodexAppServerError("protocol", "Codex emitted an oversized JSONL line"));
    }
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
      if (this.#serverRequestListeners.size > 0) {
        if (this.#pendingServerRequests.has(message.id)) {
          this.#fail(new CodexAppServerError("protocol", "Codex emitted a duplicate server request ID"));
          return;
        }
        this.#pendingServerRequests.add(message.id);
        const request = { id: message.id, method: message.method, params: message.params };
        for (const listener of this.#serverRequestListeners) {
          try {
            listener(request);
          } catch {
            this.#pendingServerRequests.delete(message.id);
            this.#fail(new CodexAppServerError("protocol", "A Codex server request listener failed"));
            return;
          }
        }
        return;
      }
      void this.#handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if (typeof message.method !== "string" || !("params" in message)) {
      this.#fail(new CodexAppServerError("protocol", "Codex emitted an unknown protocol message"));
      return;
    }
    for (const listener of this.#listeners) {
      try {
        listener(message);
      } catch {
        this.#fail(new CodexAppServerError("protocol", "A Codex protocol listener rejected a message"));
        return;
      }
    }
  }

  async #handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      await this.#write({ id, result: { decision: "cancel" } }).catch(() => undefined);
      return;
    }
    if (method === "item/tool/requestUserInput") {
      await this.#write({ id, result: { answers: {} } }).catch(() => undefined);
      return;
    }
    if (method === "item/tool/call") {
      const handler = this.#dynamicToolHandler;
      if (!handler) {
        await this.#write({
          id,
          result: { contentItems: [{ type: "inputText", text: "OpenTag tool is unavailable." }], success: false },
        }).catch(() => undefined);
        return;
      }
      try {
        const call = parseDynamicToolCall(params);
        const result = await handler(call);
        const text = requireBoundedString(result.text, "OpenTag tool returned invalid output");
        await this.#write({ id, result: { contentItems: [{ type: "inputText", text }], success: result.success } });
      } catch {
        await this.#write({
          id,
          result: { contentItems: [{ type: "inputText", text: "OpenTag tool request failed." }], success: false },
        }).catch(() => undefined);
      }
      return;
    }
    await this.#write({ id, error: { code: -32601, message: "Unsupported unattended server request" } }).catch(
      () => undefined,
    );
    this.#fail(new CodexAppServerError("protocol", `Codex requested an unsupported method: ${method}`));
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const pending of [...this.#pending.values()]) pending.reject(error);
    this.#pendingServerRequests.clear();
    this.#respondingServerRequests.clear();
    for (const listener of this.#listeners) {
      try {
        listener({ method: "opentag/processError", params: { error } });
      } catch {
        // The process boundary is already failed; listener failures cannot widen it.
      }
    }
    if (!this.#closed) {
      signalWatchedProcess(this.#child, "SIGTERM");
      const timer = setTimeout(() => {
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
  if (timer) clearTimeout(timer);
  return settled;
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
