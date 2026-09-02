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
type FailureCommandResultBase = { ok: false; error: CommandError };
type FailureCommandResult = FailureCommandResultBase & { exitCode: Exclude<CommandExitCode, 0> };
export type CommandResult<T> = SuccessCommandResult<T> | FailureCommandResult;
type CommandFormatValueOptions<T> = { formatValue?: (value: T) => string };
type CommandFormatWriterOptions = { stdout?: (chunk: string) => void; stderr?: (chunk: string) => void };
type CommandFormatOptions<T> = CommandFormatValueOptions<T> & CommandFormatWriterOptions;
export type CommandPresentationOptions<T> = { json?: boolean } & CommandFormatOptions<T>;
export type CommandExecutionOptions<T> = CommandPresentationOptions<T> & {
  logger?: ClientLogger;
  phase?: CommandPhase;
};

/** Convert errors from Commander, Zod, the API, and Node into one local contract. */
export function toCommandError(error: unknown, phase: CommandPhase = "unknown"): CommandError {
  if (error instanceof CommandError) return error;
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
    stdout(`${output}\n`);
    return EXIT_CODES.success;
  }
  const error = result.error;
  const output = options.json
    ? JSON.stringify({
        ok: false,
        error: {
          code: error.code,
          category: error.category,
          retryability: error.retryability,
          phase: error.phase,
          ...(error.requestId ? { requestId: error.requestId } : {}),
          message: error.message,
        },
      })
    : `${error.code}: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`;
  stderr(`${output}\n`);
  return result.exitCode;
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
    return presentCommand(
      {
        ok: false,
        error: commandError,
        exitCode: commandExitCode(commandError),
      },
      options,
    );
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

export function commandExitCode(error: CommandError): Exclude<CommandExitCode, typeof EXIT_CODES.success> {
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
  return redactUnknown(value, new WeakSet<object>()) as T;
}

function redactUnknown(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value !== "object") return `[${typeof value}]`;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => redactUnknown(entry, seen));
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 64)) {
    output[key] = isSensitiveKey(key) ? "[REDACTED]" : redactUnknown(child, seen);
  }
  return output;
}

const SENSITIVE_KEY_PATTERNS = [
  /(?:authorization|cookie|token|secret|credential|password|passwd)/iu,
  /(?:api[_-]?key|private[_-]?key|request[_-]?body|response[_-]?body|payload|prompt)/iu,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function redactSecrets(value: string): string {
  return redactSensitive(value);
}
