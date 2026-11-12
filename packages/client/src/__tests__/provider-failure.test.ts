import { describe, expect, it } from "vitest";
import {
  answeredWithFollowUpFailure,
  piProviderFailureCode,
  piQuotaFailure,
  providerFailureCode,
  providerProcessFailureCode,
} from "../agent-runtime/provider-failure.js";

it.each([
  ["unauthorized", "provider_authentication_failed"],
  ["model_not_permitted", "provider_access_denied"],
  ["usageLimitExceeded", "provider_quota_exceeded"],
  ["rate_limit_error", "provider_rate_limited"],
  ["serverOverloaded", "provider_unavailable"],
  [{ responseStreamDisconnected: { httpStatusCode: null } }, "provider_connection_failed"],
  ["contextWindowExceeded", "provider_context_limit"],
  ["error_max_budget_usd", "provider_execution_limit"],
  ["badRequest", "provider_request_rejected"],
  ["exited", "provider_process_exited"],
  ["write", "provider_connection_failed"],
  ["unknown", "provider_error"],
  ["constructor", "provider_error"],
  [undefined, "provider_error"],
  [null, "provider_error"],
  [{ other: true }, "provider_error"],
  [{ httpConnectionFailed: null }, "provider_connection_failed"],
  [{ httpConnectionFailed: "unknown" }, "provider_connection_failed"],
  [{ responseStreamConnectionFailed: { httpStatusCode: 401 } }, "provider_authentication_failed"],
])("classifies declared provider code %j", (code, expected) => {
  expect(providerFailureCode(code)).toBe(expected);
});

it.each([
  [401, "provider_authentication_failed"],
  [403, "provider_access_denied"],
  [402, "provider_quota_exceeded"],
  [429, "provider_rate_limited"],
  [503, "provider_unavailable"],
  [400, "provider_error"],
  [600, "provider_error"],
])("classifies HTTP status %i", (status, expected) => {
  expect(providerFailureCode(undefined, status)).toBe(expected);
});

it.each([
  ['400: {"code":"context_length_exceeded","message":"private upstream text"}', "provider_context_limit"],
  ['429: {"error":{"code":"insufficient_quota"}}', "provider_quota_exceeded"],
  ['400: {"error":{"type":"invalid_request_error"}}', "provider_request_rejected"],
  ["503: {}", "provider_unavailable"],
  ["400: {}", "provider_error"],
  ["429: null", "provider_error"],
  ["429: []", "provider_error"],
  ["429: 42", "provider_error"],
  ["429: {invalid}", "provider_error"],
  ['429: {"error":[]}', "provider_error"],
  ['429: {"error":"bad"}', "provider_error"],
  ["The tool printed invalid_api_key and rate_limit_exceeded", "provider_error"],
  [undefined, "provider_error"],
])("classifies Pi's model error envelope %j without interpreting prose", (message, expected) => {
  expect(piProviderFailureCode(message)).toBe(expected);
});

it.each([
  ["spawn", "provider_start_failed"],
  ["protocol", "provider_protocol_error"],
  ["exited", "provider_process_exited"],
  ["timeout", "provider_error"],
])("preserves process failure %s", (code, expected) => {
  expect(providerProcessFailureCode(code)).toBe(expected);
});

describe("answeredWithFollowUpFailure", () => {
  it("completes the Run and carries the failure, with or without one", () => {
    const error = { code: "provider_rate_limited", message: "429" } as const;
    expect(answeredWithFollowUpFailure({ status: "failed", output: [], error })).toEqual({
      status: "completed",
      output: [],
      followUpFailure: error,
    });
    expect(answeredWithFollowUpFailure({ status: "failed" })).toEqual({ status: "completed" });
  });
});

describe("piQuotaFailure", () => {
  const now = Date.parse("2026-11-13T00:00:00.000Z");
  const later = (seconds: number) => new Date(now + seconds * 1000).toISOString();

  it.each([
    [
      '429: {"error":{"type":"usage_limit_reached","resets_at":1794528000}}',
      "usage_window",
      "2026-11-13T00:00:00.000Z",
    ],
    ['429: {"error":{"code":"usage_limit_reached","resets_in_seconds":3600}}', "usage_window", later(3600)],
    ["You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.", "usage_window", later(42 * 60)],
    ['429: {"error":{"type":"GoUsageLimitError"}}', "usage_window", undefined],
    ['429: {"error":{"code":"insufficient_quota"}}', "billing", undefined],
    ['402: {"error":{"type":"payment_required"}}', "billing", undefined],
    ["Monthly usage limit reached. Enable available balance usage to continue.", "billing", undefined],
  ])("classifies %s", (message, quotaKind, retryAt) => {
    const failure = piQuotaFailure(message, now);
    expect(failure).toMatchObject({ code: "provider_quota_exceeded", quotaKind });
    expect(failure?.retryAt).toBe(retryAt);
  });

  it.each([
    undefined,
    "",
    '429: {"code":"rate_limit_exceeded"}',
    "500: server error",
    // pi-ai writes this for every ChatGPT 429 and for usage_not_included: without a reset it proves nothing.
    "You have hit your ChatGPT usage limit (plus plan).",
    "You have hit your ChatGPT usage limit.",
  ])("leaves any other failure alone: %s", (message) => {
    expect(piQuotaFailure(message, now)).toBeUndefined();
  });
});
