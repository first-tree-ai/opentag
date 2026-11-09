import { describe, expect, it } from "vitest";
import { ExternalCallPolicyError } from "../services/im/external-call-policy.js";
import { classifyFeishuConnectionFailure } from "../services/im-bindings/feishu/connection-failure.js";
import { FeishuOperationError } from "../services/im-bindings/feishu/errors.js";

function channelError(cause: unknown): Error {
  return Object.assign(new Error("could not resolve bot identity"), {
    name: "LarkChannelError",
    code: "not_connected",
    cause,
  });
}

describe("classifyFeishuConnectionFailure", () => {
  it("reads a refused tenant token as dead credentials, without keeping the provider text", () => {
    const failure = classifyFeishuConnectionFailure(
      channelError(new Error("failed to get tenant_access_token, code: 10015, msg: secret abc is wrong")),
    );
    expect(failure).toEqual({ kind: "permanent", code: "FEISHU_CREDENTIAL_INVALID" });
  });

  it("reads a disabled or uninstalled App as needing action", () => {
    expect(
      classifyFeishuConnectionFailure(
        channelError(new Error("failed to get tenant_access_token, code: 10014, msg: x")),
      ),
    ).toEqual({ kind: "permanent", code: "FEISHU_APP_UNAVAILABLE" });
    expect(
      classifyFeishuConnectionFailure(
        channelError(new Error('bot/v3/info response missing open_id: {"code":99991673,"msg":"x"}')),
      ),
    ).toEqual({ kind: "permanent", code: "FEISHU_APP_UNAVAILABLE" });
    expect(classifyFeishuConnectionFailure(channelError({ response: { data: { code: 11207 } } }))).toEqual({
      kind: "permanent",
      code: "FEISHU_APP_UNAVAILABLE",
    });
  });

  it("reads the long-connection gateway's refusal as permanent, but not its busy answers", () => {
    const refused = new Error("FEISHU_CONNECTION_ERROR", {
      cause: new Error("pullConnectConfig failed: code=514, msg=auth failed"),
    });
    expect(classifyFeishuConnectionFailure(refused)).toEqual({ kind: "permanent", code: "FEISHU_CONNECTION_REJECTED" });
    const limited = new Error("FEISHU_CONNECTION_ERROR", {
      cause: new Error("pullConnectConfig failed: code=1000040350, msg=limit"),
    });
    expect(classifyFeishuConnectionFailure(limited)).toEqual({ kind: "transient", code: "FEISHU_CONNECTION_ERROR" });
  });

  it("reads a different Bot answering as permanent", () => {
    expect(classifyFeishuConnectionFailure(new FeishuOperationError("FEISHU_BOT_IDENTITY_MISMATCH"))).toEqual({
      kind: "permanent",
      code: "FEISHU_BOT_IDENTITY_MISMATCH",
    });
  });

  it("keeps network failures, timeouts, rate limits and unknown answers transient", () => {
    for (const cause of [
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" }),
      new Error("failed to get tenant_access_token, code: 99991400, msg: rate limited"),
      new Error("WebSocket handshake did not complete within 15000ms"),
    ]) {
      expect(classifyFeishuConnectionFailure(channelError(cause))).toEqual({
        kind: "transient",
        code: "FEISHU_CONNECTION_ERROR",
      });
    }
  });

  it("treats an open circuit as saying nothing new about the App", () => {
    expect(
      classifyFeishuConnectionFailure(new ExternalCallPolicyError("IM_PROVIDER_CIRCUIT_OPEN", "open", {})),
    ).toEqual({ kind: "deferred", code: "IM_PROVIDER_CIRCUIT_OPEN" });
  });
});
