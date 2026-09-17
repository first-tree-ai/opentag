import type { RuntimeCredentialProvider } from "@opentag/shared";

export type WriteOutcomeState = "succeeded" | "rejected" | "unknown";

/**
 * In-memory classification of one upstream write response. This is NOT a durable receipt: the
 * proxy performs exactly one upstream write attempt, keeps no persistent record of it, and
 * never replays an ambiguous attempt. The classification only decides what the caller is told —
 * success, a definite rejection relayed from the provider, or an explicit unknown outcome.
 */
export interface WriteOutcome {
  /** Controlled bounded result code; never provider free text. */
  readonly code: string;
  readonly state: WriteOutcomeState;
}

const SLACK_ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const SUCCESS_UNCONFIRMED_CODE = "provider_outcome_unconfirmed";

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload as Record<string, unknown>;
}

function hasProviderSuccessShape(provider: RuntimeCredentialProvider, payload: unknown): boolean {
  const record = payloadRecord(payload);
  if (!record) return false;
  if (provider === "slack") return record.ok === true;
  if (provider === "feishu") return record.code === 0;
  return false;
}

function providerRejectionCode(provider: RuntimeCredentialProvider, payload: unknown): string | undefined {
  const record = payloadRecord(payload);
  if (!record) return undefined;
  if (provider === "slack") {
    if (record.ok !== false) return undefined;
    return typeof record.error === "string" && SLACK_ERROR_CODE.test(record.error) ? record.error : "provider_rejected";
  }
  if (provider === "feishu") {
    if (typeof record.code === "number" && Number.isSafeInteger(record.code) && record.code !== 0) {
      return `feishu_${record.code}`;
    }
  }
  return undefined;
}

function isDefiniteRejectionStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408;
}

/** 5xx/408 outcomes are ambiguous even when the body looks like a provider error. */
function isAmbiguousStatus(status: number): boolean {
  return status >= 500 || status === 408;
}

/**
 * Write outcome classification for a parsed JSON response. Success requires HTTP 2xx AND the
 * provider's explicit success shape (`ok === true` / `code === 0`); explicit provider errors and
 * definite 4xx (except 408) are rejections; 5xx, 408, and 2xx without success evidence stay
 * unknown, so they can never appear as a successful write or be automatically replayed.
 */
export function classifyWriteOutcome(input: {
  payload: unknown;
  provider: RuntimeCredentialProvider;
  status: number;
}): WriteOutcome {
  const { payload, provider, status } = input;
  if (status >= 200 && status < 300 && hasProviderSuccessShape(provider, payload)) {
    return { state: "succeeded", code: `http_${status}` };
  }
  if (!isAmbiguousStatus(status)) {
    const rejection = providerRejectionCode(provider, payload);
    if (rejection) return { state: "rejected", code: rejection };
    if (isDefiniteRejectionStatus(status)) return { state: "rejected", code: `http_${status}` };
  }
  if (status >= 200 && status < 300) return { state: "unknown", code: SUCCESS_UNCONFIRMED_CODE };
  return { state: "unknown", code: `http_${status}` };
}

/** Status-only classification for responses whose body must remain an unread stream (upload bytes). */
export function classifyStatusWriteOutcome(status: number): WriteOutcome {
  if (status >= 200 && status < 300) return { state: "succeeded", code: `http_${status}` };
  if (isDefiniteRejectionStatus(status)) return { state: "rejected", code: `http_${status}` };
  return { state: "unknown", code: `http_${status}` };
}
