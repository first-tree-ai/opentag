import { redactForLog } from "@opentag/shared";

export type CloudRunAdminErrorKind =
  | "not_found"
  | "conflict"
  | "invalid"
  | "unavailable"
  | "credential"
  | "ownership_mismatch"
  | "unknown";

/**
 * Sanitized Cloud Admin failure. The message is bounded and redacted; the request payload (which
 * carries the Runner bootstrap token inside container env) is never attached to an error.
 */
export class CloudRunAdminError extends Error {
  readonly kind: CloudRunAdminErrorKind;
  readonly status?: number;
  /** True only when CREATE was rejected or failed locally before submission. */
  readonly createRejected: boolean;

  constructor(
    kind: CloudRunAdminErrorKind,
    message: string,
    options: { status?: number; cause?: unknown; createRejected?: boolean } = {},
  ) {
    super(sanitizeCloudAdminMessage(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CloudRunAdminError";
    this.kind = kind;
    this.createRejected = options.createRejected === true;
    if (options.status !== undefined) this.status = options.status;
  }
}

export const CLOUD_ADMIN_MESSAGE_MAX_CHARS = 512;

/** Bounded, credential-redacted message; safe for logs and for the Sandbox `lastErrorCode` context. */
export function sanitizeCloudAdminMessage(message: string): string {
  const redacted = redactForLog(message.slice(0, CLOUD_ADMIN_MESSAGE_MAX_CHARS * 2));
  const text = typeof redacted === "string" ? redacted : String(redacted);
  return text.replaceAll("\n", " ").slice(0, CLOUD_ADMIN_MESSAGE_MAX_CHARS);
}
