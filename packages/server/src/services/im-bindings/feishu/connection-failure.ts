import { ExternalCallPolicyError } from "../../im/external-call-policy.js";
import { FeishuOperationError, safeFeishuConnectionErrorCode } from "./errors.js";
import {
  numericProviderCode,
  RECOVERABLE_APP_UNAVAILABLE_CODES,
  TERMINAL_FEISHU_CREDENTIAL_CODES,
  walkCauses,
} from "./setup-check.js";

/**
 * How one failed attempt to open a binding's long connection bears on the next one.
 *
 * - `permanent`: Feishu itself refused this App: its credentials are no longer valid, the App is
 *   disabled or not installed, the long-connection gateway rejected it, or a different Bot answers.
 *   Retrying cannot succeed until someone changes the App or reconnects it.
 * - `deferred`: the attempt never reached Feishu because the call's circuit is open. It says
 *   nothing new about the App, so it neither counts toward nor clears a run of permanent failures.
 * - `transient`: anything else (network, timeouts, rate limits, an ambiguous SDK failure). These
 *   are retried with backoff and never stop the binding on their own.
 */
export type FeishuConnectionFailureKind = "permanent" | "deferred" | "transient";

export interface FeishuConnectionFailure {
  readonly kind: FeishuConnectionFailureKind;
  /** A bounded code safe to store as `last_error_code`; it never carries upstream text. */
  readonly code: string;
}

/**
 * The long-connection gateway's own refusal codes (`forbidden`, `auth_failed`). The SDK reports
 * them as non-retryable; its busy and connection-limit codes stay transient.
 */
const REJECTED_GATEWAY_CODES: ReadonlySet<number> = new Set([403, 514]);

/*
 * The SDK folds several Feishu answers into plain messages. Only the numeric code is read from
 * them, never the provider text, so nothing upstream reaches storage or logs.
 */
const TOKEN_FAILURE = /^failed to get (?:tenant|app)_access_token, code: (\d+)/;
const GATEWAY_FAILURE = /^pullConnectConfig failed: code=(\d+)/;
const BOT_INFO_FAILURE = /^bot\/v3\/info response missing open_id: .*?"code":(\d+)/;

function messageCode(error: unknown, pattern: RegExp): number | undefined {
  return walkCauses(error, (candidate) => {
    const message = (candidate as { message?: unknown }).message;
    if (typeof message !== "string") return undefined;
    const match = pattern.exec(message);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  });
}

function providerCode(error: unknown): number | undefined {
  return messageCode(error, TOKEN_FAILURE) ?? messageCode(error, BOT_INFO_FAILURE) ?? numericProviderCode(error);
}

export function classifyFeishuConnectionFailure(error: unknown): FeishuConnectionFailure {
  if (error instanceof FeishuOperationError && error.code === "FEISHU_BOT_IDENTITY_MISMATCH") {
    return { kind: "permanent", code: error.code };
  }
  if (error instanceof ExternalCallPolicyError && error.code === "IM_PROVIDER_CIRCUIT_OPEN") {
    return { kind: "deferred", code: error.code };
  }
  const code = providerCode(error);
  if (code !== undefined && TERMINAL_FEISHU_CREDENTIAL_CODES.has(code)) {
    return { kind: "permanent", code: "FEISHU_CREDENTIAL_INVALID" };
  }
  if (code !== undefined && RECOVERABLE_APP_UNAVAILABLE_CODES.has(code)) {
    return { kind: "permanent", code: "FEISHU_APP_UNAVAILABLE" };
  }
  const gatewayCode = messageCode(error, GATEWAY_FAILURE);
  if (gatewayCode !== undefined && REJECTED_GATEWAY_CODES.has(gatewayCode)) {
    return { kind: "permanent", code: "FEISHU_CONNECTION_REJECTED" };
  }
  return { kind: "transient", code: safeFeishuConnectionErrorCode(error) };
}
