import {
  type Attributes,
  type Context,
  context,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

const TRACER_NAME = "@opentag/server";
const TRACER_VERSION = "0.1.0";
const MAX_ATTRIBUTE_LENGTH = 512;
const SENSITIVE_KEY_PARTS = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "credential",
  "password",
  "apikey",
  "api_key",
  "content",
  "body",
  "payload",
  "prompt",
  "output",
  "tool_input",
  "tool_output",
  "text",
  "emoji",
  "mention",
  "resource",
  "sender",
  "author",
  "display_name",
];

/*
 * Slack issues prefix-recognizable credentials: bot/user/legacy tokens are `xox<letter>-` and
 * app-level tokens are `xapp-`. `services/auth/security.ts` keeps an intentionally independent copy for
 * the startup log path, so removing one sink never silently disables the other.
 */
const SLACK_TOKEN_PATTERN = /\b(?:xox[a-z]|xapp)-[\w-]*/gi;

/*
 * Labelled credential values. Both `secret`-style words and the camelCase field names the Slack and
 * Feishu binding records use are covered, because a word boundary alone never matches the `Secret` in
 * `signingSecret`.
 */
const CREDENTIAL_FIELD_PATTERN =
  /\b(authorization|cookie|token|secret|credential|password|api[_-]?key|signing[_-]?secret|bot[_-]?access[_-]?token|app[_-]?secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]+/gi;

export function getServerTracer() {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll("-", "_");
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

/**
 * Removes recognizable credential material from a telemetry string and bounds its length. Exported so
 * the export-boundary processor can apply the same rules to span status messages and event names that
 * never passed through the helpers below.
 */
export function sanitizeTelemetryString(value: string): string {
  return sanitizeString(value);
}

function sanitizeString(value: string): string {
  const scrubbed = value
    .replace(SLACK_TOKEN_PATTERN, "[scrubbed]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [scrubbed]")
    .replace(CREDENTIAL_FIELD_PATTERN, "$1=[scrubbed]");
  return scrubbed.length <= MAX_ATTRIBUTE_LENGTH
    ? scrubbed
    : `${scrubbed.slice(0, MAX_ATTRIBUTE_LENGTH)}...[truncated]`;
}

function sanitizeJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value !== "object") return sanitizeString(String(value));
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeJsonValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 64)) {
    output[key] = isSensitiveKey(key) ? "[scrubbed]" : sanitizeJsonValue(child, seen);
  }
  return output;
}

export function normalizeTelemetryAttrs(attrs?: Record<string, unknown>): Attributes {
  const output: Attributes = {};
  if (!attrs) return output;
  try {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      if (isSensitiveKey(key)) {
        output[key] = "[scrubbed]";
      } else if (typeof value === "string") {
        output[key] = sanitizeString(value);
      } else if (typeof value === "number" || typeof value === "boolean") {
        output[key] = value;
      } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        output[key] = value.slice(0, 32).map((item) => sanitizeString(item));
      } else {
        output[key] = sanitizeString(JSON.stringify(sanitizeJsonValue(value, new WeakSet())));
      }
    }
  } catch {
    return output;
  }
  return output;
}

function recordSpanError(span: Span): void {
  try {
    const code = "INTERNAL_ERROR";
    span.recordException({ name: "OpenTagOperationError", message: code });
    span.setStatus({ code: SpanStatusCode.ERROR, message: code });
  } catch {
    // Telemetry must never replace the original business failure.
  }
}

function runWithSpan<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  parentContext: Context,
  fn: () => Promise<T> | T,
): Promise<T> {
  return getServerTracer().startActiveSpan(
    name,
    { attributes: normalizeTelemetryAttrs(attrs) },
    parentContext,
    async (span) => {
      try {
        return await fn();
      } catch (error) {
        recordSpanError(span);
        throw error;
      } finally {
        try {
          span.end();
        } catch {
          // Exporter failures are outside the business path.
        }
      }
    },
  );
}

export function withSpan<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  return runWithSpan(name, attrs, context.active(), fn);
}

export function withRootSpan<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  return runWithSpan(name, attrs, ROOT_CONTEXT, fn);
}

export function tracePromise<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  create: () => Promise<T>,
  resultAttrs?: (result: T) => Record<string, unknown> | undefined,
  errorAttrs?: (error: unknown) => Record<string, unknown> | undefined,
): Promise<T> {
  return getServerTracer().startActiveSpan(name, { attributes: normalizeTelemetryAttrs(attrs) }, (span) => {
    let promise: Promise<T>;
    try {
      promise = create();
    } catch (error) {
      setSpanErrorAttributes(span, error, errorAttrs);
      recordSpanError(span);
      span.end();
      throw error;
    }
    return promise.then(
      (result) => {
        try {
          const extra = resultAttrs?.(result);
          if (extra) span.setAttributes(normalizeTelemetryAttrs(extra));
        } finally {
          span.end();
        }
        return result;
      },
      (error: unknown) => {
        setSpanErrorAttributes(span, error, errorAttrs);
        recordSpanError(span);
        span.end();
        throw error;
      },
    );
  });
}

function setSpanErrorAttributes(
  span: Span,
  error: unknown,
  errorAttrs?: (error: unknown) => Record<string, unknown> | undefined,
): void {
  try {
    const attrs = errorAttrs?.(error);
    if (attrs) span.setAttributes(normalizeTelemetryAttrs(attrs));
  } catch {
    // Error classification is observational and never replaces the failure.
  }
}

export function emitRootSpan(name: string, attrs?: Record<string, unknown>, error?: Error): void {
  try {
    const span = getServerTracer().startSpan(name, { attributes: normalizeTelemetryAttrs(attrs) }, ROOT_CONTEXT);
    if (error) recordSpanError(span);
    span.end();
  } catch {
    // Diagnostics are best-effort and never affect the caller.
  }
}

export function startTrackedSpan(
  name: string,
  attrs?: Record<string, unknown>,
  options?: { kind?: SpanKind; parentContext?: Context },
): Span {
  return getServerTracer().startSpan(
    name,
    { kind: options?.kind, attributes: normalizeTelemetryAttrs(attrs) },
    options?.parentContext ?? context.active(),
  );
}

export function endSpan(span: Span | undefined, attrs?: Record<string, unknown>, error?: Error): void {
  if (!span) return;
  try {
    if (attrs) span.setAttributes(normalizeTelemetryAttrs(attrs));
    if (error) recordSpanError(span);
    span.end();
  } catch {
    // Telemetry must not affect transport shutdown.
  }
}

export function setActiveSpanAttributes(attrs: Record<string, unknown>): void {
  try {
    trace.getActiveSpan()?.setAttributes(normalizeTelemetryAttrs(attrs));
  } catch {
    // Attribute enrichment is best-effort.
  }
}

export function currentTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext?.traceId || spanContext.traceId === "00000000000000000000000000000000") return undefined;
  return spanContext.traceId;
}

export { context, SpanKind, SpanStatusCode, trace };
