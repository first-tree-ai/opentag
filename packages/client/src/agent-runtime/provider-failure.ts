import type { ProviderFailureReason } from "@opentag/shared";
import type { AgentProviderError } from "./errors.js";
import type { AgentProviderRunResult } from "./types.js";

const codes = new Map<string, ProviderFailureReason>([
  ["authentication_failed", "provider_authentication_failed"],
  ["authentication_error", "provider_authentication_failed"],
  ["invalid_api_key", "provider_authentication_failed"],
  ["unauthorized", "provider_authentication_failed"],
  ["permission_denied", "provider_access_denied"],
  ["model_not_permitted", "provider_access_denied"],
  ["oauth_org_not_allowed", "provider_access_denied"],
  ["model_not_found", "provider_access_denied"],
  ["insufficient_credit", "provider_quota_exceeded"],
  ["insufficient_quota", "provider_quota_exceeded"],
  ["billing_error", "provider_quota_exceeded"],
  ["usageLimitExceeded", "provider_quota_exceeded"],
  ["rate_limit", "provider_rate_limited"],
  ["rate_limit_error", "provider_rate_limited"],
  ["rate_limit_exceeded", "provider_rate_limited"],
  ["rateLimitExceeded", "provider_rate_limited"],
  ["overloaded_error", "provider_unavailable"],
  ["overloaded", "provider_unavailable"],
  ["server_error", "provider_unavailable"],
  ["internalServerError", "provider_unavailable"],
  ["serverOverloaded", "provider_unavailable"],
  ["flexUnavailable", "provider_unavailable"],
  ["context_length_exceeded", "provider_context_limit"],
  ["contextWindowExceeded", "provider_context_limit"],
  ["sessionBudgetExceeded", "provider_execution_limit"],
  ["error_max_turns", "provider_execution_limit"],
  ["error_max_budget_usd", "provider_execution_limit"],
  ["error_max_structured_output_retries", "provider_execution_limit"],
  ["max_output_tokens", "provider_execution_limit"],
  ["length", "provider_execution_limit"],
  ["invalid_request_error", "provider_request_rejected"],
  ["invalid_request", "provider_request_rejected"],
  ["badRequest", "provider_request_rejected"],
  ["exited", "provider_process_exited"],
  ["write", "provider_connection_failed"],
]);

/** Classify declared provider codes/statuses, never arbitrary error prose. */
export function providerFailureCode(code: unknown, status?: unknown): ProviderFailureReason | "provider_error" {
  const known = typeof code === "string" ? codes.get(code) : undefined;
  if (known) return known;
  return connectionFailureCode(code) ?? statusFailureCode(status);
}

function connectionFailureCode(code: unknown): ProviderFailureReason | undefined {
  if (!code || typeof code !== "object") return undefined;
  for (const key of [
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ]) {
    if (Object.hasOwn(code, key)) {
      const details = (code as Record<string, unknown>)[key];
      const httpStatus = details && typeof details === "object" ? Reflect.get(details, "httpStatusCode") : undefined;
      const failure = statusFailureCode(httpStatus);
      return failure === "provider_error" ? "provider_connection_failed" : failure;
    }
  }
  return undefined;
}

function statusFailureCode(status: unknown): ProviderFailureReason | "provider_error" {
  if (status === 401) return "provider_authentication_failed";
  if (status === 403) return "provider_access_denied";
  if (status === 402) return "provider_quota_exceeded";
  if (status === 429) return "provider_rate_limited";
  if (typeof status === "number" && status >= 500 && status <= 599) return "provider_unavailable";
  return "provider_error";
}

/** Pi exposes model errors as an HTTP status followed by a JSON error envelope. */
export function piProviderFailureCode(message: string | undefined): ProviderFailureReason | "provider_error" {
  if (!message || !/^\d{3}: /.test(message)) return "provider_error";
  let envelope: unknown;
  try {
    envelope = JSON.parse(message.slice(5));
  } catch {
    return "provider_error";
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return "provider_error";
  const error = Reflect.get(envelope, "error") ?? envelope;
  if (!error || typeof error !== "object" || Array.isArray(error)) return "provider_error";
  return providerFailureCode(Reflect.get(error, "code") ?? Reflect.get(error, "type"), Number(message.slice(0, 3)));
}

/** No balance, credit or budget: waiting does not help. Checked first, since some of these texts say "limit". */
const PI_BILLING_PATTERN =
  /insufficient_quota|insufficient_credit|billing|available balance|out of budget|credit balance/i;
/** A subscription window that resets by itself (ChatGPT, OpenCode Go and free-tier usage limits). */
const PI_USAGE_WINDOW_PATTERN = /usage_limit_reached|usage limit|GoUsageLimitError|FreeUsageLimitError/i;

/**
 * Pi reports a model failure as text, often `<status>: <JSON error>`. A used-up subscription window is a
 * `usage_window` quota, with its reset when the text has one; billing is a `billing` quota. Undefined for anything
 * else, which keeps its ordinary classification.
 */
export function piQuotaFailure(
  message: string | undefined,
  now: number,
): { code: "provider_quota_exceeded"; quotaKind: "usage_window" | "billing"; retryAt?: string } | undefined {
  if (!message) return undefined;
  if (message.startsWith("402: ") || PI_BILLING_PATTERN.test(message)) {
    return { code: "provider_quota_exceeded", quotaKind: "billing" };
  }
  if (!PI_USAGE_WINDOW_PATTERN.test(message)) return undefined;
  const retryAt = piQuotaReset(message, now);
  return { code: "provider_quota_exceeded", quotaKind: "usage_window", ...(retryAt ? { retryAt } : {}) };
}

function piQuotaReset(message: string, now: number): string | undefined {
  const resetsAt = /"resets_at"\s*:\s*(\d{9,11})\b/.exec(message)?.[1];
  if (resetsAt) return new Date(Number(resetsAt) * 1000).toISOString();
  const seconds = /"resets_in_seconds"\s*:\s*(\d{1,9})\b/.exec(message)?.[1];
  if (seconds) return new Date(now + Number(seconds) * 1000).toISOString();
  const minutes = /Try again in ~(\d{1,6}) min/i.exec(message)?.[1];
  return minutes ? new Date(now + Number(minutes) * 60_000).toISOString() : undefined;
}

export function providerProcessFailureCode(code: string): AgentProviderError["code"] {
  if (code === "spawn") return "provider_start_failed";
  if (code === "protocol") return "provider_protocol_error";
  return providerFailureCode(code);
}

/** A failed Run's result once its input is known to be answered: complete, carrying the failure. */
export function answeredWithFollowUpFailure({ error, ...answered }: AgentProviderRunResult): AgentProviderRunResult {
  return { ...answered, status: "completed", ...(error ? { followUpFailure: error } : {}) };
}
