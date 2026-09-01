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
  const error = typeof payload.error === "string" ? payload.error : undefined;
  const failure = classifyProviderFailure([error], payload.missing_scopes, error === "missing_scope");
  if (failure) return failure;
  if (payload.ok !== true) return { status: "needs_attention" };
  const identity = slackIdentity(payload);
  if (!identity) return { status: "needs_attention" };
  if (
    identity.teamId !== expected.teamId ||
    identity.userId !== expected.botUserId ||
    identity.botId !== expected.botId
  ) {
    return { status: "needs_attention", reason: "identity_mismatch" };
  }
  return { status: "ready" };
}

export function classifyLarkAuthStatus(
  payload: unknown,
  expected: Extract<ProviderCliExpectedIdentity, { provider: "feishu" }>,
): ProviderCliValidationClassification {
  if (!isRecord(payload)) return { status: "needs_attention" };
  const failure = classifyProviderFailure(
    [stringifyUnknown(payload.error), stringifyUnknown(payload.code)],
    payload.missing_scopes,
  );
  if (failure) return failure;
  if (!isRecord(payload.identity) || !isRecord(payload.identities)) return { status: "needs_attention" };
  if (!isRecord(payload.identities.bot)) return { status: "needs_attention" };
  const bot = payload.identities.bot;
  if (typeof bot.available !== "boolean" || typeof bot.verified !== "boolean") return { status: "needs_attention" };
  if (!bot.available || !bot.verified) return { status: "needs_attention", reason: "credential_rejected" };
  const identity = larkIdentity(payload.identity, bot);
  if (!identity) return { status: "needs_attention" };
  if (
    identity.appId !== expected.appId ||
    identity.botOpenId !== expected.botOpenId ||
    identity.brand !== expected.teamBrand
  ) {
    return { status: "needs_attention", reason: "identity_mismatch" };
  }
  return { status: "ready" };
}

function classifyProviderFailure(
  errors: readonly (string | undefined)[],
  missingScopes: unknown,
  explicitMissingScope = false,
): ProviderCliValidationClassification | undefined {
  if (explicitMissingScope || hasMissingScopes(missingScopes)) {
    return { status: "needs_attention", reason: "scope_missing" };
  }
  if (errors.some(isRateLimited)) return { status: "retrying", reason: "rate_limited" };
  if (errors.some(isProviderUnreachable)) return { status: "retrying", reason: "provider_unreachable" };
  if (errors.some(isCredentialRejected)) return { status: "needs_attention", reason: "credential_rejected" };
  return undefined;
}

function slackIdentity(
  payload: Record<string, unknown>,
): { readonly botId: string; readonly teamId: string; readonly userId: string } | undefined {
  if (typeof payload.team_id !== "string") return undefined;
  if (typeof payload.user_id !== "string") return undefined;
  if (typeof payload.bot_id !== "string") return undefined;
  return { botId: payload.bot_id, teamId: payload.team_id, userId: payload.user_id };
}

function larkIdentity(
  identity: Record<string, unknown>,
  bot: Record<string, unknown>,
): { readonly appId: string; readonly botOpenId: string; readonly brand: "feishu" | "lark" } | undefined {
  const appId = stringField(identity, ["app_id", "appId"]) ?? stringField(bot, ["app_id"]);
  const brand = stringField(identity, ["brand", "team_brand", "teamBrand"]);
  const botOpenId =
    stringField(identity, ["bot_open_id", "botOpenId", "open_id", "openId"]) ??
    stringField(bot, ["bot_open_id", "open_id", "openId"]);
  if (!appId || !botOpenId) return undefined;
  if (brand !== "lark" && brand !== "feishu") return undefined;
  return { appId, botOpenId, brand };
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
