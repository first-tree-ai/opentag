import { z } from "zod";

/** Maximum UTF-8 bytes allowed for a structured diagnostic message. */
export const STRUCTURED_ERROR_MESSAGE_MAX_BYTES = 2 * 1024;
/** Maximum UTF-8 bytes allowed for a diagnostic request identifier. */
export const STRUCTURED_ERROR_REQUEST_ID_MAX_BYTES = 256;
/** Maximum number of nested causes retained by the redaction and serialization helpers. */
export const STRUCTURED_ERROR_MAX_CAUSE_DEPTH = 8;
/** Maximum UTF-8 bytes emitted by {@link boundedSerialize}. */
export const BOUNDED_DIAGNOSTIC_SERIALIZATION_BYTES = 16 * 1024;
export const STRUCTURED_ERROR_SERIALIZATION_MAX_DEPTH = 8;
export const STRUCTURED_ERROR_SERIALIZATION_MAX_KEYS = 64;
export const STRUCTURED_ERROR_SERIALIZATION_MAX_ARRAY_ITEMS = 32;

const diagnosticCodePattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;

/** The stable high-level class used for operational routing and dashboards. */
export const StructuredErrorCategorySchema = z.enum([
  "validation",
  "auth",
  "authorization",
  "unavailable",
  "timeout",
  "internal",
  "conflict",
  "not_found",
  "rate_limit",
  "protocol",
  "configuration",
  "cancelled",
  "dependency",
]);

/** The safe retry policy for a failure. Retries must still respect operation idempotency. */
export const ErrorRetryabilitySchema = z.enum(["never", "immediate", "backoff", "after_auth"]);

/** The lifecycle boundary at which an error was observed. */
export const StructuredErrorPhaseSchema = z.enum([
  "validation",
  "authentication",
  "authorization",
  "configuration",
  "startup",
  "request",
  "transport",
  "provider",
  "persistence",
  "dispatch",
  "socket",
  "scheduler",
  "worker",
  "serialization",
  "shutdown",
  "unknown",
]);

const diagnosticMessageSchema = z.string().min(1).max(STRUCTURED_ERROR_MESSAGE_MAX_BYTES);

type StructuredErrorCauseInput = {
  code?: string;
  category?: StructuredErrorCategory;
  retryability?: ErrorRetryability;
  phase?: StructuredErrorPhase;
  message: string;
  cause?: StructuredErrorCauseInput;
};

/** A recursively nested, deliberately small representation of a root cause. */
export const StructuredErrorCauseSchema: z.ZodType<StructuredErrorCauseInput> = z.lazy(() =>
  z
    .object({
      code: z.string().regex(diagnosticCodePattern).optional(),
      category: StructuredErrorCategorySchema.optional(),
      retryability: ErrorRetryabilitySchema.optional(),
      phase: StructuredErrorPhaseSchema.optional(),
      message: diagnosticMessageSchema,
      cause: StructuredErrorCauseSchema.optional(),
    })
    .strict(),
);

export const StructuredErrorSchema = z
  .object({
    code: z.string().regex(diagnosticCodePattern),
    category: StructuredErrorCategorySchema,
    retryability: ErrorRetryabilitySchema,
    phase: StructuredErrorPhaseSchema,
    requestId: z.string().min(1).max(STRUCTURED_ERROR_REQUEST_ID_MAX_BYTES).optional(),
    message: diagnosticMessageSchema,
    cause: StructuredErrorCauseSchema.optional(),
  })
  .strict();

/** A transport-neutral event envelope for logs, counters, and traces. */
export const DiagnosticEventSchema = z
  .object({
    type: z.literal("diagnostic.error"),
    occurredAt: z.string().datetime({ offset: true }),
    error: StructuredErrorSchema,
  })
  .strict();

export type StructuredErrorCategory = z.infer<typeof StructuredErrorCategorySchema>;
export type ErrorRetryability = z.infer<typeof ErrorRetryabilitySchema>;
export type StructuredErrorPhase = z.infer<typeof StructuredErrorPhaseSchema>;
export type StructuredErrorCause = z.infer<typeof StructuredErrorCauseSchema>;
export type StructuredError = z.infer<typeof StructuredErrorSchema>;
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;

const REDACTED = "[REDACTED]";
const CIRCULAR = "[CIRCULAR]";
const TRUNCATED = "[TRUNCATED]";
const UNSERIALIZABLE = "[UNSERIALIZABLE]";

// Match field names, not values. String values are scrubbed separately below.
const SENSITIVE_KEY_PARTS = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "credential",
  "password",
  "passwd",
  "api_key",
  "apikey",
  "access_key",
  "refresh_key",
  "private_key",
  "request_body",
  "response_body",
  "body",
  "payload",
  "prompt",
  "tool_input",
  "tool_output",
];

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll("-", "_");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function scrubString(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;}\]]+/giu, "Bearer [REDACTED]")
    .replace(/\b(Basic|Digest|Negotiate)\s+[^\s,;}\]]+/giu, "$1 [REDACTED]")
    .replace(/(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]")
    .replace(
      /([?&](?:access_token|refresh_token|client_secret|token|secret|password|api[_-]?key)=)[^&#\s]+/giu,
      "$1[REDACTED]",
    )
    .replace(/(\b(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*)[^\s,;}\]]+/giu, "$1[REDACTED]")
    .replace(/(postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1[REDACTED]@");
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (depth >= STRUCTURED_ERROR_SERIALIZATION_MAX_DEPTH) return TRUNCATED;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; cause?: unknown };
    const output: Record<string, unknown> = {
      name: scrubString(error.name),
      message: scrubString(error.message),
    };
    if (typeof error.code === "string") output.code = scrubString(error.code);
    if (error.cause !== undefined) output.cause = redactValue(error.cause, seen, depth + 1);
    return output;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, STRUCTURED_ERROR_SERIALIZATION_MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, seen, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, STRUCTURED_ERROR_SERIALIZATION_MAX_KEYS)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactValue(child, seen, depth + 1);
  }
  return output;
}

/** Return a detached, recursively redacted copy. The input object is never mutated. */
export function redactSensitive<T>(value: T): T {
  return redactValue(value, new WeakSet<object>(), 0) as T;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(value) <= maxBytes) return value;
  const suffix = `...${TRUNCATED}`;
  const available = Math.max(0, maxBytes - utf8ByteLength(suffix));
  let output = "";
  for (const character of value) {
    if (utf8ByteLength(output + character) > available) break;
    output += character;
  }
  return output + suffix;
}

/**
 * Redact and JSON-serialize an arbitrary diagnostic payload within a fixed UTF-8 byte budget.
 * The result is always a string and may be a valid JSON truncation envelope when it exceeds the budget.
 */
export function boundedSerialize(value: unknown, maxBytes = BOUNDED_DIAGNOSTIC_SERIALIZATION_BYTES): string {
  const budget = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : BOUNDED_DIAGNOSTIC_SERIALIZATION_BYTES;
  let serialized: string;
  try {
    serialized = JSON.stringify(redactSensitive(value)) ?? "null";
  } catch {
    serialized = JSON.stringify(UNSERIALIZABLE);
  }
  if (utf8ByteLength(serialized) <= budget) return serialized;

  const prefix = '{"truncated":true,"preview":';
  const suffix = "}";
  const available = Math.max(0, budget - utf8ByteLength(prefix) - utf8ByteLength(suffix) - 2);
  const preview = truncateUtf8(serialized, available);
  let result = `${prefix}${JSON.stringify(preview)}${suffix}`;
  while (utf8ByteLength(result) > budget && preview.length > 0) {
    const shorter = truncateUtf8(preview, Math.max(0, utf8ByteLength(preview) - 8));
    if (shorter === preview) break;
    result = `${prefix}${JSON.stringify(shorter)}${suffix}`;
  }
  return utf8ByteLength(result) <= budget ? result : truncateUtf8(result, budget);
}

// Descriptive aliases make the intended use at call sites obvious while keeping one implementation.
export const redactDiagnostic = redactSensitive;
export const serializeDiagnostic = boundedSerialize;
