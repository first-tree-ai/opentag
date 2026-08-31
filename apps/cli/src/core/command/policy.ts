import { OpenTagApiError } from "@opentag/client";

/** Process exit values shared by every user-facing CLI command. */
export const EXIT_CODES = {
  success: 0,
  failure: 1,
  usage: 2,
  serviceUnavailable: 3,
  interrupted: 130,
} as const;

export type CommandExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
export type CommandErrorCategory =
  | "validation"
  | "auth"
  | "authorization"
  | "unavailable"
  | "timeout"
  | "internal"
  | "conflict"
  | "not_found"
  | "rate_limit"
  | "protocol"
  | "configuration"
  | "cancelled"
  | "dependency";
export type CommandRetryability = "never" | "immediate" | "backoff" | "after_auth";
export type CommandPhase =
  | "validation"
  | "authentication"
  | "authorization"
  | "configuration"
  | "startup"
  | "request"
  | "transport"
  | "provider"
  | "persistence"
  | "dispatch"
  | "socket"
  | "scheduler"
  | "worker"
  | "serialization"
  | "shutdown"
  | "unknown";

/** Structured, transport-neutral CLI failure metadata. The Error message is the human detail. */
export class CommandError extends Error {
  readonly code: string;
  readonly category: CommandErrorCategory;
  readonly retryability: CommandRetryability;
  readonly phase: CommandPhase;
  readonly requestId?: string;

  constructor(
    fields: {
      code: string;
      category: CommandErrorCategory;
      retryability: CommandRetryability;
      phase: CommandPhase;
      requestId?: string;
    },
    message: string,
    options?: ErrorOptions,
  ) {
    super(redactSecrets(message), options);
    this.name = "CommandError";
    this.code = fields.code;
    this.category = fields.category;
    this.retryability = fields.retryability;
    this.phase = fields.phase;
    if (fields.requestId) this.requestId = fields.requestId;
  }
}

export type CommandResult<T> =
  | { ok: true; value: T; exitCode: typeof EXIT_CODES.success }
  | { ok: false; error: CommandError; exitCode: Exclude<CommandExitCode, typeof EXIT_CODES.success> };

export interface CommandPresentationOptions<T> {
  json?: boolean;
  formatValue?: (value: T) => string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
}

/** Convert errors from Commander, Zod, the API, and Node into one local contract. */
export function toCommandError(error: unknown, phase: CommandPhase = "unknown"): CommandError {
  if (error instanceof CommandError) return error;
  if (isInterrupted(error)) {
    return new CommandError(
      { code: "INTERRUPTED", category: "cancelled", retryability: "never", phase: "shutdown" },
      "The operation was interrupted",
      { cause: error },
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
  return category === "auth" || /^AUTH_/u.test(code) || /not logged in|authentication/iu.test(message);
}

function isUnavailable(code: string, message: string, category: unknown): boolean {
  return (
    category === "unavailable" ||
    code === "SERVICE_UNAVAILABLE" ||
    /(?:_UPSTREAM_)?UNAVAILABLE$/u.test(code) ||
    /service unavailable|timed out|connection refused/iu.test(message)
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
    : `${error.code}: ${error.message}`;
  stderr(`${output}\n`);
  return result.exitCode;
}

/** Run an operation through the shared result and presentation path. */
export async function executeCommand<T>(
  operation: () => Promise<T>,
  options: CommandPresentationOptions<T> & { phase?: CommandPhase } = {},
): Promise<CommandExitCode> {
  try {
    return presentCommand({ ok: true, value: await operation(), exitCode: EXIT_CODES.success }, options);
  } catch (error) {
    const commandError = toCommandError(error, options.phase);
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
      return { code: error.code, category: "auth", retryability: "after_auth", phase: "authentication" };
    case "validation":
      return { code: error.code, category: "validation", retryability: "never", phase: "validation" };
    case "rate_limit":
      return { code: error.code, category: "rate_limit", retryability: "backoff", phase: "request" };
    case "transient":
      return { code: error.code, category: "unavailable", retryability: "backoff", phase: "transport" };
    default:
      return { code: error.code, category: "internal", retryability: "never", phase: "request" };
  }
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
  const message = error instanceof Error ? error.message : String(error);
  return /(?:^|\b)(?:aborted|abort|cancelled|canceled|interrupted)(?:\b|$)/iu.test(message);
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

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|cookie|token|secret|credential|password|passwd|api[_-]?key|private[_-]?key|request[_-]?body|response[_-]?body|payload|prompt)/iu.test(
    key,
  );
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;}\]]+/giu, "Bearer [REDACTED]")
    .replace(/(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]")
    .replace(
      /([?&](?:access_token|refresh_token|client_secret|token|secret|password|api[_-]?key)=)[^&#\s]+/giu,
      "$1[REDACTED]",
    )
    .replace(/(\b(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*)[^\s,;}\]]+/giu, "$1[REDACTED]")
    .replace(/(postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1[REDACTED]@");
}
