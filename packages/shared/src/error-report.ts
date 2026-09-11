import { z } from "zod";
import { ChannelNameSchema } from "./channel-name.js";
import { redactSensitive, StructuredErrorCodeSchema } from "./structured-errors.js";

/** Maximum length of the redacted error message accepted by the relay. */
export const ERROR_REPORT_MESSAGE_MAX_LENGTH = 4 * 1024;
/** Maximum length of the redacted stack trace accepted by the relay. */
export const ERROR_REPORT_STACK_MAX_LENGTH = 16 * 1024;
/** Maximum length of every other free-form field (version, command, user agent, ...). */
export const ERROR_REPORT_FIELD_MAX_LENGTH = 512;
/** Maximum length of the query-free page URL a web report may carry. */
export const ERROR_REPORT_URL_MAX_LENGTH = 2 * 1024;

const TRUNCATED_SUFFIX = "...[TRUNCATED]";

export const ErrorReportSourceSchema = z.enum(["web", "cli"]);

const shortField = z.string().min(1).max(ERROR_REPORT_FIELD_MAX_LENGTH);

/**
 * One client-side failure relayed to the server for forwarding to an error tracker.
 *
 * The client redacts before sending and the server redacts again before forwarding; the schema only
 * bounds what may cross the wire. It is deliberately anonymous: no account, token, or cookie field
 * exists, and `url` never carries a query string or fragment.
 */
export const ErrorReportRequestSchema = z
  .object({
    source: ErrorReportSourceSchema,
    message: z.string().min(1).max(ERROR_REPORT_MESSAGE_MAX_LENGTH),
    stack: z.string().min(1).max(ERROR_REPORT_STACK_MAX_LENGTH).optional(),
    code: StructuredErrorCodeSchema.optional(),
    version: shortField.optional(),
    channel: ChannelNameSchema.optional(),
    environment: shortField.optional(),
    /** Web only: the document URL without query string or fragment. */
    url: z.string().min(1).max(ERROR_REPORT_URL_MAX_LENGTH).optional(),
    /** CLI only: the command path without user arguments, such as `agent create`. */
    command: shortField.optional(),
    userAgent: shortField.optional(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ErrorReportSource = z.infer<typeof ErrorReportSourceSchema>;
export type ErrorReportRequest = z.infer<typeof ErrorReportRequestSchema>;

export type ErrorReportMetadata = Omit<ErrorReportRequest, "message" | "stack" | "code" | "occurredAt"> & {
  code?: string;
  occurredAt?: string;
};

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - TRUNCATED_SUFFIX.length))}${TRUNCATED_SUFFIX}`;
}

function redactText(value: string, maxLength: number): string {
  return truncate(redactSensitive(value), maxLength);
}

/** Drop everything from a URL that can carry a secret or a per-user value: query, fragment, and credentials. */
export function sanitizeErrorReportUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return truncate(url.toString(), ERROR_REPORT_URL_MAX_LENGTH);
  } catch {
    return undefined;
  }
}

type ErrorLike = { message?: unknown; name?: unknown; stack?: unknown; code?: unknown };

function isErrorLike(value: unknown): value is ErrorLike {
  return value instanceof Error || (typeof value === "object" && value !== null && "message" in value);
}

/** Read an `Error`, a `DOMException`, or any `{ message, stack?, code? }` object the same way. */
function errorParts(error: unknown): { message: string; stack?: string; code?: string } {
  if (isErrorLike(error)) {
    const message = typeof error.message === "string" ? error.message : "";
    const name = typeof error.name === "string" ? error.name : "";
    return {
      message: message || name || "Unknown error",
      ...(typeof error.stack === "string" && error.stack.length > 0 ? { stack: error.stack } : {}),
      ...(typeof error.code === "string" ? { code: error.code } : {}),
    };
  }
  if (typeof error === "string" && error.length > 0) return { message: error };
  return { message: "Unknown error" };
}

/**
 * Build a relay request from a thrown value. Message and stack are redacted and bounded here so
 * every client sends the same shape, and optional metadata is dropped when it is empty or invalid
 * rather than making the whole report fail validation.
 */
export function createErrorReport(error: unknown, metadata: ErrorReportMetadata): ErrorReportRequest {
  const parts = errorParts(error);
  const code = metadata.code ?? parts.code;
  const url = metadata.url ? sanitizeErrorReportUrl(metadata.url) : undefined;
  return {
    source: metadata.source,
    message: redactText(parts.message, ERROR_REPORT_MESSAGE_MAX_LENGTH),
    ...(parts.stack ? { stack: redactText(parts.stack, ERROR_REPORT_STACK_MAX_LENGTH) } : {}),
    ...(code && StructuredErrorCodeSchema.safeParse(code).success ? { code } : {}),
    ...optionalField("version", metadata.version),
    ...(metadata.channel ? { channel: metadata.channel } : {}),
    ...optionalField("environment", metadata.environment),
    ...(url ? { url } : {}),
    ...optionalField("command", metadata.command),
    ...optionalField("userAgent", metadata.userAgent),
    occurredAt: metadata.occurredAt ?? new Date().toISOString(),
  };
}

function optionalField<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  if (!value) return {};
  return { [key]: redactText(value, ERROR_REPORT_FIELD_MAX_LENGTH) } as Record<K, string>;
}
