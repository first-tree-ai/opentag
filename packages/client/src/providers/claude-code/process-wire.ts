import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type ClientLogger, createLogger } from "../../observability/logger.js";
import { signalWatchedProcess, spawnWatchedProcess } from "../process-owner.js";

export const CLAUDE_CODE_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const CLAUDE_CODE_MAX_STDERR_BYTES = 64 * 1024;

/** Tools that change timers living inside the Claude Code process, which appear in no task list. */
const IN_PROCESS_TIMER_TOOLS = new Set(["ScheduleWakeup", "CronCreate", "CronDelete"]);
const WAKEUP_TIMER = "ScheduleWakeup timer";

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
  /** What may still have been live in the process when its Run ended; if so, it stops when the process exits. */
  readonly abandonedBackgroundWork?: readonly string[];
}

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
  readonly #inProcessTimers = new InProcessTimers();
  #backgroundNoticeSent = false;
  /** The result that the background notice continued past: the Run's own work was done by then. */
  #completedBeforeNotice?: Record<string, unknown>;
  /** Sampled at the terminal result: stopping the process empties the lists above. */
  #abandonedAtTerminal: readonly string[] = [];

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
    )
      this.#startedSteers.add(parsed.command_uuid);
    this.#observeBackgroundWork(parsed);
    const terminal = parsed.type === "result" && this.#endsRun(parsed);
    try {
      this.#listener?.(terminal ? this.#terminalReport(parsed) : parsed, terminal);
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
      this.#abandonedAtTerminal = this.#backgroundWork();
      this.#terminalReceived = true;
      this.#closing = true;
      signalWatchedProcess(this.#child, "SIGTERM");
    }
  }

  /**
   * Only the result of the Run's own input can end the Run, and only when nothing steered is still
   * waiting. Claude Code also reports a result for input it generated itself, such as the notice it
   * queues on `--resume` about a background task the previous process left behind. That result comes
   * first, with no model turn, while the Run's input is still queued behind it.
   *
   * The background notice is deliberately not in `#pendingSteers`: it asks for a wrap-up, so the next
   * result ends the Run whether or not Claude Code reported the notice's `command_lifecycle`. Input is
   * first in, first out, so nothing else can produce that result: a steer written before the notice held
   * it back, and one written after it stays pending until its own result.
   */
  #endsRun(result: Record<string, unknown>): boolean {
    if (this.#pendingSteers.size > 0) return false;
    if (result.is_error === true) return true;
    if (this.#isSelfGeneratedResult(result)) return false;
    if (!this.#sendBackgroundNotice()) return true;
    this.#completedBeforeNotice = result;
    return false;
  }

  /**
   * The Run's work completed before the background notice, so a wrap-up turn that fails (a model 429,
   * for example) must not turn it into a failed Run that runs again. Only the failure's usage is kept.
   */
  #terminalReport(result: Record<string, unknown>): Record<string, unknown> {
    if (result.is_error !== true || !this.#completedBeforeNotice) return result;
    this.#logger.warn(
      { code: "background_notice_turn_failed", subtype: result.subtype },
      "The turn after the background work notice failed; the Run's own work had completed",
    );
    return { ...this.#completedBeforeNotice, usage: result.usage ?? {}, num_turns: result.num_turns ?? 0 };
  }

  #isSelfGeneratedResult(result: Record<string, unknown>): boolean {
    const inputs = result.user_message_uuids;
    if (Array.isArray(inputs) && inputs.length > 0) return false;
    return isRecord(result.origin) || this.#inProcessTimers.turnRunning;
  }

  /** Follows what will stop with this process. The list of tasks is replaced on every change. */
  #observeBackgroundWork(parsed: Record<string, unknown>): void {
    if (parsed.type === "system" && parsed.subtype === "background_tasks_changed" && Array.isArray(parsed.tasks)) {
      this.#backgroundTasks = new Map(parsed.tasks.filter(isRecord).map(backgroundTaskEntry));
      return;
    }
    this.#inProcessTimers.observe(parsed);
  }

  #backgroundWork(): string[] {
    return [...this.#backgroundTasks.values(), ...this.#inProcessTimers.labels()];
  }

  /**
   * The process exits with its Run, and its background work stops with it. The Session hears about it
   * once, while it can still act. True when the notice went out, so the Run continues past this result.
   */
  #sendBackgroundNotice(): boolean {
    const work = this.#backgroundWork();
    if (this.#backgroundNoticeSent || work.length === 0 || this.#signal?.aborted) return false;
    this.#backgroundNoticeSent = true;
    const uuid = randomUUID();
    const notice = {
      type: "user",
      uuid,
      message: { role: "user", content: [{ type: "text", text: buildBackgroundWorkNotice(work) }] },
      parent_tool_use_id: null,
    };
    this.#child.stdin.write(`${JSON.stringify(notice)}\n`, (error) => {
      if (error) this.#fail(new ClaudeCodeProcessError("write", "Claude Code input could not be written"));
    });
    return true;
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
    const abandonedBackgroundWork = this.#abandonedAtTerminal;
    this.#resolveExecution?.({
      stderr: this.#stderr.toString("utf8"),
      ...(abandonedBackgroundWork.length > 0 ? { abandonedBackgroundWork } : {}),
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
 * The timers that may be live in this process. A tool call counts only once its `tool_result` succeeded:
 * an invalid cron expression creates nothing, and `CronDelete` and `ScheduleWakeup` with `stop` remove what
 * they name. A cron firing names no job and can come from a durable job of an earlier Run, so it removes
 * nothing, and a report may name a job that already ran. A cron job with `durable: true` is written to disk,
 * so it does not stop with the process.
 */
class InProcessTimers {
  /** Timer tool calls waiting for their `tool_result`, by tool call id. */
  readonly #calls = new Map<string, Record<string, unknown>>();
  /** Live timers by job id, with one entry for the Session's single pending wakeup. */
  readonly #live = new Map<string, string>();
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

  /** Firing shows only here. `loop_wakeup` is a wakeup and `scheduled_for` matches it; a cron firing names no job. */
  #observeLifecycle(frame: Record<string, unknown>): void {
    const command = String(frame.command_uuid);
    if (frame.state === "completed") this.#firedTurns.delete(command);
    if (frame.state !== "started" || typeof frame.wakeup_source !== "string") return;
    this.#firedTurns.add(command);
    const named = typeof frame.scheduled_for === "number" && frame.scheduled_for === this.#wakeupScheduledFor;
    if (frame.wakeup_source === "loop_wakeup" && named) this.#live.delete(WAKEUP_TIMER);
  }

  labels(): string[] {
    return [...this.#live.values()];
  }

  #recordCall(block: Record<string, unknown>): void {
    if (IN_PROCESS_TIMER_TOOLS.has(String(block.name))) this.#calls.set(String(block.id), block);
  }

  #settleCall(block: Record<string, unknown>, toolUseResult: unknown): void {
    const id = String(block.tool_use_id);
    const call = this.#calls.get(id);
    this.#calls.delete(id);
    if (!call || block.is_error === true) return;
    const input = isRecord(call.input) ? call.input : {};
    const result = isRecord(toolUseResult) ? toolUseResult : {};
    if (call.name === "ScheduleWakeup") {
      if (input.stop === true) this.#live.delete(WAKEUP_TIMER);
      else this.#live.set(WAKEUP_TIMER, WAKEUP_TIMER);
      this.#wakeupScheduledFor = result.scheduledFor;
    } else if (call.name === "CronDelete") {
      this.#live.delete(String(input.id));
    } else if (result.durable !== true) {
      const jobId = typeof result.id === "string" ? result.id : id;
      this.#live.set(jobId, `CronCreate job ${jobId}`);
    }
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

/** What the Session reads at the end of a Run that leaves background work behind. */
function buildBackgroundWorkNotice(work: readonly string[]): string {
  return [
    "[openTag notice] This Run is about to end. Claude Code exits with it. This background work may still be running or pending, and if so it stops then, with no result:",
    ...work.map((item) => `- ${item}`),
    "Nothing wakes this Session afterwards. If the result matters, wait for it now in this Run or run the work in the foreground.",
    "If you leave it unfinished, tell whoever is waiting for it before you end this Run.",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
