import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { signalWatchedProcess, spawnWatchedProcess } from "../process-owner.js";

export const CLAUDE_CODE_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const CLAUDE_CODE_MAX_STDERR_BYTES = 64 * 1024;

export class ClaudeCodeProcessError extends Error {
  constructor(
    readonly code: "aborted" | "exited" | "protocol" | "spawn" | "write",
    message: string,
  ) {
    super(message);
    this.name = "ClaudeCodeProcessError";
  }
}

export interface ClaudeCodeProcessSpawnOptions {
  cwd: string;
  detached: boolean;
  env: NodeJS.ProcessEnv;
}

export interface ClaudeCodeSpawnOptions {
  readonly args: readonly string[];
  readonly command?: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly maxLineBytes?: number;
  readonly maxStderrBytes?: number;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: ClaudeCodeProcessSpawnOptions,
  ) => ChildProcessWithoutNullStreams;
}

export interface ClaudeCodeProcessResult {
  readonly stderr: string;
}

export interface ClaudeCodeProcessClient {
  execute(
    input: Readonly<Record<string, unknown>>,
    onMessage: (message: Readonly<Record<string, unknown>>) => void,
    signal: AbortSignal,
  ): Promise<ClaudeCodeProcessResult>;
  interrupt(): Promise<void>;
  close(graceMs?: number): Promise<void>;
}

const defaultSpawn = (command: string, args: readonly string[], options: ClaudeCodeProcessSpawnOptions) =>
  spawnWatchedProcess(command, args, options);

export class ClaudeCodeProcess implements ClaudeCodeProcessClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #maxLineBytes: number;
  readonly #maxStderrBytes: number;
  readonly #exit: Promise<void>;
  #resolveExit: (() => void) | undefined;
  #buffer = Buffer.alloc(0);
  #stderr = Buffer.alloc(0);
  #listener?: (message: Readonly<Record<string, unknown>>) => void;
  #resolveExecution?: (result: ClaudeCodeProcessResult) => void;
  #rejectExecution?: (error: Error) => void;
  #execution?: Promise<ClaudeCodeProcessResult>;
  #failure?: Error;
  #closed = false;
  #closing = false;
  #terminalReceived = false;
  #signal?: AbortSignal;

  constructor(options: ClaudeCodeSpawnOptions) {
    this.#maxLineBytes = options.maxLineBytes ?? CLAUDE_CODE_MAX_LINE_BYTES;
    this.#maxStderrBytes = options.maxStderrBytes ?? CLAUDE_CODE_MAX_STDERR_BYTES;
    if (!Number.isSafeInteger(this.#maxLineBytes) || this.#maxLineBytes < 1024) {
      throw new Error("maxLineBytes must be a safe integer of at least 1024");
    }
    if (!Number.isSafeInteger(this.#maxStderrBytes) || this.#maxStderrBytes < 0) {
      throw new Error("maxStderrBytes must be a non-negative safe integer");
    }
    this.#exit = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    try {
      this.#child = (options.spawnProcess ?? defaultSpawn)(options.command ?? "claude", options.args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      throw new ClaudeCodeProcessError(
        "spawn",
        error instanceof Error ? error.message : "Claude Code could not be started",
      );
    }
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => this.#onStderr(chunk));
    this.#child.on("error", (error) => this.#fail(new ClaudeCodeProcessError("spawn", error.message)));
    this.#child.on("exit", () => this.#onExit());
  }

  execute(
    input: Readonly<Record<string, unknown>>,
    onMessage: (message: Readonly<Record<string, unknown>>) => void,
    signal: AbortSignal,
  ): Promise<ClaudeCodeProcessResult> {
    if (this.#execution) return Promise.reject(new ClaudeCodeProcessError("protocol", "Claude Code already ran"));
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.reject(new ClaudeCodeProcessError("exited", "Claude Code is closed"));
    if (signal.aborted) return Promise.reject(new ClaudeCodeProcessError("aborted", "Claude Code run was aborted"));
    this.#listener = onMessage;
    this.#signal = signal;
    this.#execution = new Promise<ClaudeCodeProcessResult>((resolve, reject) => {
      this.#resolveExecution = resolve;
      this.#rejectExecution = reject;
    });
    const line = `${JSON.stringify(input)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
      this.#fail(new ClaudeCodeProcessError("protocol", "Claude Code input exceeds the JSONL line limit"));
      return this.#execution;
    }
    this.#child.stdin.write(line, (error) => {
      if (error) this.#fail(new ClaudeCodeProcessError("write", "Claude Code input could not be written"));
    });
    return this.#execution;
  }

  async interrupt(): Promise<void> {
    if (this.#closed || this.#terminalReceived) return;
    this.#closing = true;
    signalWatchedProcess(this.#child, "SIGINT");
  }

  async close(graceMs = 1_000): Promise<void> {
    if (this.#closed) return this.#exit;
    this.#closing = true;
    signalWatchedProcess(this.#child, "SIGTERM");
    if (await settlesWithin(this.#exit, graceMs)) return;
    signalWatchedProcess(this.#child, "SIGKILL");
    if (!(await settlesWithin(this.#exit, graceMs))) {
      throw new ClaudeCodeProcessError("exited", "Claude Code process tree did not exit");
    }
  }

  #onStdout(chunk: Buffer): void {
    if (this.#failure) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline + 1 > this.#maxLineBytes) {
        this.#fail(new ClaudeCodeProcessError("protocol", "Claude Code output exceeds the JSONL line limit"));
        return;
      }
      const raw = this.#buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (raw.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.#fail(new ClaudeCodeProcessError("protocol", "Claude Code emitted malformed JSONL"));
        return;
      }
      if (!isRecord(parsed)) {
        this.#fail(new ClaudeCodeProcessError("protocol", "Claude Code emitted a non-object message"));
        return;
      }
      try {
        this.#listener?.(parsed);
      } catch (error) {
        this.#fail(
          error instanceof Error
            ? error
            : new ClaudeCodeProcessError("protocol", "Claude Code message listener failed"),
        );
        return;
      }
      if (parsed.type === "result") {
        this.#terminalReceived = true;
        this.#closing = true;
        signalWatchedProcess(this.#child, "SIGTERM");
      }
    }
    if (this.#buffer.byteLength > this.#maxLineBytes) {
      this.#fail(new ClaudeCodeProcessError("protocol", "Claude Code output exceeds the JSONL line limit"));
    }
  }

  #onStderr(chunk: Buffer): void {
    if (this.#stderr.byteLength >= this.#maxStderrBytes) return;
    const remaining = this.#maxStderrBytes - this.#stderr.byteLength;
    this.#stderr = Buffer.concat([this.#stderr, chunk.subarray(0, remaining)]);
  }

  #onExit(): void {
    this.#closed = true;
    this.#resolveExit?.();
    this.#resolveExit = undefined;
    if (this.#failure) return;
    if (this.#buffer.byteLength > 0) {
      this.#fail(new ClaudeCodeProcessError("protocol", "Claude Code exited with a truncated JSONL line"));
      return;
    }
    if (!this.#execution) return;
    if (!this.#terminalReceived) {
      const aborted = this.#signal?.aborted || this.#closing;
      this.#fail(
        new ClaudeCodeProcessError(
          aborted ? "aborted" : "exited",
          aborted ? "Claude Code run was aborted" : this.#exitMessage(),
        ),
      );
      return;
    }
    this.#resolveExecution?.({ stderr: this.#stderr.toString("utf8") });
    this.#clearExecution();
  }

  #exitMessage(): string {
    const stderr = this.#stderr.toString("utf8").trim();
    return stderr ? `Claude Code exited: ${stderr}` : "Claude Code exited before a result";
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#rejectExecution?.(error);
    this.#clearExecution();
    if (!this.#closed) {
      this.#closing = true;
      signalWatchedProcess(this.#child, "SIGTERM");
    }
  }

  #clearExecution(): void {
    this.#listener = undefined;
    this.#resolveExecution = undefined;
    this.#rejectExecution = undefined;
  }
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref();
  });
  const settled = await Promise.race([promise.then(() => true), timeout]);
  if (timer) clearTimeout(timer);
  return settled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
