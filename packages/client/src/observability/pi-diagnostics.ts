import { performance } from "node:perf_hooks";
import { z } from "zod";

export const PI_DIAGNOSTIC_PREFIX = "opentag-pi-diagnostic:";
export const PI_DIAGNOSTIC_LINE_BYTES = 4 * 1024;
// Three parent records reserve space within the per-turn 32-record / 64 KiB envelope.
const MAX_RECORDS = 29;
const MAX_BYTES = 60 * 1024;

const phaseSchema = z.enum([
  "worker_startup",
  "worker_preparation",
  "pi_spawn",
  "get_state",
  "session_restore",
  "prompt_acceptance",
  "await_terminal",
  "cleanup",
]);
const durationSchema = z.number().finite().nonnegative();
const omittedMessage = "Untrusted error message omitted";
const safeErrorName = z.enum([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "PiRpcError",
  "AgentProviderError",
  "AgentRuntimeError",
]);
const errorSchema = z
  .object({
    name: safeErrorName,
    errorCode: z
      .union([
        z.enum([
          "aborted",
          "command",
          "exited",
          "protocol",
          "spawn",
          "timeout",
          "write",
          "provider_error",
          "provider_protocol_error",
          "provider_start_failed",
          "binding_incompatible",
          "busy",
          "closed",
          "configuration_invalid",
          "close_failed",
          "create_failed",
          "duplicate_run_id",
          "interaction_not_found",
          "invalid_request",
          "provider_unavailable",
          "resume_failed",
          "run_mismatch",
          "unsupported_capability",
        ]),
        z.string().regex(/^E[A-Z0-9_]{1,40}$/),
      ])
      .optional(),
    message: z
      .string()
      .max(1024)
      .refine((message) => message === omittedMessage || safeRpcMessage(message)),
    messageOrigin: z.enum(["rpc", "omitted"]),
    stack: z
      .array(
        z
          .string()
          .max(180)
          .regex(/^[A-Za-z0-9_.$<>]+(?:@[A-Za-z0-9_.-]+\.(?:[cm]?js|ts):[0-9]+:[0-9]+)?$/),
      )
      .max(8),
    redacted: z.boolean(),
    truncated: z.boolean(),
  })
  .strict();
const diagnosticSchema = z
  .object({
    version: z.literal(1),
    seq: z.number().int().positive(),
    elapsedMs: durationSchema,
    phase: phaseSchema,
    event: z.enum(["ready", "start", "end", "failure", "worker_end"]),
    diagnosticIncomplete: z.boolean().optional(),
    outcome: z.enum(["completed", "failed", "aborted", "cancelled"]).optional(),
    durationMs: durationSchema,
    timeoutMs: durationSchema.optional(),
    rpcCommand: z.enum(["get_state", "prompt"]).optional(),
    error: errorSchema
      .extend({ cause: z.array(errorSchema).max(2) })
      .strict()
      .optional(),
    exitCode: z.number().int().nullable().optional(),
    exitSignal: z
      .string()
      .regex(/^SIG[A-Z0-9]+$/)
      .nullable()
      .optional(),
    compactionCount: z.number().int().nonnegative().optional(),
    compactionDurationMs: durationSchema.optional(),
    acceptanceWindowSeq: z.number().int().nonnegative().optional(),
    acceptanceWindowElapsedMs: durationSchema.optional(),
    acceptanceTimerPaused: z.boolean().optional(),
    abortSource: z.enum(["run_signal", "client_shutdown", "turn_timeout"]).optional(),
  })
  .strict()
  .refine((record) => record.event !== "failure" || record.error !== undefined);

export type PiDiagnosticPhase = z.infer<typeof phaseSchema>;
export type PiDiagnosticRecord = z.infer<typeof diagnosticSchema>;
export type PiDiagnosticEvent = Omit<PiDiagnosticRecord, "version" | "seq" | "elapsedMs">;
export type PiDiagnosticSink = (event: PiDiagnosticEvent) => void;
export interface PiProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const safeMessages = new Set([
  "Pi RPC request was aborted",
  "Pi RPC is closing",
  "Pi RPC is closed",
  "Pi RPC stdin is unavailable",
  "Pi RPC request could not be written",
  "Pi RPC request is not JSON serializable",
  "Pi RPC request exceeds the JSONL line limit",
  "Pi RPC process tree did not exit",
  "Pi emitted an oversized JSONL line",
  "Pi emitted invalid UTF-8",
  "Pi emitted malformed JSONL",
  "Pi emitted a non-object RPC message",
  "Pi emitted a response without an ID",
  "Pi emitted an unknown or duplicate response ID",
  "Pi response command does not match its request",
  "Pi emitted an invalid RPC response",
  "Pi emitted an event without a type",
  "Pi exited with a truncated JSONL line",
  "Pi RPC exited unexpectedly",
]);

function safeRpcMessage(message: string): boolean {
  return safeMessages.has(message) || /^Pi RPC request timed out: (get_state|prompt|abort|steer)$/.test(message);
}

function diagnosticFrame(line: string): string {
  const name = (/^\s*at ([A-Za-z0-9_.$<>]+)(?: \(|$)/.exec(line)?.[1] ?? "<frame>").slice(0, 60);
  const location = /(?:^|[/\\(])([A-Za-z0-9_.-]+\.(?:[cm]?js|ts):[0-9]+:[0-9]+)\)?$/.exec(line)?.[1];
  if (!location || location.length > 110) return name;
  return `${name}@${location}`;
}

function errorPart(value: unknown, frameLimit = 4): z.infer<typeof errorSchema> {
  const error = value instanceof Error ? value : undefined;
  const code = error && "code" in error ? errorSchema.shape.errorCode.safeParse(error.code) : undefined;
  const trusted = error?.name === "PiRpcError" && safeRpcMessage(error.message);
  const rawStack = error?.stack ?? "";
  const stack = rawStack.slice(0, 16 * 1024).split("\n");
  const frames = stack.slice(1, frameLimit + 1).map(diagnosticFrame);
  return {
    name: safeErrorName.safeParse(error?.name).data ?? "Error",
    ...(code?.success && code.data ? { errorCode: code.data } : {}),
    message: trusted ? error.message : omittedMessage,
    messageOrigin: trusted ? "rpc" : "omitted",
    stack: frames,
    redacted: !trusted || frames.length > 0,
    truncated: rawStack.length > 16 * 1024 || stack.length > frameLimit + 1 || stack.some((line) => line.length > 180),
  };
}

export function piDiagnosticError(value: unknown): NonNullable<PiDiagnosticEvent["error"]> {
  try {
    const cause: z.infer<typeof errorSchema>[] = [];
    let current = value;
    for (let depth = 0; depth < 2 && current instanceof Error && current.cause !== undefined; depth++) {
      current = current.cause;
      cause.push(errorPart(current, 2));
    }
    const part = errorPart(value);
    return { ...part, cause, truncated: part.truncated || (current instanceof Error && current.cause !== undefined) };
  } catch {
    return {
      name: "Error",
      message: "Untrusted error message omitted",
      messageOrigin: "omitted",
      stack: [],
      cause: [],
      redacted: true,
      truncated: false,
    };
  }
}

export function emitPiDiagnostic(sink: PiDiagnosticSink | undefined, event: PiDiagnosticEvent): void {
  try {
    sink?.(event);
  } catch {
    // Diagnostics cannot alter execution, including when the parent pipe is already closed.
  }
}

interface PiDiagnosticStderr {
  write(line: string, callback?: (error?: Error | null) => void): unknown;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

const stderrStates = new WeakMap<PiDiagnosticStderr, { failed: boolean }>();

export function createPiDiagnosticStderrWriter(stderr: PiDiagnosticStderr): (line: string) => void {
  let state = stderrStates.get(stderr);
  if (!state) {
    state = { failed: false };
    stderrStates.set(stderr, state);
    const shared = state;
    try {
      stderr.on?.("error", () => {
        shared.failed = true;
      });
    } catch {
      shared.failed = true;
    }
  }
  const shared = state;
  return (line) => {
    if (shared.failed) throw new Error("Pi diagnostic stderr is unavailable");
    stderr.write(line, (error) => {
      if (error) shared.failed = true;
    });
  };
}

const rpcCommandByPhase: Partial<Record<PiDiagnosticPhase, "get_state" | "prompt">> = {
  get_state: "get_state",
  prompt_acceptance: "prompt",
};

export class PiRunDiagnostics {
  readonly #sink: PiDiagnosticSink | undefined;
  readonly #now: () => number;
  #phase: PiDiagnosticPhase = "pi_spawn";
  #started = 0;
  #timeoutMs: number | undefined;
  #compactions = 0;
  #compactionStarted: number | undefined;
  #compactionMs = 0;
  #window = 0;
  #windowStarted: number | undefined;
  #windowElapsed = 0;

  constructor(sink?: PiDiagnosticSink, now: () => number = () => performance.now()) {
    this.#sink = sink;
    this.#now = now;
  }

  start(phase: PiDiagnosticPhase, timeoutMs?: number): void {
    this.#phase = phase;
    this.#started = this.#now();
    this.#timeoutMs = timeoutMs;
    this.#emit("start");
  }

  end(exit?: PiProcessExit, outcome?: PiDiagnosticEvent["outcome"]): void {
    this.#emit("end", exit, undefined, false, outcome);
  }

  failure(error: unknown, exit?: PiProcessExit, aborted = false): void {
    this.#emit("failure", exit, error, aborted);
  }

  completeCleanup(error: Error | undefined, exit?: PiProcessExit): void {
    if (error) this.failure(error, exit);
    else this.end(exit);
  }

  acceptancePause(): void {
    if (this.#windowStarted !== undefined) this.#windowElapsed = this.#now() - this.#windowStarted;
    this.#windowStarted = undefined;
  }

  acceptanceArm(): void {
    this.#window++;
    this.#windowStarted = this.#now();
    this.#windowElapsed = 0;
  }

  compactionStart(): void {
    this.#compactions++;
    this.#compactionStarted = this.#now();
  }

  compactionEnd(): void {
    if (this.#compactionStarted !== undefined) this.#compactionMs += this.#now() - this.#compactionStarted;
    this.#compactionStarted = undefined;
  }

  #emit(
    event: PiDiagnosticEvent["event"],
    exit?: PiProcessExit,
    error?: unknown,
    aborted = false,
    outcome?: PiDiagnosticEvent["outcome"],
  ): void {
    const now = this.#now();
    emitPiDiagnostic(this.#sink, {
      phase: this.#phase,
      rpcCommand: rpcCommandByPhase[this.#phase],
      event,
      durationMs: Math.max(0, now - this.#started),
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
      ...(outcome ? { outcome } : {}),
      ...(exit ? { exitCode: exit.code, exitSignal: exit.signal } : {}),
      ...(event === "failure" ? { error: piDiagnosticError(error) } : {}),
      ...(aborted ? { abortSource: "run_signal" as const } : {}),
      ...(this.#phase === "prompt_acceptance"
        ? {
            compactionCount: this.#compactions,
            compactionDurationMs:
              this.#compactionMs + (this.#compactionStarted === undefined ? 0 : now - this.#compactionStarted),
            acceptanceWindowSeq: this.#window,
            acceptanceWindowElapsedMs:
              this.#windowStarted === undefined ? this.#windowElapsed : now - this.#windowStarted,
            acceptanceTimerPaused: this.#windowStarted === undefined,
          }
        : {}),
    });
  }
}

function reservedDiagnostic(event: Pick<PiDiagnosticEvent, "event" | "phase">): boolean {
  return event.event === "failure" || event.event === "worker_end" || event.phase === "cleanup";
}

export function createPiDiagnosticWriter(write: (line: string) => void, now: () => number = () => performance.now()) {
  const started = now();
  let seq = 0;
  let records = 0;
  let bytes = 0;
  let lastPhase: PiDiagnosticPhase = "worker_preparation";
  let phaseStarted = started;
  let incomplete = false;
  const emit: PiDiagnosticSink = (event) => {
    lastPhase = event.phase;
    if (event.event === "start") phaseStarted = now();
    const record = {
      ...event,
      version: 1,
      seq: ++seq,
      elapsedMs: Math.max(0, now() - started),
      diagnosticIncomplete: incomplete,
    };
    const parsed = diagnosticSchema.safeParse(record);
    if (!parsed.success) {
      incomplete = true;
      return;
    }
    const line = `\n${PI_DIAGNOSTIC_PREFIX}${JSON.stringify(parsed.data)}\n`;
    const size = Buffer.byteLength(line);
    const reserved = reservedDiagnostic(event);
    if (
      size > PI_DIAGNOSTIC_LINE_BYTES - 1024 ||
      records >= (reserved ? MAX_RECORDS : MAX_RECORDS - 4) ||
      bytes + size > (reserved ? MAX_BYTES : MAX_BYTES - 16 * 1024)
    ) {
      incomplete = true;
      return;
    }
    records++;
    bytes += size;
    try {
      write(line);
    } catch {
      incomplete = true;
    }
  };
  return {
    emit: (event: PiDiagnosticEvent) => emitPiDiagnostic(emit, event),
    finish: () =>
      emitPiDiagnostic(emit, { phase: lastPhase, event: "worker_end", durationMs: Math.max(0, now() - started) }),
    failure: (error: unknown) =>
      emitPiDiagnostic(emit, {
        phase: lastPhase,
        event: "failure",
        durationMs: Math.max(0, now() - phaseStarted),
        error: piDiagnosticError(error),
      }),
  };
}

export interface PiDiagnosticContext {
  readonly turnId: string;
  readonly sessionId: string;
  readonly resourceName: string;
  readonly sandboxId: string;
  readonly environmentGeneration: number;
  readonly deliveryId?: string;
  readonly messageId?: string;
}

// Leave 1 KiB for the parent serve startup version enrichment.
function diagnosticOutputLimits(fields: Readonly<Record<string, unknown>>) {
  if (fields.event === "worker_end" && !("seq" in fields)) return { records: 32, bytes: 63 * 1024 };
  if (fields.event === "failure" || fields.phase === "cleanup" || fields.event === "worker_end")
    return { records: 31, bytes: 59 * 1024 };
  return { records: 27, bytes: 48 * 1024 };
}

function parseDiagnosticLine(line: Buffer): PiDiagnosticRecord | undefined | null {
  if (!line.toString("utf8", 0, PI_DIAGNOSTIC_PREFIX.length).startsWith(PI_DIAGNOSTIC_PREFIX)) return null;
  try {
    return diagnosticSchema.safeParse(JSON.parse(line.subarray(PI_DIAGNOSTIC_PREFIX.length).toString("utf8"))).data;
  } catch {
    return undefined;
  }
}

export function createPiDiagnosticReader(
  context: PiDiagnosticContext,
  write: (record: Readonly<Record<string, unknown>>) => void,
  now: () => number = () => performance.now(),
) {
  const started = now();
  let buffer = Buffer.alloc(0);
  let discarding = false;
  let lastSeq = 0;
  let incomplete = false;
  let ready = false;
  let phase: PiDiagnosticPhase = "worker_startup";
  let phaseComplete = false;
  let originalErrorReceived = false;
  let failurePhase: PiDiagnosticPhase | undefined;
  let workerEnded = false;
  let outputRecords = 0;
  let outputBytes = 0;
  const output = (fields: Readonly<Record<string, unknown>>) => {
    try {
      const record = { module: "cloud-pi", operation: "pi.diagnostic", provider: "pi", ...fields, ...context };
      const size = Buffer.byteLength(JSON.stringify(record)) + 1;
      const limits = diagnosticOutputLimits(fields);
      if (size > PI_DIAGNOSTIC_LINE_BYTES || outputRecords >= limits.records || outputBytes + size > limits.bytes) {
        incomplete = true;
        return;
      }
      outputRecords++;
      outputBytes += size;
      write(record);
    } catch {
      incomplete = true;
    }
  };
  output({ event: "start", phase, durationMs: 0, severity: "INFO" });
  const endStartup = () => {
    if (ready) return;
    ready = true;
    output({ event: "end", phase: "worker_startup", durationMs: Math.max(0, now() - started), severity: "INFO" });
  };
  const accept = (line: Buffer) => {
    const record = parseDiagnosticLine(line);
    if (record === null) return;
    if (!record || record.seq <= lastSeq) {
      incomplete = true;
      return;
    }
    if (record.seq !== lastSeq + 1) incomplete = true;
    lastSeq = record.seq;
    endStartup();
    if (record.event === "worker_end") workerEnded = true;
    else {
      phase = record.phase;
      phaseComplete = record.event === "end";
    }
    if (record.diagnosticIncomplete) incomplete = true;
    const primaryFailure = record.event === "failure" && !originalErrorReceived;
    if (primaryFailure) {
      originalErrorReceived = true;
      failurePhase = record.phase;
    }
    output({
      ...record,
      receivedElapsedMs: Math.max(0, now() - started),
      errorCode: record.error?.errorCode,
      primaryFailure,
      severity: record.event === "failure" ? "ERROR" : "INFO",
    });
  };
  return {
    consume(chunk: Buffer): void {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const piece = chunk.subarray(offset, end);
        if (!discarding && buffer.length + piece.length <= PI_DIAGNOSTIC_LINE_BYTES) {
          buffer = Buffer.concat([buffer, piece]);
        } else {
          discarding = true;
          buffer = Buffer.alloc(0);
          incomplete = true;
        }
        if (newline < 0) break;
        if (!discarding && buffer.length > 0) accept(buffer);
        buffer = Buffer.alloc(0);
        discarding = false;
        offset = newline + 1;
      }
    },
    finish(fields: Readonly<Record<string, unknown>>): void {
      output({
        ...fields,
        phase,
        phaseComplete,
        event: "worker_end",
        durationMs: Math.max(0, now() - started),
        originalErrorReceived,
        failurePhase,
        diagnosticIncomplete: incomplete || !workerEnded || discarding || buffer.length > 0,
      });
    },
  };
}
