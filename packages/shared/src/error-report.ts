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
 * bounds what may cross the wire. No token or cookie field exists, and `url` never carries a query
 * string or fragment.
 *
 * The identifiers below are attribution, not authorization. The relay is anonymous, so every one of
 * them is chosen by the caller and a report that names an Account only says that whoever posted it
 * claimed to be that Account. Read them as a lead to follow, never as proof of who someone is.
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
    /** Correlates the forwarded tracker event with the server log line that holds the full context. */
    reportId: shortField.optional(),
    /** The Account this client believed it was signed in as; absent before sign-in. */
    userId: shortField.optional(),
    /** Web only: the matched route template, such as `/agents/:agentId`, which `url` cannot give. */
    route: shortField.optional(),
    /** CLI only: operating system, architecture, and runtime version. */
    platform: shortField.optional(),
    /** CLI only: the Computer this OpenTag home is bound to, when one is. */
    computerId: shortField.optional(),
    installationId: shortField.optional(),
    /** CLI only: present when the failure happened inside an Agent turn. */
    agentId: shortField.optional(),
    sessionId: shortField.optional(),
    turnId: shortField.optional(),
    /** CLI only: the Agent runtime provider, such as `claude-code`. */
    provider: shortField.optional(),
    /** Web only: an HTTP(S) document URL; query string, fragment, and credentials are stripped on parse. */
    url: z
      .string()
      .min(1)
      .max(ERROR_REPORT_URL_MAX_LENGTH)
      .transform((value, context) => {
        // Enforced where the report is accepted, not only where it is built: the client is untrusted.
        const sanitized = sanitizeErrorReportUrl(value);
        if (sanitized === undefined) {
          context.addIssue({ code: "custom", message: "Must be an HTTP(S) URL" });
          return z.NEVER;
        }
        return sanitized;
      })
      .optional(),
    /** CLI only: the command path without user arguments, such as `agent create`. */
    command: shortField.optional(),
    userAgent: shortField.optional(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ErrorReportSource = z.infer<typeof ErrorReportSourceSchema>;
export type ErrorReportRequest = z.infer<typeof ErrorReportRequestSchema>;

export type ErrorReportMetadata = Omit<ErrorReportRequest, "message" | "stack" | "code" | "occurredAt" | "url"> & {
  /** Any document URL; it is sanitized here and dropped when it is not HTTP(S). */
  url?: string;
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
 * Every metadata field that is carried through as a bounded, redacted string.
 *
 * Listed rather than spread one by one so that adding a diagnostic field is one entry here and one
 * entry in the schema, and so no field can be added to the schema and silently never sent.
 */
const SHORT_METADATA_FIELDS = [
  "agentId",
  "command",
  "computerId",
  "environment",
  "installationId",
  "platform",
  "provider",
  "reportId",
  "route",
  "sessionId",
  "turnId",
  "userAgent",
  "userId",
  "version",
] as const satisfies readonly (keyof ErrorReportMetadata)[];

/**
 * Build a relay request from a thrown value. Message and stack are redacted and bounded here so
 * every client sends the same shape, and optional metadata is dropped when it is empty or invalid
 * rather than making the whole report fail validation.
 */
export function createErrorReport(error: unknown, metadata: ErrorReportMetadata): ErrorReportRequest {
  const parts = errorParts(error);
  const code = metadata.code ?? parts.code;
  const url = metadata.url ? sanitizeErrorReportUrl(metadata.url) : undefined;
  const shortFields: Record<string, string> = {};
  for (const key of SHORT_METADATA_FIELDS) {
    const value = metadata[key];
    if (value) shortFields[key] = redactText(value, ERROR_REPORT_FIELD_MAX_LENGTH);
  }
  return {
    source: metadata.source,
    message: redactText(parts.message, ERROR_REPORT_MESSAGE_MAX_LENGTH),
    ...(parts.stack ? { stack: redactText(parts.stack, ERROR_REPORT_STACK_MAX_LENGTH) } : {}),
    ...(code && StructuredErrorCodeSchema.safeParse(code).success ? { code } : {}),
    ...(metadata.channel ? { channel: metadata.channel } : {}),
    ...(url ? { url } : {}),
    ...shortFields,
    occurredAt: metadata.occurredAt ?? new Date().toISOString(),
  };
}
