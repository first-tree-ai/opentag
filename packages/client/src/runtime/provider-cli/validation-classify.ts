import {
  type ProviderCliExpectedIdentity,
  type ProviderCliValidationResultReason,
  RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES,
} from "@opentag/shared";

export type ProviderCliValidationClassification =
  | { readonly status: "ready" }
  | {
      readonly status: "retrying" | "needs_attention";
      readonly reason?: ProviderCliValidationResultReason;
    };

export function extractBoundedJson(text: string, maxBytes = RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES): unknown {
  if (Buffer.byteLength(text) > maxBytes) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  const slice = trimmed.slice(start, end + 1);
  if (Buffer.byteLength(slice) > maxBytes) return undefined;
  try {
    return JSON.parse(slice);
  } catch {
    return undefined;
  }
}

export function classifySlackAuthTest(
  payload: unknown,
  expected: Extract<ProviderCliExpectedIdentity, { provider: "slack" }>,
): ProviderCliValidationClassification {
  if (!isRecord(payload) || typeof payload.ok !== "boolean") return { status: "needs_attention" };
  if (hasMissingScopes(payload.missing_scopes) || payload.error === "missing_scope") {
    return { status: "needs_attention", reason: "scope_missing" };
  }
  const error = typeof payload.error === "string" ? payload.error : undefined;
  if (isRateLimited(error)) return { status: "retrying", reason: "rate_limited" };
  if (isProviderUnreachable(error)) return { status: "retrying", reason: "provider_unreachable" };
  if (payload.ok !== true) {
    return isCredentialRejected(error)
      ? { status: "needs_attention", reason: "credential_rejected" }
      : { status: "needs_attention" };
  }
  const teamId = typeof payload.team_id === "string" ? payload.team_id : undefined;
  const userId = typeof payload.user_id === "string" ? payload.user_id : undefined;
  const botId = typeof payload.bot_id === "string" ? payload.bot_id : undefined;
  if (!teamId || !userId || !botId) return { status: "needs_attention" };
  if (teamId !== expected.teamId || userId !== expected.botUserId || botId !== expected.botId) {
    return { status: "needs_attention", reason: "identity_mismatch" };
  }
  return { status: "ready" };
}

export function classifyLarkAuthStatus(
  payload: unknown,
  expected: Extract<ProviderCliExpectedIdentity, { provider: "feishu" }>,
): ProviderCliValidationClassification {
  if (!isRecord(payload)) return { status: "needs_attention" };
  if (hasMissingScopes(payload.missing_scopes)) return { status: "needs_attention", reason: "scope_missing" };
  if (isRateLimited(stringifyUnknown(payload.error)) || isRateLimited(stringifyUnknown(payload.code))) {
    return { status: "retrying", reason: "rate_limited" };
  }
  if (isProviderUnreachable(stringifyUnknown(payload.error)) || isProviderUnreachable(stringifyUnknown(payload.code))) {
    return { status: "retrying", reason: "provider_unreachable" };
  }
  if (isCredentialRejected(stringifyUnknown(payload.error))) {
    return { status: "needs_attention", reason: "credential_rejected" };
  }
  if (!isRecord(payload.identity) || !isRecord(payload.identities)) return { status: "needs_attention" };
  if (!isRecord(payload.identities.bot)) return { status: "needs_attention" };
  const bot = payload.identities.bot;
  if (typeof bot.available !== "boolean" || typeof bot.verified !== "boolean") return { status: "needs_attention" };
  if (!bot.available || !bot.verified) return { status: "needs_attention", reason: "credential_rejected" };
  const appId = stringField(payload.identity, ["app_id", "appId"]) ?? stringField(bot, ["app_id"]);
  const brand = stringField(payload.identity, ["brand", "team_brand", "teamBrand"]);
  const botOpenId =
    stringField(payload.identity, ["bot_open_id", "botOpenId", "open_id", "openId"]) ??
    stringField(bot, ["bot_open_id", "open_id", "openId"]);
  if (!appId || !botOpenId || (brand !== "lark" && brand !== "feishu")) return { status: "needs_attention" };
  if (appId !== expected.appId || botOpenId !== expected.botOpenId || brand !== expected.teamBrand) {
    return { status: "needs_attention", reason: "identity_mismatch" };
  }
  return { status: "ready" };
}

export function classifySpawnFailure(error: unknown): ProviderCliValidationClassification {
  if (isAbortError(error)) throw error;
  const code = errorCode(error);
  if (code === "ETIMEDOUT" || code === "TIMEOUT") return { status: "retrying", reason: "provider_unreachable" };
  if (code === "ENETUNREACH" || code === "EAI_AGAIN" || code === "ENOTFOUND" || code === "ECONNRESET") {
    return { status: "retrying", reason: "provider_unreachable" };
  }
  const status = httpStatus(error);
  if (status === 429) return { status: "retrying", reason: "rate_limited" };
  if (status !== undefined && status >= 500) return { status: "retrying", reason: "provider_unreachable" };
  return { status: "needs_attention" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMissingScopes(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" ? value.length > 0 : false;
}

function isRateLimited(error: string | undefined): boolean {
  return error === "ratelimited" || error === "rate_limited" || error === "429";
}

function isProviderUnreachable(error: string | undefined): boolean {
  if (!error) return false;
  if (
    error === "internal_error" ||
    error === "fatal_error" ||
    error === "provider_unreachable" ||
    error === "service_unavailable" ||
    error === "5xx"
  ) {
    return true;
  }
  const status = Number(error);
  return Number.isInteger(status) && status >= 500 && status < 600;
}

function isCredentialRejected(error: string | undefined): boolean {
  return (
    error === "invalid_auth" ||
    error === "token_revoked" ||
    error === "account_inactive" ||
    error === "not_authed" ||
    error === "token_expired" ||
    error === "invalid_token"
  );
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function stringifyUnknown(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
