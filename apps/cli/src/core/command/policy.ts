import { type ClientLogger, createLogger, OpenTagApiError } from "@opentag/client";
import {
  type ErrorRetryability,
  redactSensitive,
  type StructuredError,
  StructuredErrorCategorySchema,
  StructuredErrorPhaseSchema,
  StructuredErrorSchema,
} from "@opentag/shared";

/** Process exit values shared by every user-facing CLI command. */
export const EXIT_CODES = {
  success: 0,
  failure: 1,
  usage: 2,
  serviceUnavailable: 3,
  interrupted: 130,
} as const;

export type CommandExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
export type CommandErrorCategory = StructuredError["category"];
export type CommandRetryability = ErrorRetryability;
export type CommandPhase = StructuredError["phase"];

type CommandErrorCodeFields = { code: string; category: CommandErrorCategory };
type CommandErrorRetryFields = { retryability: CommandRetryability; phase: CommandPhase };
type CommandErrorRequiredFields = CommandErrorCodeFields & CommandErrorRetryFields;
type CommandErrorFields = CommandErrorRequiredFields & { requestId?: string };

/** Structured, transport-neutral CLI failure metadata. The Error message is the human detail. */
export class CommandError extends Error {
  declare readonly code: string;
  declare readonly category: CommandErrorCategory;
  declare readonly retryability: CommandRetryability;
  declare readonly phase: CommandPhase;
  declare readonly requestId?: string;
  readonly structuredError: StructuredError;

  constructor(fields: CommandErrorFields, message: string, options?: ErrorOptions) {
    const safeMessage = redactSecrets(message);
    super(safeMessage, options);
    this.name = "CommandError";
    this.code = fields.code;
    this.category = fields.category;
    this.retryability = fields.retryability;
    this.phase = fields.phase;
    if (fields.requestId) this.requestId = fields.requestId;
    this.structuredError = StructuredErrorSchema.parse({
      code: this.code,
      category: this.category,
      retryability: this.retryability,
      phase: this.phase,
      ...(this.requestId ? { requestId: this.requestId.slice(0, 256) } : {}),
      message: safeMessage.slice(0, 2_048),
    });
  }

  toStructuredError(): StructuredError {
    return this.structuredError;
  }
}

type SuccessCommandResult<T> = { ok: true; value: T; exitCode: typeof EXIT_CODES.success };
type FailureCommandResultBase<T> = { ok: false; error: CommandError; value?: T };
type FailureCommandResult<T> = FailureCommandResultBase<T> & { exitCode: CommandExitCode };
export type CommandResult<T> = SuccessCommandResult<T> | FailureCommandResult<T>;
type CommandFormatValueOptions<T> = { formatValue?: (value: T) => string };
type CommandFormatWriterOptions = { stdout?: (chunk: string) => void; stderr?: (chunk: string) => void };
type CommandFormatOptions<T> = CommandFormatValueOptions<T> & CommandFormatWriterOptions;
export type CommandPresentationOptions<T> = { json?: boolean } & CommandFormatOptions<T>;
export type CommandExecutionOptions<T> = CommandPresentationOptions<T> & {
  logger?: ClientLogger;
  phase?: CommandPhase;
};

const OUTPUT_BROKEN_PIPE_SYMBOL = Symbol.for("opentag.outputBrokenPipe");

/** Whether an error (or any cause in its chain) carries `code === "EPIPE"`. */
export function hasBrokenPipeCode(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: unknown }).code === "EPIPE") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Mark an `EPIPE` error (and any `EPIPE` cause in its chain) as originating from a CLI
 * `stdout`/`stderr` write or stream error boundary. Only errors marked at an owned output boundary
 * are treated as clean downstream pipe closures; non-output `EPIPE` failures (such as a child
 * process `stdin` pipe) remain reportable internal errors.
 */
export function markOutputBrokenPipeError<T>(error: T): T {
  if (!hasBrokenPipeCode(error)) return error;
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current === error || (current as { code?: unknown }).code === "EPIPE") {
      Object.defineProperty(current, OUTPUT_BROKEN_PIPE_SYMBOL, {
        value: true,
        configurable: true,
      });
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error;
}

/**
 * Whether an error (or any cause in its chain) is a broken-pipe write (`EPIPE`) confirmed at the
 * CLI `stdout`/`stderr` output boundary.
 */
export function isBrokenPipeError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (
      (current as { code?: unknown }).code === "EPIPE" &&
      (current as { [OUTPUT_BROKEN_PIPE_SYMBOL]?: unknown })[OUTPUT_BROKEN_PIPE_SYMBOL] === true
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Convert errors from Commander, Zod, the API, and Node into one local contract. */
export function toCommandError(error: unknown, phase: CommandPhase = "unknown"): CommandError {
  if (error instanceof CommandError) return error;
  if (isBrokenPipeError(error)) {
    return markOutputBrokenPipeError(
      new CommandError(
        { code: "EPIPE", category: "cancelled", retryability: "never", phase: "shutdown" },
        "The output stream was closed by the reader",
        { cause: error },
      ),
    );
  }
  if (isZodError(error)) {
    return new CommandError(
      { code: "VALIDATION_ERROR", category: "validation", retryability: "never", phase: "validation" },
      error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "),
      { cause: error },
    );
  }
  if (error instanceof OpenTagApiError) {
    const mapped = mapApiError(error);
    return new CommandError(mapped, error.message, { cause: error });
  }
  if (isInterrupted(error)) {
    return new CommandError(
      { code: "INTERRUPTED", category: "cancelled", retryability: "never", phase: "shutdown" },
      "The operation was interrupted",
      { cause: error },
    );
  }

  return classifyGenericError(error, phase);
}

function classifyGenericError(error: unknown, phase: CommandPhase): CommandError {
  const candidate =
    error !== null && typeof error === "object"
      ? (error as { code?: unknown; category?: unknown; requestId?: unknown; message?: unknown })
      : {};
  const code = typeof candidate.code === "string" && candidate.code.length > 0 ? candidate.code : "INTERNAL_ERROR";
  const message = typeof candidate.message === "string" ? candidate.message : String(error);
  const requestId = typeof candidate.requestId === "string" ? candidate.requestId : undefined;
  if (
    StructuredErrorCategorySchema.safeParse(candidate.category).success &&
    StructuredErrorPhaseSchema.safeParse((candidate as { phase?: unknown }).phase).success &&
    isRetryability((candidate as { retryability?: unknown }).retryability)
  ) {
    return new CommandError(
      {
        code,
        category: candidate.category as CommandErrorCategory,
        retryability: (candidate as { retryability: CommandRetryability }).retryability,
        phase: (candidate as { phase: CommandPhase }).phase,
        ...(requestId ? { requestId } : {}),
      },
      message,
      { cause: error },
    );
  }
  if (candidate.category === "validation" || phase === "validation") {
    return new CommandError({ code, category: "validation", retryability: "never", phase: "validation" }, message, {
      cause: error,
    });
  }
  if (isAuth(code, message, candidate.category)) {
    return new CommandError(
      {
        code,
        category: "auth",
        retryability: "after_auth",
        phase: "authentication",
        ...(requestId ? { requestId } : {}),
      },
      message,
      { cause: error },
    );
  }
  if (isUnavailable(code, message, candidate.category)) {
    return new CommandError(
      {
        code,
        category: "unavailable",
        retryability: "backoff",
        phase: "transport",
        ...(requestId ? { requestId } : {}),
      },
      message,
      { cause: error },
    );
  }
  return new CommandError(
    { code, category: "internal", retryability: "never", phase, ...(requestId ? { requestId } : {}) },
    message,
    { cause: error },
  );
}

function isAuth(code: string, message: string, category: unknown): boolean {
  return (
    category === "auth" ||
    category === "authentication" ||
    /^AUTH_/u.test(code) ||
    /not logged in|authentication/iu.test(message)
  );
}

function isUnavailable(code: string, message: string, category: unknown): boolean {
  return (
    category === "unavailable" ||
    category === "service-unavailable" ||
    category === "transient" ||
    code === "SERVICE_UNAVAILABLE" ||
    /(?:_UPSTREAM_)?UNAVAILABLE$/u.test(code) ||
    /unavailable|timed out|connection refused/iu.test(message)
  );
}

/** Present a result once. Human successes use stdout; all failures use redacted stderr. */
export function presentCommand<T>(
  result: CommandResult<T>,
  options: CommandPresentationOptions<T> = {},
): CommandExitCode {
  const stdout = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  if (result.ok) {
    const value = redactValue(result.value);
    const output = options.json
      ? JSON.stringify({ ok: true, result: value })
      : (options.formatValue ?? ((item) => formatHumanValue(item)))(value);
    writeOutputLine(stdout, output);
    return EXIT_CODES.success;
  }
  const error = result.error;
  if (isBrokenPipeError(error)) {
    return EXIT_CODES.success;
  }
  const output = formatFailureOutput(error, result.value, Boolean(options.json));
  if (writeOutputLine(stderr, output) === "epipe") {
    return EXIT_CODES.success;
  }
  return result.exitCode;
}

function writeOutputLine(writer: (chunk: string) => void, output: string): "written" | "epipe" {
  try {
    writer(`${output}\n`);
    return "written";
  } catch (error) {
    if (hasBrokenPipeCode(error)) {
      markOutputBrokenPipeError(error);
      return "epipe";
    }
    throw error;
  }
}

function formatFailureOutput<T>(error: CommandError, rawValue: T | undefined, json: boolean): string {
  const value = rawValue === undefined ? undefined : redactValue(rawValue);
  if (json) {
    return JSON.stringify({
      ok: false,
      error: {
        code: error.code,
        category: error.category,
        retryability: error.retryability,
        phase: error.phase,
        ...(error.requestId ? { requestId: error.requestId } : {}),
        message: error.message,
      },
      ...(value === undefined ? {} : { result: value }),
    });
  }
  return `${error.code}: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`;
}

export type CommandFailureObserver = (error: unknown, commandError: CommandError) => void;

let commandFailureObserver: CommandFailureObserver | undefined;

/**
 * Observe every failure the shared execution path handles. Commands present their own failures and
 * return an exit code, so a process-level concern such as error reporting cannot see them from the
 * entry point's catch; this is the one seam that does. Returns the function that detaches it.
 */
export function observeCommandFailures(observer: CommandFailureObserver): () => void {
  commandFailureObserver = observer;
  return () => {
    if (commandFailureObserver === observer) commandFailureObserver = undefined;
  };
}

/** Run an operation through the shared result and presentation path. */
export async function executeCommand<T>(
  operation: () => Promise<T>,
  options: CommandExecutionOptions<T> = {},
): Promise<CommandExitCode> {
  try {
    return presentCommand({ ok: true, value: await operation(), exitCode: EXIT_CODES.success }, options);
  } catch (error) {
    const commandError = toCommandError(error, options.phase);
    if (isBrokenPipeError(commandError)) {
      return presentCommand({ ok: false, error: commandError, exitCode: commandExitCode(commandError) }, options);
    }
    const structuredError = commandError.toStructuredError();
    (options.logger ?? createLogger("cli")).error(
      {
        event: "command.failure",
        error: structuredError,
        code: structuredError.code,
        category: structuredError.category,
        retryability: structuredError.retryability,
        phase: structuredError.phase,
        ...(structuredError.requestId ? { requestId: structuredError.requestId } : {}),
      },
      "CLI command failed",
    );
    const exitCode = presentCommand(
      { ok: false, error: commandError, exitCode: commandExitCode(commandError) },
      options,
    );
    try {
      commandFailureObserver?.(error, commandError);
    } catch {
      // An observer is a bystander; its failure must not change the answer already presented.
    }
    return exitCode;
  }
}

function mapApiError(error: OpenTagApiError): Omit<ConstructorParameters<typeof CommandError>[0], never> {
  switch (error.category) {
    case "credential":
      return {
        code: error.code,
        category: "auth",
        retryability: "after_auth",
        phase: "authentication",
        ...(error.requestId ? { requestId: error.requestId } : {}),
      };
    case "validation":
      return {
        code: error.code,
        category: "validation",
        retryability: "never",
        phase: "validation",
        ...(error.requestId ? { requestId: error.requestId } : {}),
      };
    case "rate_limit":
      return {
        code: error.code,
        category: "rate_limit",
        retryability: "backoff",
        phase: "request",
        ...(error.requestId ? { requestId: error.requestId } : {}),
      };
    case "transient":
      return {
        code: error.code,
        category: "unavailable",
        retryability: "backoff",
        phase: "transport",
        ...(error.requestId ? { requestId: error.requestId } : {}),
      };
    default:
      return {
        code: error.code,
        category: error.structuredError.category,
        retryability: error.structuredError.retryability,
        phase: error.structuredError.phase,
        ...(error.requestId ? { requestId: error.requestId } : {}),
      };
  }
}

function isRetryability(value: unknown): value is CommandRetryability {
  return value === "never" || value === "immediate" || value === "backoff" || value === "after_auth";
}

function isZodError(
  error: unknown,
): error is { issues: readonly { path: readonly (string | number)[]; message: string }[] } {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

export function commandExitCode(error: CommandError): CommandExitCode {
  if (isBrokenPipeError(error)) return EXIT_CODES.success;
  if (error.category === "validation") return EXIT_CODES.usage;
  if (error.category === "unavailable" || error.category === "timeout" || error.category === "dependency") {
    return EXIT_CODES.serviceUnavailable;
  }
  if (error.category === "cancelled") return EXIT_CODES.interrupted;
  return EXIT_CODES.failure;
}

function isInterrupted(error: unknown): boolean {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "CanceledError")) return true;
  return isAbortSignal(error);
}

function isAbortSignal(error: unknown): error is AbortSignal {
  return (
    error !== null &&
    typeof error === "object" &&
    "aborted" in error &&
    (error as { aborted?: unknown }).aborted === true &&
    typeof (error as { addEventListener?: unknown }).addEventListener === "function"
  );
}

function formatHumanValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "null";
}

function redactValue<T>(value: T): T {
  return redactSensitive(value);
}

/*
 * Presentation redaction delegates to the shared implementation.
 *
 * This module used to keep its own key-pattern list, which drifted: it matched `authorization` as a
 * substring, so MCP's credential-free authorization summary was replaced wholesale and the CLI
 * printed `authKind none` for a stored Bearer key. The shared redactor is the single source of truth
 * for what counts as sensitive, and its exemptions are exact names rather than substrings.
 */
export function redactSecrets(value: string): string {
  return redactSensitive(value);
}
