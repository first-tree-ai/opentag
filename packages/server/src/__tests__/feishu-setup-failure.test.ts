import { describe, expect, it } from "vitest";
import {
  FeishuOperationError,
  feishuPublicFailure,
  feishuSetupFailureCode,
  safeFeishuSetupErrorCode,
} from "../services/im-bindings/feishu/index.js";

function fetchFailed(cause: unknown): Error {
  const error = new TypeError("fetch failed");
  return Object.assign(error, { cause });
}

describe("Feishu setup failure classification", () => {
  it.each([
    ["a transport failure with no cause", fetchFailed(undefined)],
    ["a name resolution failure", fetchFailed(Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }))],
    ["a refused connection", Object.assign(new Error("connect"), { code: "ECONNREFUSED" })],
    ["a connect timeout", fetchFailed(Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }))],
    ["an abort on timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" })],
    [
      "an answer without an authorization URL",
      Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL", input: "undefined" }),
    ],
  ])("reports %s as an unavailable Feishu platform", (_label, error) => {
    expect(feishuSetupFailureCode(error)).toBe("FEISHU_UPSTREAM_UNAVAILABLE");
  });

  it.each([
    ["a rejected authorization", Object.assign(new Error("denied"), { code: "access_denied" })],
    ["an unlabeled failure", new Error("boom")],
    ["a non-error rejection", "boom"],
  ])("keeps %s an unexpected setup failure", (_label, error) => {
    expect(feishuSetupFailureCode(error)).toBe("FEISHU_SETUP_FAILED");
  });

  it("does not loop on a self-referencing cause chain", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(feishuSetupFailureCode(error)).toBe("FEISHU_SETUP_FAILED");
  });

  it("records the classified code on the attempt outcome", () => {
    expect(safeFeishuSetupErrorCode(fetchFailed(undefined))).toBe("FEISHU_UPSTREAM_UNAVAILABLE");
    expect(safeFeishuSetupErrorCode(Object.assign(new Error("denied"), { code: "access_denied" }))).toBe(
      "FEISHU_SETUP_DENIED",
    );
    expect(safeFeishuSetupErrorCode(new Error("boom"))).toBe("FEISHU_SETUP_FAILED");
  });

  it("publishes only the failure the caller can act on", () => {
    expect(feishuPublicFailure(new FeishuOperationError("FEISHU_UPSTREAM_UNAVAILABLE"))).toMatchObject({
      code: "FEISHU_UPSTREAM_UNAVAILABLE",
      statusCode: 502,
      category: "transient",
    });
    expect(feishuPublicFailure(new FeishuOperationError("FEISHU_SETUP_FENCE_STALE"))).toBeUndefined();
    expect(feishuPublicFailure(new Error("boom"))).toBeUndefined();
  });
});
