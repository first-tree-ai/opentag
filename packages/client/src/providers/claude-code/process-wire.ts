import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type ClientLogger, createLogger } from "../../observability/logger.js";
import { signalWatchedProcess, spawnWatchedProcess } from "../process-owner.js";

export const CLAUDE_CODE_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const CLAUDE_CODE_MAX_STDERR_BYTES = 64 * 1024;

const WAKEUP_TIMER = "ScheduleWakeup timer";
/** Claude Code's own wording in the tool result of a backgrounded Bash call. */
const BACKGROUND_TASK_OUTPUT = /with ID: (\S+?)\.\s+Output is being written to: (\S+?)\.(?:\s|$)/;

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
  readonly logger?: ClientLogger;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: ClaudeCodeProcessSpawnOptions,
  ) => ChildProcessWithoutNullStreams;
}

export interface ClaudeCodeProcessResult {
  readonly stderr: string;
  /** The Run's input was answered, and a turn Claude Code started by itself is what failed. */
  readonly followUpFailed?: boolean;
}

/** Synthetic frames this class adds to the stream, so the adapter sees background work in its order. */
export const CLAUDE_CODE_BACKGROUND_WORK_FRAME = "opentag/background_work";
export const CLAUDE_CODE_BACKGROUND_FINISHED_FRAME = "opentag/background_finished";

/**
 * `terminal` is false for a `result` that still has steered user input pending in Claude Code's
 * command queue: the CLI will process that input after this result and emit another one.
 */
export type ClaudeCodeMessageListener = (message: Readonly<Record<string, unknown>>, terminal?: boolean) => void;

export interface ClaudeCodeSteerHandle {
  /** True once Claude Code reported `command_lifecycle` `started` (or `completed`) for this input. */
  started(): boolean;
}

export interface ClaudeCodeProcessClient {
  send?(message: Readonly<Record<string, unknown>>): Promise<void>;
  /**
   * Writes a user message with a `uuid` into the running query. Claude Code queues it and attaches
   * it at the next tool boundary, or processes it after the current result; `command_lifecycle`
   * reports it as `started` once the model receives it. Until then the process can still exit
   * without ever processing it, so the returned handle reports whether that start was observed.
   */
  steer?(message: Readonly<Record<string, unknown>> & { readonly uuid: string }): Promise<ClaudeCodeSteerHandle>;
  notice?(text: string): Promise<void>;
  execute(
    input: Readonly<Record<string, unknown>>,
    onMessage: ClaudeCodeMessageListener,
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
  readonly #logger: ClientLogger;
  readonly #exit: Promise<void>;
  #resolveExit: (() => void) | undefined;
  #buffer = Buffer.alloc(0);
  #stderr = Buffer.alloc(0);
  #listener?: ClaudeCodeMessageListener;
  #resolveExecution?: (result: ClaudeCodeProcessResult) => void;
  #rejectExecution?: (error: Error) => void;
  #execution?: Promise<ClaudeCodeProcessResult>;
  #failure?: Error;
  #closed = false;
  #closing = false;
  #spawned = false;
  #terminalReceived = false;
  #signal?: AbortSignal;
  readonly #permissionControl: boolean;
  #pendingInput?: string;
  #initializeTimer?: ReturnType<typeof setTimeout>;
  /** Steered command uuids written to stdin that Claude Code has not yet started. */
  readonly #pendingSteers = new Set<string>();
  /** Steered command uuids Claude Code reported as started. */
  readonly #startedSteers = new Set<string>();
  /** Claude Code's latest report of the background tasks it is running, by task id. */
  #backgroundTasks = new Map<string, string>();
  readonly #taskOutputPaths = new Map<string, string>();
  readonly #inProcessTimers = new InProcessTimers();
  #publishedBackgroundWork = "[]";
  #ownResultSeen = false;
  readonly #noticeUuids = new Set<string>();
  #followUpFailed = false;
  #steerInTurn = false;

  constructor(options: ClaudeCodeSpawnOptions) {
    this.#permissionControl = options.args.includes("--permission-prompt-tool");
    this.#maxLineBytes = options.maxLineBytes ?? CLAUDE_CODE_MAX_LINE_BYTES;
    this.#maxStderrBytes = options.maxStderrBytes ?? CLAUDE_CODE_MAX_STDERR_BYTES;
    this.#logger = options.logger ?? createLogger("provider-claude-code");
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
      this.#logger.debug({ code: "spawn_failed", error: String(error) }, "Claude Code process spawn failed");
      throw new ClaudeCodeProcessError(
        "spawn",
        error instanceof Error ? error.message : "Claude Code could not be started",
      );
    }
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => this.#onStderr(chunk));
    this.#child.once("spawn", () => {
      this.#spawned = true;
    });
    this.#child.on("error", (error) => {
      this.#logger.debug(
        { code: this.#spawned ? "process_error" : "spawn_error", error: error.message },
        "Claude Code process failed",
      );
      this.#fail(new ClaudeCodeProcessError(this.#spawned ? "exited" : "spawn", error.message));
    });
    this.#child.on("exit", () => this.#onExit());
  }

  execute(
    input: Readonly<Record<string, unknown>>,
    onMessage: ClaudeCodeMessageListener,
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
    const firstLine = this.#permissionControl
      ? `${JSON.stringify({ type: "control_request", request_id: "opentag_initialize", request: { subtype: "initialize", hooks: null } })}\n`
      : line;
    if (this.#permissionControl) {
      this.#pendingInput = line;
      this.#initializeTimer = setTimeout(
        () => this.#fail(new ClaudeCodeProcessError("protocol", "Claude Code permission initialization timed out")),
        60_000,
      );
      this.#initializeTimer.unref();
    }
    this.#child.stdin.write(firstLine, (error) => {
      if (error) this.#fail(new ClaudeCodeProcessError("write", "Claude Code input could not be written"));
    });
    return this.#execution;
  }

  async interrupt(): Promise<void> {
    if (this.#closed || this.#terminalReceived) return;
    this.#closing = true;
    signalWatchedProcess(this.#child, "SIGINT");
  }

  async send(message: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.#failure || this.#closed || this.#terminalReceived)
      throw new ClaudeCodeProcessError("exited", "Claude Code is closed");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > this.#maxLineBytes)
      throw new ClaudeCodeProcessError("protocol", "Claude Code input exceeds the JSONL line limit");
    await new Promise<void>((resolve, reject) =>
      this.#child.stdin.write(line, (error) =>
        error ? reject(new ClaudeCodeProcessError("write", "Claude Code response could not be written")) : resolve(),
      ),
    );
  }

  /**
   * Writes a notice the Run itself generated into the running query. Unlike steered input it holds nothing
   * back, and a failure of its turn is a failure of a turn the Run started by itself.
   */
  async notice(text: string): Promise<void> {
    if (!this.#execution || this.#failure || this.#closed || this.#terminalReceived) return;
    const uuid = randomUUID();
    this.#noticeUuids.add(uuid);
    const message = {
      type: "user",
      uuid,
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    };
    await new Promise<void>((resolve, reject) =>
      this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(new ClaudeCodeProcessError("write", "Claude Code notice could not be written")) : resolve(),
      ),
    );
  }

  async steer(message: Readonly<Record<string, unknown>> & { readonly uuid: string }): Promise<ClaudeCodeSteerHandle> {
    if (!this.#execution || this.#failure || this.#closed || this.#terminalReceived)
      throw new ClaudeCodeProcessError("exited", "Claude Code is closed");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > this.#maxLineBytes)
      throw new ClaudeCodeProcessError("protocol", "Claude Code input exceeds the JSONL line limit");
    // Registered before the write so a result racing the write still waits for this input.
    this.#pendingSteers.add(message.uuid);
    const handle: ClaudeCodeSteerHandle = { started: () => this.#startedSteers.has(message.uuid) };
    if (this.#pendingInput !== undefined) {
      // Permission initialization has not finished: keep the steer behind the original prompt.
      this.#pendingInput += line;
      return handle;
    }
    await new Promise<void>((resolve, reject) =>
      this.#child.stdin.write(line, (error) => {
        if (!error) return resolve();
        this.#pendingSteers.delete(message.uuid);
        reject(new ClaudeCodeProcessError("write", "Claude Code steer input could not be written"));
      }),
    );
    return handle;
  }

  async close(graceMs = 1_000): Promise<void> {
    if (this.#closed) return this.#exit;
    this.#closing = true;
    signalWatchedProcess(this.#child, "SIGTERM");
    if (await settlesWithin(this.#exit, graceMs)) return;
    signalWatchedProcess(this.#child, "SIGKILL");
    /* v8 ignore else -- a process that survives SIGTERM in tests never exits before the SIGKILL deadline either. */
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
        this.#logger.debug({ code: "stdout_malformed_json" }, "Claude Code protocol output was rejected");
        this.#fail(new ClaudeCodeProcessError("protocol", "Claude Code emitted malformed JSONL"));
        return;
      }
      if (!isRecord(parsed)) {
        this.#fail(new ClaudeCodeProcessError("protocol", "Claude Code emitted a non-object message"));
        return;
      }
      if (this.#handleInitialize(parsed)) continue;
      this.#deliverMessage(parsed);
      if (this.#failure) return;
    }
    if (this.#buffer.byteLength > this.#maxLineBytes) {
      this.#fail(new ClaudeCodeProcessError("protocol", "Claude Code output exceeds the JSONL line limit"));
    }
  }

  #deliverMessage(parsed: Record<string, unknown>): void {
    if (
      parsed.type === "command_lifecycle" &&
      typeof parsed.command_uuid === "string" &&
      (parsed.state === "started" || parsed.state === "completed") &&
      this.#pendingSteers.delete(parsed.command_uuid)
    ) {
      this.#startedSteers.add(parsed.command_uuid);
      this.#steerInTurn = true;
    }
    const finished = this.#observeBackgroundWork(parsed);
    const terminal = parsed.type === "result" && this.#endsRun(parsed);
    try {
      if (finished) this.#listener?.(finished, false);
      this.#publishBackgroundWork();
      this.#listener?.(parsed, terminal);
    } catch (error) {
      this.#logger.debug(
        { code: "protocol_listener_failed", error: String(error) },
        "Claude Code protocol listener failed",
      );
      this.#fail(
        error instanceof Error ? error : new ClaudeCodeProcessError("protocol", "Claude Code message listener failed"),
      );
      return;
    }
    if (terminal) {
      this.#terminalReceived = true;
      this.#closing = true;
      signalWatchedProcess(this.#child, "SIGTERM");
    }
  }

  /**
   * A Run ends at a model turn's end once its own input was answered, nothing steered is waiting and no
   * background work is live. Claude Code also reports a result for input it generated itself, such as the
   * notice it queues on `--resume` about a background task the previous process left behind. That result
   * comes first, with no model turn, while the Run's input is still queued behind it, so it never ends the
   * Run. While work is live the process stays up: Claude Code wakes the model when the work finishes, and
   * the Run's limit bounds the wait.
   */
  #endsRun(result: Record<string, unknown>): boolean {
    // A steer that started in this turn makes it input someone is waiting on, whatever started the turn.
    const steerInTurn = this.#steerInTurn;
    this.#steerInTurn = false;
    if (this.#pendingSteers.size > 0) return false;
    if (result.is_error === true) {
      this.#followUpFailed = this.#ownResultSeen && !steerInTurn && this.#isSelfGeneratedResult(result);
      return true;
    }
    if (!this.#isSelfGeneratedResult(result)) this.#ownResultSeen = true;
    return this.#ownResultSeen && this.#backgroundWork().length === 0;
  }

  #isSelfGeneratedResult(result: Record<string, unknown>): boolean {
    const inputs = result.user_message_uuids;
    if (Array.isArray(inputs) && inputs.length > 0) return inputs.every((uuid) => this.#noticeUuids.has(String(uuid)));
    return isRecord(result.origin) || this.#inProcessTimers.turnRunning;
  }

  /**
   * Follows the work that keeps the Run open. The list of tasks is replaced on every change, and it
   * only names background tasks: a foreground tool also reports `task_notification`. The frame returned
   * is what finished, reported only for a task this process listed: on `--resume` Claude Code says
   * `stopped` about the previous process's task without knowing, and sometimes that task is still alive.
   */
  #observeBackgroundWork(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
    if (parsed.type === "system" && parsed.subtype === "background_tasks_changed" && Array.isArray(parsed.tasks)) {
      this.#backgroundTasks = new Map(parsed.tasks.filter(isRecord).map(backgroundTaskEntry));
      return undefined;
    }
    if (parsed.type === "system" && parsed.subtype === "task_notification") return this.#finishedTask(parsed);
    this.#inProcessTimers.observe(parsed);
    this.#observeTaskOutputPath(parsed);
    return undefined;
  }

  #finishedTask(notification: Record<string, unknown>): Record<string, unknown> | undefined {
    const id = String(notification.task_id);
    if (!this.#backgroundTasks.has(id)) return undefined;
    const outputPath = notification.output_file || this.#taskOutputPaths.get(id);
    return {
      type: CLAUDE_CODE_BACKGROUND_FINISHED_FRAME,
      id,
      status: String(notification.status),
      ...(typeof notification.summary === "string" ? { detail: notification.summary } : {}),
      ...(typeof outputPath === "string" ? { outputPath } : {}),
    };
  }

  /** Only a tool result names a running task's output file; a crash leaves nothing else to point at. */
  #observeTaskOutputPath(frame: Record<string, unknown>): void {
    if (frame.type !== "user" || !isRecord(frame.message) || !Array.isArray(frame.message.content)) return;
    for (const block of frame.message.content.filter(isRecord)) {
      const match =
        block.type === "tool_result" && typeof block.content === "string"
          ? BACKGROUND_TASK_OUTPUT.exec(block.content)
          : undefined;
      if (match?.[1] && match[2]) this.#taskOutputPaths.set(match[1], match[2]);
    }
  }

  #backgroundWork(): { id: string; label: string; outputPath?: string }[] {
    return [
      ...[...this.#backgroundTasks].map(([id, label]) => {
        const outputPath = this.#taskOutputPaths.get(id);
        return { id, label, ...(outputPath ? { outputPath } : {}) };
      }),
      ...this.#inProcessTimers.labels().map((label) => ({ id: label.replace(/\s+/g, "-"), label })),
    ];
  }

  #publishBackgroundWork(): void {
    const items = this.#backgroundWork();
    const published = JSON.stringify(items);
    if (published === this.#publishedBackgroundWork) return;
    this.#publishedBackgroundWork = published;
    this.#listener?.({ type: CLAUDE_CODE_BACKGROUND_WORK_FRAME, items }, false);
  }

  #handleInitialize(parsed: Record<string, unknown>): boolean {
    if (
      !this.#pendingInput ||
      parsed.type !== "control_response" ||
      !isRecord(parsed.response) ||
      parsed.response.request_id !== "opentag_initialize"
    )
      return false;
    clearTimeout(this.#initializeTimer);
    if (parsed.response.subtype !== "success") {
      this.#fail(new ClaudeCodeProcessError("protocol", "Claude Code permission initialization failed"));
      return true;
    }
    const input = this.#pendingInput;
    this.#pendingInput = undefined;
    this.#child.stdin.write(input, (error) => {
      if (error) this.#fail(new ClaudeCodeProcessError("write", "Claude Code input could not be written"));
    });
    return true;
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
    this.#resolveExecution?.({
      stderr: this.#stderr.toString("utf8"),
      ...(this.#followUpFailed ? { followUpFailed: true } : {}),
    });
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
    clearTimeout(this.#initializeTimer);
    this.#pendingInput = undefined;
    this.#listener = undefined;
    this.#resolveExecution = undefined;
    this.#rejectExecution = undefined;
  }
}

/**
 * The one-shot wakeup that may be pending in this process, which holds its Run open and appears in no task
 * list. It counts once its `ScheduleWakeup` call succeeded, until `stop` removes it or it fires. Native cron
 * tools are disabled, because a recurring timer would hold the Run to its limit: each firing of a recurring
 * job is its own Run, through an OpenTag Schedule.
 */
class InProcessTimers {
  /** `ScheduleWakeup` calls waiting for their `tool_result`, by tool call id. */
  readonly #calls = new Map<string, Record<string, unknown>>();
  #wakeupPending = false;
  /** When the pending wakeup is due, which is how its firing names it. */
  #wakeupScheduledFor?: unknown;
  /** Turns Claude Code started because a timer fired, by command uuid. */
  readonly #firedTurns = new Set<string>();

  /** A fired timer's turn reports its own `result`, which is not the result of any input. */
  get turnRunning(): boolean {
    return this.#firedTurns.size > 0;
  }

  observe(frame: Record<string, unknown>): void {
    if (frame.type === "command_lifecycle") this.#observeLifecycle(frame);
    if (!isRecord(frame.message) || !Array.isArray(frame.message.content)) return;
    for (const block of frame.message.content.filter(isRecord)) {
      if (frame.type === "assistant" && block.type === "tool_use") this.#recordCall(block);
      if (frame.type === "user" && block.type === "tool_result") this.#settleCall(block, frame.tool_use_result);
    }
  }

  /** Firing shows only here: `loop_wakeup` is a wakeup, and `scheduled_for` matches it. */
  #observeLifecycle(frame: Record<string, unknown>): void {
    const command = String(frame.command_uuid);
    if (frame.state === "completed") this.#firedTurns.delete(command);
    if (frame.state !== "started" || typeof frame.wakeup_source !== "string") return;
    this.#firedTurns.add(command);
    const named = typeof frame.scheduled_for === "number" && frame.scheduled_for === this.#wakeupScheduledFor;
    if (frame.wakeup_source === "loop_wakeup" && named) this.#wakeupPending = false;
  }

  labels(): string[] {
    return this.#wakeupPending ? [WAKEUP_TIMER] : [];
  }

  #recordCall(block: Record<string, unknown>): void {
    if (block.name === "ScheduleWakeup") this.#calls.set(String(block.id), block);
  }

  #settleCall(block: Record<string, unknown>, toolUseResult: unknown): void {
    const id = String(block.tool_use_id);
    const call = this.#calls.get(id);
    this.#calls.delete(id);
    if (!call || block.is_error === true) return;
    const input = isRecord(call.input) ? call.input : {};
    this.#wakeupPending = input.stop !== true;
    this.#wakeupScheduledFor = isRecord(toolUseResult) ? toolUseResult.scheduledFor : undefined;
  }
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref();
  });
  const settled = await Promise.race([promise.then(() => true), timeout]);
  /* v8 ignore else -- the timer is always armed before the race settles. */
  if (timer) clearTimeout(timer);
  return settled;
}

function backgroundTaskEntry(task: Record<string, unknown>): [string, string] {
  const type = String(task.task_type);
  return [String(task.task_id), typeof task.description === "string" ? `${task.description} (${type})` : type];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
