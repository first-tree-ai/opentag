import { FEISHU_REQUIRED_TENANT_SCOPES, type FeishuSetupActivationReason } from "@opentag/shared";
import { ImBindingServiceError } from "../im-binding-service.js";
import { FeishuCandidateExpiredError, FeishuOperationError } from "./errors.js";

/**
 * The bounded reason vocabulary a durable candidate may report while it waits. `checking` is a
 * projection-time word only, so it is excluded from the stored observation classification.
 */
export type FeishuCandidateWaitReason = Exclude<FeishuSetupActivationReason, "checking">;

export type FeishuCandidateCheckOutcome =
  | { status: "ready" }
  | { status: "waiting"; reason: FeishuCandidateWaitReason; missingScopes: string[]; retryAfterMs?: number }
  | { status: "terminal"; errorCode: string };

/** What one claimed check settled as. Fence loss and expiry are lifecycle outcomes, not failures. */
export type FeishuClaimedCheckOutcome = FeishuCandidateCheckOutcome | { status: "fence-lost" } | { status: "expired" };

export function missingRequiredScopes(granted: readonly string[]): string[] {
  const observed = new Set(granted);
  return FEISHU_REQUIRED_TENANT_SCOPES.filter((scope) => !observed.has(scope));
}

/**
 * Irrecoverable identities and authorizations. Everything else stays a bounded retry: a network
 * failure, an empty provider answer or a database hiccup must never read as "your credential is
 * invalid" and must never discard the saved candidate.
 */
const TERMINAL_OPERATION_CODES = new Set([
  "FEISHU_APP_IDENTITY_MISMATCH",
  "FEISHU_BOT_IDENTITY_MISMATCH",
  "FEISHU_SETUP_DENIED",
]);

/** Terminal service-level conflicts: the candidate cannot win against the existing row. */
const TERMINAL_SERVICE_CODES = new Set([
  "FEISHU_APP_ALREADY_BOUND",
  "FEISHU_BINDING_IDENTITY_MISMATCH",
  "IM_BINDING_PROVIDER_IMMUTABLE",
]);

/**
 * Feishu token errors that mean the stored App credentials are no longer usable. Kept deliberately
 * small: only signals the platform reports for app credentials themselves qualify, so a provider
 * outage or a scope hiccup cannot steal a candidate that may still activate later.
 */
const TERMINAL_FEISHU_CREDENTIAL_CODES = new Set([10015, 20002]);

/**
 * Official Feishu/Lark codes meaning the app is disabled or not installed for the tenant
 * (https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code.md). The candidate
 * stays recoverable while the tenant enables or installs the app, so these read as a bounded wait
 * instead of a dead credential or an opaque transient failure.
 */
const RECOVERABLE_APP_UNAVAILABLE_CODES = new Set([10014, 11207, 11210, 20009, 99991662, 99991673]);

function objectProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Walks a cause chain once, returning the first non-undefined visit result. */
function walkCauses<T>(error: unknown, visit: (candidate: unknown) => T | undefined): T | undefined {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const found = visit(current);
    if (found !== undefined) return found;
    current = objectProperty(current, "cause");
  }
  return undefined;
}

function parseNumericCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** The numeric provider error code, from the error itself or a wrapped HTTP response body. */
function numericProviderCode(error: unknown): number | undefined {
  return walkCauses(error, (candidate) => {
    const response = objectProperty(candidate, "response");
    return [
      objectProperty(candidate, "code"),
      objectProperty(objectProperty(response, "data"), "code"),
      objectProperty(objectProperty(candidate, "data"), "code"),
    ].reduce<number | undefined>((found, value) => found ?? parseNumericCode(value), undefined);
  });
}

function retryAfterHeader(headers: unknown): string | undefined {
  const get = (headers as { get?: unknown } | undefined)?.get;
  if (typeof get === "function") {
    return (headers as { get(name: string): string | null }).get("retry-after") ?? undefined;
  }
  const value = objectProperty(headers, "retry-after") ?? objectProperty(headers, "Retry-After");
  return typeof value === "string" ? value : undefined;
}

function headerValueToMs(headerValue: string, now: number): number | undefined {
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const at = Date.parse(headerValue);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** A provider `Retry-After` hint, in milliseconds, when the error carries one. */
export function feishuRetryAfterMs(error: unknown, now: number): number | undefined {
  return walkCauses(error, (candidate) => {
    const explicit = objectProperty(candidate, "retryAfterMs");
    if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
    const header = retryAfterHeader(objectProperty(objectProperty(candidate, "response"), "headers"));
    return header === undefined || header.trim() === "" ? undefined : headerValueToMs(header, now);
  });
}

function isTerminalCredentialCode(code: number | undefined): boolean {
  return code !== undefined && TERMINAL_FEISHU_CREDENTIAL_CODES.has(code);
}

function isAppUnavailableCode(code: number | undefined): boolean {
  return code !== undefined && RECOVERABLE_APP_UNAVAILABLE_CODES.has(code);
}

function waitingTemporary(error: unknown, now: number): FeishuCandidateCheckOutcome {
  const retryAfterMs = feishuRetryAfterMs(error, now);
  return {
    status: "waiting",
    reason: "temporary_failure",
    missingScopes: [],
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function classifyOperationFailure(error: FeishuOperationError, now: number): FeishuClaimedCheckOutcome | undefined {
  if (error.code === "FEISHU_SETUP_FENCE_STALE") return { status: "fence-lost" };
  if (error.code === "FEISHU_RUNTIME_TOOL_UNAVAILABLE") {
    return { status: "waiting", reason: "runtime_unavailable", missingScopes: [] };
  }
  if (error.code === "FEISHU_SCOPE_REAUTH_REQUIRED") {
    const retryAfterMs = feishuRetryAfterMs(error, now);
    return {
      status: "waiting",
      reason: "permissions_pending",
      missingScopes: boundedMissingScopes(error.missingScopes),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (TERMINAL_OPERATION_CODES.has(error.code)) return { status: "terminal", errorCode: error.code };
  return undefined;
}

function classifyServiceFailure(error: ImBindingServiceError): FeishuClaimedCheckOutcome | undefined {
  if (error.code === "IM_BINDING_SCOPE_REAUTH_REQUIRED") {
    return { status: "waiting", reason: "permissions_pending", missingScopes: [] };
  }
  if (TERMINAL_SERVICE_CODES.has(error.code)) return { status: "terminal", errorCode: error.code };
  return undefined;
}

/**
 * Classifies an upstream failure observed while a claimed candidate is being validated. Waiting
 * outcomes preserve the candidate; terminal outcomes end it with a bounded public code.
 */
export function classifyFeishuCandidateFailure(error: unknown, now: number): FeishuClaimedCheckOutcome {
  if (error instanceof FeishuCandidateExpiredError) return { status: "expired" };
  if (error instanceof FeishuOperationError) {
    const classified = classifyOperationFailure(error, now);
    if (classified) return classified;
  }
  if (error instanceof ImBindingServiceError) {
    const classified = classifyServiceFailure(error);
    if (classified) return classified;
  }
  if (isAppUnavailableCode(numericProviderCode(error))) {
    return { status: "waiting", reason: "app_unavailable", missingScopes: [] };
  }
  if (isTerminalCredentialCode(numericProviderCode(error))) {
    return { status: "terminal", errorCode: "FEISHU_CREDENTIAL_INVALID" };
  }
  return waitingTemporary(error, now);
}

/** Classifies a failure observed while probing the candidate without owning the activation claim. */
export function classifyFeishuProbeFailure(error: unknown, now: number): FeishuCandidateCheckOutcome {
  if (error instanceof FeishuOperationError && TERMINAL_OPERATION_CODES.has(error.code)) {
    return { status: "terminal", errorCode: error.code };
  }
  if (isAppUnavailableCode(numericProviderCode(error))) {
    return { status: "waiting", reason: "app_unavailable", missingScopes: [] };
  }
  if (isTerminalCredentialCode(numericProviderCode(error))) {
    return { status: "terminal", errorCode: "FEISHU_CREDENTIAL_INVALID" };
  }
  return waitingTemporary(error, now);
}

/** Keeps an untrusted missing-scope list inside the canonical required vocabulary, deduplicated. */
export function boundedMissingScopes(scopes: readonly string[] | undefined): string[] {
  if (!scopes) return [];
  const canonical = new Set<string>(FEISHU_REQUIRED_TENANT_SCOPES);
  return [...new Set(scopes.filter((scope) => canonical.has(scope)))];
}
