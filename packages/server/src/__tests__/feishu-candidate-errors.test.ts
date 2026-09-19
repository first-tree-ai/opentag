import { randomUUID } from "node:crypto";
import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import { FeishuAdapter } from "../services/im-bindings/feishu/adapter.js";
import {
  classifyFeishuCandidateFailure,
  classifyFeishuProbeFailure,
} from "../services/im-bindings/feishu/setup-check.js";

describe("official candidate error classification", () => {
  it.each([
    { teamBrand: "feishu" as const, host: "https://open.feishu.cn" },
    { teamBrand: "lark" as const, host: "https://open.larksuite.com" },
  ])("probes the official bot path using the SDK $teamBrand domain", async ({ teamBrand, host }) => {
    const token = vi.spyOn(defaultHttpInstance, "post").mockResolvedValue({
      code: 0,
      tenant_access_token: "test-token",
      expire: 7200,
    });
    const request = vi.spyOn(defaultHttpInstance, "request").mockImplementation(async (options) => {
      expect(options.url).toBe(`${host}/open-apis/bot/v3/info`);
      return { code: 0, bot: { open_id: "ou_test", activate_status: 2 } };
    });
    try {
      const adapter = new FeishuAdapter({
        appId: `cli_${randomUUID()}`,
        appSecret: "test-only",
        teamId: null,
        teamBrand,
        channel: null,
      });
      await expect(adapter.probeBotIdentity()).resolves.toEqual({ openId: "ou_test", activateStatus: 2 });
    } finally {
      request.mockRestore();
      token.mockRestore();
    }
  });

  it.each([
    { code: 10015, status: "terminal", reason: undefined },
    { code: 10014, status: "waiting", reason: "app_unavailable" },
  ])("preserves SDK token business error $code before the SDK erases its code", async ({ code, status, reason }) => {
    const token = vi.spyOn(defaultHttpInstance, "post").mockResolvedValue({ code, msg: "upstream diagnostic" });
    try {
      const adapter = new FeishuAdapter({
        appId: `cli_${randomUUID()}`,
        appSecret: "test-only",
        teamId: null,
        channel: null,
      });
      const error = await adapter.listGrantedWorkspaceScopes().catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code });
      expect(classifyFeishuProbeFailure(error, 0)).toMatchObject({ status, ...(reason ? { reason } : {}) });
      expect(String(error)).not.toContain("upstream diagnostic");
    } finally {
      token.mockRestore();
    }
  });

  it("retains structured business errors returned by the scope endpoint", async () => {
    const adapter = new FeishuAdapter({
      appId: "cli_scope_error",
      appSecret: "test-only",
      teamId: null,
      channel: null,
      scopeList: async () => ({ code: 10014 }),
    });
    const error = await adapter.listGrantedWorkspaceScopes().catch((cause: unknown) => cause);
    expect(classifyFeishuProbeFailure(error, 0)).toMatchObject({ status: "waiting", reason: "app_unavailable" });
  });

  for (const classify of [classifyFeishuCandidateFailure, classifyFeishuProbeFailure]) {
    it.each([10015, 20002])("recognizes explicit credential error %s behind HTTP 400", (code) => {
      expect(classify({ response: { status: 400, data: { code } } }, 0)).toEqual({
        status: "terminal",
        errorCode: "FEISHU_CREDENTIAL_INVALID",
      });
    });
    it.each([10003, 429, 500, undefined])("preserves a candidate on ambiguous error %s", (code) => {
      expect(classify({ code }, 0)).toEqual({ status: "waiting", reason: "temporary_failure", missingScopes: [] });
    });
    it("keeps a disabled App recoverable and respects provider retry hints", () => {
      expect(classify({ response: { status: 400, data: { code: 10014 } } }, 0)).toEqual({
        status: "waiting",
        reason: "app_unavailable",
        missingScopes: [],
      });
      expect(classify({ response: { status: 429, headers: { "retry-after": "120" } } }, 0)).toEqual({
        status: "waiting",
        reason: "temporary_failure",
        missingScopes: [],
        retryAfterMs: 120_000,
      });
    });
  }
});
