import { expect, it } from "vitest";
import {
  piProviderFailureCode,
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
