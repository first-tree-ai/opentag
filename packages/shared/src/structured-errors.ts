import { z } from "zod";

/** Maximum UTF-8 bytes allowed for a structured diagnostic message. */
export const STRUCTURED_ERROR_MESSAGE_MAX_BYTES = 2 * 1024;
/** Maximum UTF-8 bytes allowed for a diagnostic request identifier. */
export const STRUCTURED_ERROR_REQUEST_ID_MAX_BYTES = 256;
/** Maximum number of nested causes retained by the redaction and serialization helpers. */
export const STRUCTURED_ERROR_MAX_CAUSE_DEPTH = 8;
/** Maximum UTF-8 bytes emitted by {@link boundedSerialize}. */
export const BOUNDED_DIAGNOSTIC_SERIALIZATION_BYTES = 16 * 1024;
/** Maximum UTF-8 bytes allowed for each string value crossing a log boundary. */
export const STRUCTURED_ERROR_LOG_FIELD_MAX_BYTES = 4 * 1024;
export const STRUCTURED_ERROR_SERIALIZATION_MAX_DEPTH = 8;
export const STRUCTURED_ERROR_SERIALIZATION_MAX_KEYS = 64;
export const STRUCTURED_ERROR_SERIALIZATION_MAX_ARRAY_ITEMS = 32;

const diagnosticCodePattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;

export const StructuredErrorCodeSchema = z.string().regex(diagnosticCodePattern);

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

export const StructuredErrorMessageSchema = z.string().min(1).max(STRUCTURED_ERROR_MESSAGE_MAX_BYTES);

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
      code: StructuredErrorCodeSchema.optional(),
      category: StructuredErrorCategorySchema.optional(),
      retryability: ErrorRetryabilitySchema.optional(),
      phase: StructuredErrorPhaseSchema.optional(),
      message: StructuredErrorMessageSchema,
      cause: StructuredErrorCauseSchema.optional(),
    })
    .strict(),
);

export const StructuredErrorSchema = z
  .object({
    code: StructuredErrorCodeSchema,
    category: StructuredErrorCategorySchema,
    retryability: ErrorRetryabilitySchema,
    phase: StructuredErrorPhaseSchema,
    requestId: z.string().min(1).max(STRUCTURED_ERROR_REQUEST_ID_MAX_BYTES).optional(),
    message: StructuredErrorMessageSchema,
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

export const RetryabilitySchema = ErrorRetryabilitySchema;
export const ErrorPhaseSchema = StructuredErrorPhaseSchema;

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

const CREDENTIAL_HEADER_PATTERN =
  /\b(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*["']?[ \t]*[:=][ \t]*/giu;

function lineBreakStart(value: string, from: number): number {
  const carriageReturn = value.indexOf("\r", from);
  const lineFeed = value.indexOf("\n", from);
  if (carriageReturn === -1) return lineFeed;
  if (lineFeed === -1) return carriageReturn;
  return Math.min(carriageReturn, lineFeed);
}

function lineBreakEnd(value: string, start: number): number {
  if (value[start] === "\r" && value[start + 1] === "\n") return start + 2;
  return start + 1;
}

function headerNameColonAt(value: string, from: number): boolean {
  let cursor = from;
  while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
  const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+[ \t]*:/u;
  return headerName.test(value.slice(cursor));
}

function lineStart(value: string, from: number): number {
  const carriageReturn = value.lastIndexOf("\r", from - 1);
  const lineFeed = value.lastIndexOf("\n", from - 1);
  return Math.max(carriageReturn, lineFeed) + 1;
}

function isLineAnchoredCredentialHeader(value: string, offset: number): boolean {
  const start = lineStart(value, offset);
  if (offset === start) return true;
  let cursor = start;
  while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
  return cursor === offset && headerNameColonAt(value, offset);
}

function credentialHeaderValueEnd(value: string, from: number): number {
  let cursor = from;
  while (true) {
    const breakStart = lineBreakStart(value, cursor);
    if (breakStart === -1) return value.length;
    const breakEnd = lineBreakEnd(value, breakStart);
    if (value[breakEnd] !== " " && value[breakEnd] !== "\t") return breakStart;
    if (headerNameColonAt(value, breakEnd)) return breakStart;
    cursor = breakEnd;
  }
}

type CredentialQuote = '"' | "'";

function isCredentialQuote(character: string | undefined): character is CredentialQuote {
  return character === '"' || character === "'";
}

function isApostrophe(value: string, position: number, character: string): boolean {
  return (
    character === "'" &&
    /[A-Za-z0-9]/u.test(value[position - 1] ?? "") &&
    /[A-Za-z0-9]/u.test(value[position + 1] ?? "")
  );
}

function advanceEnclosingQuote(
  value: string,
  position: number,
  quote: CredentialQuote | undefined,
  character: string,
): CredentialQuote | undefined {
  if (character === "\r" || character === "\n") return undefined;
  if (quote === undefined) {
    if (!isCredentialQuote(character) || isApostrophe(value, position, character)) return undefined;
    return character;
  }
  return quote === character ? undefined : quote;
}

function enclosingQuoteAt(value: string, position: number): CredentialQuote | undefined {
  let quote: CredentialQuote | undefined;
  for (let cursor = 0; cursor < position; cursor += 1) {
    const character = value[cursor] ?? "";
    if (character === "\\") {
      cursor += 1;
      continue;
    }
    quote = advanceEnclosingQuote(value, cursor, quote, character);
  }
  return quote;
}

function inlineQuotedCredentialValueEnd(value: string, from: number, quote: CredentialQuote): number {
  for (let cursor = from + 1; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (character === "\\") {
      cursor += 1;
      continue;
    }
    if (character === quote) return cursor + 1;
    if (character === "\r" || character === "\n") return cursor;
  }
  return value.length;
}

function enclosingQuotedCredentialValueEnd(value: string, from: number, quote: CredentialQuote): number {
  for (let cursor = from; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (character === "\\") {
      cursor += 1;
      continue;
    }
    if (character === quote) return cursor;
    if (character === "\r" || character === "\n") return cursor;
  }
  return value.length;
}

function inlineUnquotedCredentialValueEnd(value: string, from: number): number {
  for (let cursor = from; cursor < value.length; cursor += 1) {
    if (",;}\"'\r\n".includes(value[cursor] ?? "")) return cursor;
  }
  return value.length;
}

type StructuralScanState = {
  depth: number;
  quote?: CredentialQuote;
  escaped?: boolean;
};

function advanceStructuralScan(state: StructuralScanState, character: string, opener: string, closer: string): boolean {
  if (state.quote !== undefined) {
    if (state.escaped) {
      state.escaped = false;
    } else if (character === "\\") {
      state.escaped = true;
    } else if (character === state.quote) {
      state.quote = undefined;
    }
    return false;
  }
  if (isCredentialQuote(character)) {
    state.quote = character;
  } else if (character === opener) {
    state.depth += 1;
  } else if (character === closer) {
    state.depth -= 1;
  }
  return state.depth === 0;
}

function structuralCredentialValueEnd(value: string, from: number): number {
  const opener = value[from];
  if (opener !== "[") return from;
  const closer = "]";
  const state: StructuralScanState = { depth: 0 };
  for (let cursor = from; cursor < value.length; cursor += 1) {
    if (advanceStructuralScan(state, value[cursor] ?? "", opener, closer)) return cursor + 1;
  }
  return value.length;
}

function inlineCredentialValueEnd(
  value: string,
  from: number,
  enclosingQuote: CredentialQuote | undefined,
): { end: number; replacement: string } {
  const openingQuote = value[from];
  if (isCredentialQuote(openingQuote)) {
    const end = inlineQuotedCredentialValueEnd(value, from, openingQuote);
    return { end, replacement: `${openingQuote}${REDACTED}${openingQuote}` };
  }
  if (openingQuote === "[") {
    return { end: structuralCredentialValueEnd(value, from), replacement: `"${REDACTED}"` };
  }
  if (enclosingQuote !== undefined) {
    const end = enclosingQuotedCredentialValueEnd(value, from, enclosingQuote);
    return { end, replacement: REDACTED };
  }
  return { end: inlineUnquotedCredentialValueEnd(value, from), replacement: REDACTED };
}

/*
 * Consume a credential header through the end of its line and any RFC 7230 obs-fold continuation.
 * A non-folded line break is left intact so the next genuine header remains visible. Inline matches
 * stop at the delimiter for their surrounding JSON-ish or list value so sibling fields remain intact.
 */
function scrubCredentialHeaders(value: string): string {
  let output = "";
  let cursor = 0;
  CREDENTIAL_HEADER_PATTERN.lastIndex = 0;
  for (let match = CREDENTIAL_HEADER_PATTERN.exec(value); match; match = CREDENTIAL_HEADER_PATTERN.exec(value)) {
    const offset = match.index;
    const lineAnchored = isLineAnchoredCredentialHeader(value, offset);
    const valueStart = offset + match[0].length;
    const valueEnd = lineAnchored
      ? { end: credentialHeaderValueEnd(value, valueStart), replacement: REDACTED }
      : inlineCredentialValueEnd(value, valueStart, enclosingQuoteAt(value, offset));
    output += value.slice(cursor, offset);
    output += `${match[0]}${valueEnd.replacement}`;
    cursor = valueEnd.end;
    CREDENTIAL_HEADER_PATTERN.lastIndex = cursor;
  }
  return output + value.slice(cursor);
}

function scrubString(value: string): string {
  return scrubCredentialHeaders(
    value
      .replace(/\bBearer\s+[^\s,;}\]]+/giu, "Bearer [REDACTED]")
      .replace(/\b(Basic|Digest|Negotiate)\s+[^\s,;}\]]+/giu, "$1 [REDACTED]")
      .replace(
        /([?&](?:access_token|refresh_token|client_secret|token|secret|password|api[_-]?key)=)[^&#\s]+/giu,
        "$1[REDACTED]",
      )
      .replace(/(\b(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*)[^\s,;}\]]+/giu, "$1[REDACTED]")
      .replace(/(postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1[REDACTED]@"),
  );
}

function redactErrorValue(value: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const error = value as Error & { code?: unknown; cause?: unknown };
  const output: Record<string, unknown> = {
    name: scrubString(error.name),
    message: scrubString(error.message),
  };
  if (typeof error.code === "string") output.code = scrubString(error.code);
  if (error.cause !== undefined) output.cause = redactValue(error.cause, seen, depth + 1);
  return output;
}

function redactArray(value: unknown[], seen: WeakSet<object>, depth: number): unknown[] {
  return value
    .slice(0, STRUCTURED_ERROR_SERIALIZATION_MAX_ARRAY_ITEMS)
    .map((item) => redactValue(item, seen, depth + 1));
}

function redactObject(value: object, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, STRUCTURED_ERROR_SERIALIZATION_MAX_KEYS)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactValue(child, seen, depth + 1);
  }
  return output;
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
  if (value instanceof Error) return redactErrorValue(value, seen, depth);
  if (Array.isArray(value)) return redactArray(value, seen, depth);
  return redactObject(value, seen, depth);
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
  if (maxBytes <= utf8ByteLength(suffix)) {
    let output = "";
    for (const character of value) {
      if (utf8ByteLength(output + character) > maxBytes) break;
      output += character;
    }
    return output;
  }
  const available = Math.max(0, maxBytes - utf8ByteLength(suffix));
  let output = "";
  for (const character of value) {
    if (utf8ByteLength(output + character) > available) break;
    output += character;
  }
  return output + suffix;
}

function capLogStringValues(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return truncateUtf8(value, STRUCTURED_ERROR_LOG_FIELD_MAX_BYTES);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => capLogStringValues(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) output[key] = capLogStringValues(child, seen);
  return output;
}

/** Return a detached, recursively redacted copy with a UTF-8 cap on every string value. */
export function redactForLog<T>(value: T): T {
  return capLogStringValues(redactSensitive(value), new WeakSet<object>()) as T;
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
