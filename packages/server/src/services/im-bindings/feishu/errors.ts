import type { ErrorCategory, ErrorCode } from "@opentag/shared";
import { ImBindingServiceError } from "../im-binding-service.js";

export type FeishuSafeErrorCode =
  | "FEISHU_ADMISSION_NOT_READY"
  | "FEISHU_APP_IDENTITY_MISMATCH"
  | "FEISHU_BINDING_NOT_ACTIVE"
  | "FEISHU_BOT_IDENTITY_MISMATCH"
  | "FEISHU_CONNECTION_LEASE_STALE"
  | "FEISHU_CONNECTION_LEASE_UNAVAILABLE"
  | "FEISHU_RUNTIME_TOOL_UNAVAILABLE"
  | "FEISHU_SCOPE_REAUTH_REQUIRED"
  | "FEISHU_SETUP_FAILED"
  | "FEISHU_SETUP_FENCE_STALE"
  | "FEISHU_UPSTREAM_UNAVAILABLE";

export class FeishuOperationError extends Error {
  constructor(readonly code: FeishuSafeErrorCode) {
    super(code);
    this.name = "FeishuOperationError";
  }
}

export interface FeishuPublicFailure {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly statusCode: number;
  readonly message: string;
}

/**
 * Feishu failures the caller can act on. Every other code stays an unexpected
 * server failure so an internal race is never presented as a user action.
 */
const PUBLIC_FAILURES: Partial<Record<FeishuSafeErrorCode, FeishuPublicFailure>> = {
  FEISHU_UPSTREAM_UNAVAILABLE: {
    code: "FEISHU_UPSTREAM_UNAVAILABLE",
    category: "transient",
    statusCode: 502,
    message: "The Feishu open platform did not return a usable authorization",
  },
};

export function feishuPublicFailure(error: unknown): FeishuPublicFailure | undefined {
  return error instanceof FeishuOperationError ? PUBLIC_FAILURES[error.code] : undefined;
}

const UNAVAILABLE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  // The SDK rejects with this when Feishu's begin response carries no authorization URL.
  "ERR_INVALID_URL",
]);

/**
 * Recognizes a failure that belongs to the Feishu platform or the path to it,
 * without trusting upstream message text: either the request never completed,
 * or the answer carried no usable authorization URL for the SDK to parse.
 */
function isUpstreamUnavailable(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && UNAVAILABLE_ERROR_CODES.has(candidate.code)) return true;
    if (candidate.name === "TimeoutError") return true;
    if (candidate.name === "TypeError" && candidate.message === "fetch failed") return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * Classifies a Feishu setup failure before any attempt row or HTTP response is
 * produced. Only the registration start and its QR handshake reach this point,
 * so the URL parsed there is always the one Feishu returned.
 */
export function feishuSetupFailureCode(error: unknown): FeishuSafeErrorCode {
  return isUpstreamUnavailable(error) ? "FEISHU_UPSTREAM_UNAVAILABLE" : "FEISHU_SETUP_FAILED";
}

export function safeFeishuConnectionErrorCode(error: unknown): string {
  return error instanceof FeishuOperationError ? error.code : "FEISHU_CONNECTION_ERROR";
}

export function safeFeishuSetupErrorCode(error: unknown): string {
  if (error instanceof FeishuOperationError) return error.code;
  if (error instanceof ImBindingServiceError && error.code === "FEISHU_APP_ALREADY_BOUND") return error.code;
  if (typeof error !== "object" || error === null || !("code" in error)) return feishuSetupFailureCode(error);
  if (error.code === "access_denied") return "FEISHU_SETUP_DENIED";
  if (error.code === "expired_token") return "FEISHU_SETUP_EXPIRED";
  if (error.code === "abort") return "FEISHU_SETUP_CANCELED";
  return feishuSetupFailureCode(error);
}
