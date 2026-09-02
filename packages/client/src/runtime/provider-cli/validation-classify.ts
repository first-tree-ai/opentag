import {
  type ProviderCliExpectedIdentity,
  type ProviderCliValidationResultReason,
  RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES,
} from "@opentag/shared";
import { type ClientLogger, createLogger } from "../../observability/logger.js";

type ValidationDiagnosticLogger = Pick<ClientLogger, "debug">;
const defaultValidationLogger = createLogger("provider-cli-validation");

export type ProviderCliValidationClassification =
  | { readonly status: "ready" }
  | {
      readonly status: "retrying" | "needs_attention";
      readonly reason?: ProviderCliValidationResultReason;
    };

export function extractBoundedJson(
  text: string,
  maxBytes = RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES,
  logger: ValidationDiagnosticLogger = defaultValidationLogger,
): unknown {
  if (Buffer.byteLength(text) > maxBytes) {
    logDiagnostic(logger, "json_output_oversize");
    return undefined;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    logDiagnostic(logger, "json_output_empty");
    return undefined;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) {
    logDiagnostic(logger, "json_object_bounds_missing");
    return undefined;
  }
  const slice = trimmed.slice(start, end + 1);
  if (Buffer.byteLength(slice) > maxBytes) {
    logDiagnostic(logger, "json_output_oversize");
    return undefined;
  }
  try {
    return JSON.parse(slice);
  } catch {
    logDiagnostic(logger, "json_output_malformed");
    return undefined;
  }
}

export function classifySlackAuthTest(
  payload: unknown,
  expected: Extract<ProviderCliExpectedIdentity, { provider: "slack" }>,
  logger: ValidationDiagnosticLogger = defaultValidationLogger,
): ProviderCliValidationClassification {
  if (!isRecord(payload)) {
    logDiagnostic(logger, "slack_payload_not_record");
    return { status: "needs_attention" };
  }
  if (typeof payload.ok !== "boolean") {
    logDiagnostic(logger, "slack_ok_field_missing");
    return { status: "needs_attention" };
  }
  const error = typeof payload.error === "string" ? payload.error : undefined;
  const failure = classifyProviderFailure([error], payload.missing_scopes, error === "missing_scope");
  if (failure) return failure;
  if (payload.ok !== true) {
    logDiagnostic(logger, "slack_ok_not_true");
    return { status: "needs_attention" };
  }
  const identity = slackIdentity(payload);
  if (!identity) {
    logDiagnostic(logger, "slack_identity_unparseable");
    return { status: "needs_attention" };
  }
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
  logger: ValidationDiagnosticLogger = defaultValidationLogger,
): ProviderCliValidationClassification {
  if (!isRecord(payload)) {
    logDiagnostic(logger, "lark_payload_not_record");
    return { status: "needs_attention" };
  }
  const failure = classifyLarkFailure(payload, logger);
  if (failure) return failure;

  const rawSuccess = payload.code === 0;
  const normalizedSuccess = payload.ok === true;
  if (!rawSuccess && !normalizedSuccess) {
    logDiagnostic(logger, "lark_success_field_invalid");
    return { status: "needs_attention" };
  }
  if (normalizedSuccess && payload.identity !== "bot") {
    if (typeof payload.identity === "string") return { status: "needs_attention", reason: "identity_mismatch" };
    logDiagnostic(logger, "lark_identity_field_invalid");
    return { status: "needs_attention" };
  }

  const container = normalizedSuccess && isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(container.bot) || typeof container.bot.open_id !== "string" || container.bot.open_id.length === 0) {
    logDiagnostic(logger, "lark_bot_identity_unparseable");
    return { status: "needs_attention" };
  }
  if (container.bot.open_id !== expected.botOpenId) {
    return { status: "needs_attention", reason: "identity_mismatch" };
  }
  return { status: "ready" };
}

function classifyLarkFailure(
  payload: Record<string, unknown>,
  logger: ValidationDiagnosticLogger,
): ProviderCliValidationClassification | undefined {
  const error = isRecord(payload.error) ? payload.error : undefined;
  const type = normalizedField(error?.type);
  const subtype = normalizedField(error?.subtype);
  const code = error?.code ?? payload.code;
  const missingScopes = error?.missing_scopes ?? payload.missing_scopes;

  if (hasMissingScopes(missingScopes) || type === "authorization" || isScopeFailure(subtype)) {
    return { status: "needs_attention", reason: "scope_missing" };
  }
  if (isRateLimitFailure(type, subtype, code)) {
    return { status: "retrying", reason: "rate_limited" };
  }
  if (type === "authentication") {
    return { status: "needs_attention", reason: "credential_rejected" };
  }
  if (type === "validation" && isCliCompatibilityFailure(subtype)) {
    return { status: "needs_attention", reason: "upgrade_required" };
  }
  if (isProviderFailure(type, subtype, code, error?.retryable)) {
    return { status: "retrying", reason: "provider_unreachable" };
  }

  const scalarError = error ? undefined : stringifyUnknown(payload.error, logger);
  return classifyProviderFailure([scalarError, stringifyUnknown(payload.code, logger)], payload.missing_scopes);
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

function normalizedField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : undefined;
}

function isScopeFailure(subtype: string | undefined): boolean {
  return (
    subtype === "missing_scope" ||
    subtype === "app_scope_not_applied" ||
    subtype === "token_scope_insufficient" ||
    subtype === "permission_denied"
  );
}

function isRateLimitFailure(type: string | undefined, subtype: string | undefined, code: unknown): boolean {
  return (
    type === "rate_limit" ||
    type === "rate_limited" ||
    subtype === "rate_limit" ||
    subtype === "rate_limited" ||
    String(code) === "429"
  );
}

function isProviderFailure(
  type: string | undefined,
  subtype: string | undefined,
  code: unknown,
  retryable: unknown,
): boolean {
  if (retryable === true) return true;
  if (type === "network" || type === "transport") return true;
  if (
    subtype === "timeout" ||
    subtype === "dns" ||
    subtype === "tls" ||
    subtype === "server_error" ||
    subtype === "service_unavailable"
  ) {
    return true;
  }
  const status = Number(code);
  return Number.isInteger(status) && status >= 500 && status < 600;
}

function isCliCompatibilityFailure(subtype: string | undefined): boolean {
  return (
    subtype === "invalid_argument" ||
    subtype === "command_unavailable" ||
    subtype === "unsupported_command" ||
    subtype === "unsupported_flag"
  );
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

function stringifyUnknown(value: unknown, logger: ValidationDiagnosticLogger): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || typeof value !== "object") return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    logDiagnostic(logger, "error_value_not_serializable");
    return undefined;
  }
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

function logDiagnostic(logger: ValidationDiagnosticLogger, code: string): void {
  logger.debug({ code }, "Provider CLI validation output rejected");
}
