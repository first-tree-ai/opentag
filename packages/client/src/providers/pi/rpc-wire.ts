import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { signalWatchedProcess, spawnWatchedProcess } from "../process-owner.js";

export const PI_RPC_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const PI_RPC_MAX_STDERR_BYTES = 64 * 1024;
export const PI_RPC_REQUEST_TIMEOUT_MS = 60_000;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class PiRpcError extends Error {
  constructor(
    readonly code: "aborted" | "command" | "exited" | "protocol" | "spawn" | "timeout" | "write",
    message: string,
  ) {
    super(message);
    this.name = "PiRpcError";
  }
}

export interface PiRpcProcessSpawnOptions {
  cwd: string;
  detached: boolean;
  env: NodeJS.ProcessEnv;
}

export interface PiRpcSpawnOptions {
  readonly args: readonly string[];
  readonly command?: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly maxLineBytes?: number;
  readonly maxStderrBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: PiRpcProcessSpawnOptions,
  ) => ChildProcessWithoutNullStreams;
}

export interface PiRpcClient {
  request(command: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
  subscribe(listener: (message: Readonly<Record<string, unknown>>) => void): () => void;
  close(graceMs?: number): Promise<void>;
}

interface PendingRequest {
  readonly command: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
}

const defaultSpawn = (command: string, args: readonly string[], options: PiRpcProcessSpawnOptions) =>
  spawnWatchedProcess(command, args, options);

export class PiRpcProcess implements PiRpcClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #maxLineBytes: number;
  readonly #maxStderrBytes: number;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(message: Readonly<Record<string, unknown>>) => void>();
  readonly #exit: Promise<void>;
  #resolveExit: (() => void) | undefined;
  #buffer = Buffer.alloc(0);
  #stderr = Buffer.alloc(0);
  #nextId = 1;
  #closed = false;
  #closing = false;
  #failure?: Error;

  constructor(options: PiRpcSpawnOptions) {
    this.#maxLineBytes = options.maxLineBytes ?? PI_RPC_MAX_LINE_BYTES;
    this.#maxStderrBytes = options.maxStderrBytes ?? PI_RPC_MAX_STDERR_BYTES;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? PI_RPC_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#maxLineBytes) || this.#maxLineBytes < 1024) {
      throw new Error("maxLineBytes must be a safe integer of at least 1024");
    }
    if (!Number.isSafeInteger(this.#maxStderrBytes) || this.#maxStderrBytes < 0) {
      throw new Error("maxStderrBytes must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
      throw new Error("requestTimeoutMs must be a positive safe integer");
    }
    this.#exit = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    try {
      this.#child = (options.spawnProcess ?? defaultSpawn)(options.command ?? "pi", options.args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      throw new PiRpcError("spawn", error instanceof Error ? error.message : "Pi could not be started");
    }
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => this.#onStderr(chunk));
    this.#child.on("error", (error) => this.#onChildError(error));
    this.#child.on("close", () => this.#onExit());
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  subscribe(listener: (message: Readonly<Record<string, unknown>>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  request(command: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    if (this.#failure || this.#closed) {
      return Promise.reject(this.#failure ?? new PiRpcError("exited", "Pi RPC is closed"));
    }
    if (signal?.aborted) return Promise.reject(new PiRpcError("aborted", "Pi RPC request was aborted"));
    if (typeof command.type !== "string" || command.type.length === 0) {
      return Promise.reject(new PiRpcError("protocol", "Pi RPC command has no type"));
    }
    const commandType = command.type;
    const id = `opentag-${this.#nextId}`;
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
        reject(new PiRpcError("aborted", "Pi RPC request was aborted"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new PiRpcError("timeout", `Pi RPC request timed out: ${commandType}`));
      }, this.#requestTimeoutMs);
      timer.unref();
      this.#pending.set(id, {
        command: commandType,
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
      void this.#write({ ...command, id }).catch((error: unknown) => {
        this.#pending.get(id)?.reject(error as Error);
      });
    });
  }

  async close(graceMs = 1_000): Promise<void> {
    if (this.#closed) return this.#exit;
    this.#closing = true;
    this.#closed = true;
    const closingError = new PiRpcError("aborted", "Pi RPC is closing");
    for (const pending of [...this.#pending.values()]) pending.reject(closingError);
    this.#child.stdin.end();
    signalWatchedProcess(this.#child, "SIGTERM");
    if (await settlesWithin(this.#exit, graceMs)) return;
    signalWatchedProcess(this.#child, "SIGKILL");
    /* v8 ignore else -- a process that survives SIGTERM in tests never exits before the SIGKILL deadline either. */
    if (!(await settlesWithin(this.#exit, graceMs))) {
      throw new PiRpcError("exited", "Pi RPC process tree did not exit");
    }
  }

  async #write(message: unknown): Promise<void> {
    if (this.#failure || this.#closed || !this.#child.stdin.writable) {
      throw this.#failure ?? new PiRpcError("write", "Pi RPC stdin is unavailable");
    }
    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch {
      throw new PiRpcError("protocol", "Pi RPC request is not JSON serializable");
    }
    if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
      throw new PiRpcError("protocol", "Pi RPC request exceeds the JSONL line limit");
    }
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(line, (error) => {
        error ? reject(new PiRpcError("write", "Pi RPC request could not be written")) : resolve();
      });
    });
  }

  #onStdout(chunk: Buffer): void {
    if (this.#failure) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline + 1 > this.#maxLineBytes) {
        this.#fail(new PiRpcError("protocol", "Pi emitted an oversized JSONL line"));
        return;
      }
      let raw: string;
      try {
        raw = utf8Decoder.decode(this.#buffer.subarray(0, newline)).replace(/\r$/, "");
      } catch {
        this.#fail(new PiRpcError("protocol", "Pi emitted invalid UTF-8"));
        return;
      }
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (raw.length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        this.#fail(new PiRpcError("protocol", "Pi emitted malformed JSONL"));
        return;
      }
      if (!isRecord(message)) {
        this.#fail(new PiRpcError("protocol", "Pi emitted a non-object RPC message"));
        return;
      }
      this.#onMessage(message);
      if (this.#failure) return;
    }
    if (this.#buffer.byteLength > this.#maxLineBytes) {
      this.#fail(new PiRpcError("protocol", "Pi emitted an oversized JSONL line"));
    }
  }

  #onStderr(chunk: Buffer): void {
    if (this.#stderr.byteLength >= this.#maxStderrBytes) return;
    const remaining = this.#maxStderrBytes - this.#stderr.byteLength;
    this.#stderr = Buffer.concat([this.#stderr, chunk.subarray(0, remaining)]);
  }

  #onMessage(message: Record<string, unknown>): void {
    if (message.type === "response") {
      const id = message.id;
      if (typeof id !== "string") {
        this.#fail(new PiRpcError("protocol", "Pi emitted a response without an ID"));
        return;
      }
      const pending = this.#pending.get(id);
      if (!pending) {
        this.#fail(new PiRpcError("protocol", "Pi emitted an unknown or duplicate response ID"));
        return;
      }
      if (message.command !== pending.command) {
        this.#fail(new PiRpcError("protocol", "Pi response command does not match its request"));
        return;
      }
      if (message.success === true) {
        pending.resolve(message.data);
        return;
      }
      if (message.success === false && typeof message.error === "string") {
        pending.reject(new PiRpcError("command", `Pi rejected ${pending.command}: ${message.error}`));
        return;
      }
      this.#fail(new PiRpcError("protocol", "Pi emitted an invalid RPC response"));
      return;
    }
    if (typeof message.type !== "string") {
      this.#fail(new PiRpcError("protocol", "Pi emitted an event without a type"));
      return;
    }
    for (const listener of this.#listeners) {
      try {
        listener(message);
      } catch {
        this.#fail(new PiRpcError("protocol", "A Pi RPC listener rejected an event"));
        return;
      }
    }
  }

  #onExit(): void {
    this.#closed = true;
    this.#resolveExit?.();
    this.#resolveExit = undefined;
    if (this.#failure || this.#closing) return;
    const error =
      this.#buffer.byteLength > 0
        ? new PiRpcError("protocol", "Pi exited with a truncated JSONL line")
        : new PiRpcError("exited", this.#exitMessage());
    this.#fail(error);
  }

  #onChildError(error: Error): void {
    this.#fail(new PiRpcError("spawn", error.message));
    this.#closed = true;
    this.#resolveExit?.();
    this.#resolveExit = undefined;
  }

  #exitMessage(): string {
    const stderr = this.#stderr.toString("utf8").trim();
    return stderr ? `Pi RPC exited: ${stderr}` : "Pi RPC exited unexpectedly";
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const pending of [...this.#pending.values()]) pending.reject(error);
    for (const listener of this.#listeners) {
      try {
        listener({ type: "opentag/process_error", error });
      } catch {
        // The process boundary is already failed; listener failures cannot widen it.
      }
    }
    if (!this.#closed) {
      this.#closing = true;
      signalWatchedProcess(this.#child, "SIGTERM");
      const timer = setTimeout(() => {
        if (!this.#closed) signalWatchedProcess(this.#child, "SIGKILL");
      }, 1_000);
      timer.unref();
    }
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
