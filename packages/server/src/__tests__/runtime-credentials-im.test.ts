import { describe, expect, it, vi } from "vitest";
import { FEISHU_OPERATIONS } from "../runtime-credentials/feishu-operations.js";
import {
  exchangeFeishuTenantToken,
  FeishuTenantTokenCache,
  FeishuTenantTokenExchangeError,
} from "../runtime-credentials/feishu-tenant-token.js";
import { ProviderOperationRegistry } from "../runtime-credentials/operation-registry.js";
import { SLACK_OPERATIONS } from "../runtime-credentials/slack-operations.js";

const slack = new ProviderOperationRegistry(SLACK_OPERATIONS);
const feishu = new ProviderOperationRegistry(FEISHU_OPERATIONS);

describe("Slack operation registry boundaries", () => {
  it("registers the official CLI business domains narrowly", () => {
    for (const [method, path] of [
      ["POST", "/api/auth.test"],
      ["POST", "/api/bots.info"],
      ["POST", "/api/conversations.history"],
      ["POST", "/api/conversations.replies"],
      ["POST", "/api/conversations.join"],
      ["POST", "/api/chat.postMessage"],
      ["POST", "/api/chat.update"],
      ["POST", "/api/chat.delete"],
      ["POST", "/api/reactions.add"],
      ["POST", "/api/files.getUploadURLExternal"],
      ["POST", "/api/files.completeUploadExternal"],
    ] as const) {
      expect(slack.match(method, path)?.operation.operationId).toBeDefined();
    }
  });

  it("rejects OAuth, admin, app-management, revocation, and user-login domains", () => {
    for (const path of [
      "/api/oauth.v2.access",
      "/api/admin.conversations.list",
      "/api/apps.permissions.info",
      "/api/auth.revoke",
      "/api/users.identity",
      "/api/openid.connect.token",
    ]) {
      expect(slack.match("POST", path)).toBeUndefined();
    }
  });

  it("rejects a registered operation on the wrong method or a confused path", () => {
    expect(slack.match("GET", "/api/chat.postMessage")).toBeUndefined();
    expect(slack.match("POST", "/api/chat.postMessage/extra")).toBeUndefined();
    expect(slack.match("POST", "/api//chat.postMessage")).toBeUndefined();
  });
});

describe("Feishu operation registry boundaries", () => {
  it("registers the tenant token, identity, IM, and document domains", () => {
    expect(feishu.match("POST", "/open-apis/auth/v3/tenant_access_token/internal")).toBeDefined();
    expect(feishu.match("GET", "/open-apis/bot/v3/info")?.operation.validationAllowed).toBe(true);
    expect(feishu.match("POST", "/open-apis/im/v1/messages")).toBeDefined();
    expect(feishu.match("POST", "/open-apis/im/v1/messages/{message_id}/reply")).toBeDefined();
    expect(feishu.match("GET", "/open-apis/im/v1/chats")).toBeDefined();
    expect(feishu.match("GET", "/open-apis/docx/v1/documents/{document_id}")).toBeDefined();
    expect(feishu.match("GET", "/open-apis/drive/v1/files/{file_token}/download")?.operation.response).toBe("stream");
  });

  it("rejects SSO/login, event, and admin domains", () => {
    for (const path of [
      "/open-apis/authen/v1/access_token",
      "/open-apis/authen/v1/index",
      "/open-apis/event/v1/outbound",
      "/open-apis/admin/v1/badges",
    ]) {
      expect(feishu.match("POST", path)).toBeUndefined();
    }
  });
});

describe("Feishu tenant token exchange and cache", () => {
  it("exchanges at the fixed origin and honors the platform-reported expiry", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-real", expire: 7200 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const token = await exchangeFeishuTenantToken({
      origin: "https://open.feishu.cn",
      appId: "cli_a",
      appSecret: "secret",
      fetchImpl,
      now: () => 1_000,
    });
    expect(calls[0]).toBe("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal");
    expect(token.token).toBe("t-real");
    expect(token.expiresAt).toBe(1_000 + 7_200_000);
  });

  it("rejects non-zero platform codes and non-OK upstream responses", async () => {
    const rejected = (async () =>
      new Response(JSON.stringify({ code: 10003, msg: "invalid" }), { status: 200 })) as typeof fetch;
    await expect(
      exchangeFeishuTenantToken({ origin: "https://open.feishu.cn", appId: "a", appSecret: "b", fetchImpl: rejected }),
    ).rejects.toBeInstanceOf(FeishuTenantTokenExchangeError);
    const unreachable = (async () => new Response("nope", { status: 502 })) as typeof fetch;
    await expect(
      exchangeFeishuTenantToken({
        origin: "https://open.feishu.cn",
        appId: "a",
        appSecret: "b",
        fetchImpl: unreachable,
      }),
    ).rejects.toMatchObject({ kind: "upstream" });
  });

  it("caches per binding/generation and merges concurrent exchanges", async () => {
    let exchanges = 0;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = new FeishuTenantTokenCache({
      now: () => 1_000,
      refreshSkewMs: 60_000,
      exchange: async () => {
        exchanges += 1;
        await pending;
        return { token: `t-${exchanges}`, expiresAt: 1_000 + 600_000 };
      },
    });
    const input = {
      bindingId: "binding-1",
      credentialGeneration: 1,
      brand: "feishu",
      origin: "https://open.feishu.cn",
      appId: "cli_a",
      appSecret: "secret",
    };
    const first = cache.get(input);
    const second = cache.get(input);
    release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(exchanges).toBe(1);
    expect(a.token).toBe(b.token);
    // A credential generation bump re-exchanges even when the token value would still be fresh.
    await cache.get({ ...input, credentialGeneration: 2 });
    expect(exchanges).toBe(2);
    // A cached token is served without another exchange.
    await cache.get({ ...input, credentialGeneration: 2 });
    expect(exchanges).toBe(2);
  });

  it("does not poison the cache after a failed exchange", async () => {
    let attempts = 0;
    const cache = new FeishuTenantTokenCache({
      now: () => 1_000,
      exchange: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("boom");
        return { token: "t-ok", expiresAt: 1_000 + 600_000 };
      },
    });
    const input = {
      bindingId: "binding-1",
      credentialGeneration: 1,
      brand: "feishu",
      origin: "https://open.feishu.cn",
      appId: "cli_a",
      appSecret: "secret",
    };
    await expect(cache.get(input)).rejects.toThrow("boom");
    await expect(cache.get(input)).resolves.toMatchObject({ token: "t-ok" });
    expect(attempts).toBe(2);
  });

  it("re-exchanges before the platform expiry", async () => {
    let now = 1_000;
    let exchanges = 0;
    const cache = new FeishuTenantTokenCache({
      now: () => now,
      refreshSkewMs: 60_000,
      exchange: async () => {
        exchanges += 1;
        return { token: `t-${exchanges}`, expiresAt: now + 120_000 };
      },
    });
    const input = {
      bindingId: "binding-1",
      credentialGeneration: 1,
      brand: "feishu",
      origin: "https://open.feishu.cn",
      appId: "cli_a",
      appSecret: "secret",
    };
    await cache.get(input);
    now += 70_000;
    await cache.get(input);
    expect(exchanges).toBe(2);
  });
});

describe("ProviderOperationRegistry", () => {
  it("rejects invalid path templates at construction", () => {
    expect(
      () =>
        new ProviderOperationRegistry([
          {
            operationId: "bad",
            provider: "slack",
            method: "POST",
            pathTemplate: "api/without/leading/slash",
            kind: "read",
            body: "json",
            response: "json",
          },
        ]),
    ).toThrow();
  });

  it("bounds body buffering", async () => {
    const { bufferProxyBody, ProviderProxyBodyTooLargeError } = await import(
      "../runtime-credentials/operation-registry.js"
    );
    async function* chunks() {
      yield new Uint8Array(4);
      yield new Uint8Array(4);
    }
    await expect(bufferProxyBody(chunks(), 4)).rejects.toBeInstanceOf(ProviderProxyBodyTooLargeError);
  });
});

describe("ImProviderMaterialResolver generation pins", () => {
  it("marks token rotation distinct from installation rotation", async () => {
    const { imCredentialGenerationPin, imAuthorizationRevision } = await import(
      "../runtime-credentials/provider-material.js"
    );
    expect(imCredentialGenerationPin("slack", 2, 5)).toBe("2:5");
    expect(imCredentialGenerationPin("feishu", 2)).toBe("2");
    expect(imCredentialGenerationPin("slack", 2, 6)).not.toBe(imCredentialGenerationPin("slack", 2, 5));
    expect(imAuthorizationRevision("slack", 2, 5)).toBe("slack:2:5");
    expect(imAuthorizationRevision("feishu", 2)).toBe("feishu:2");
  });
});

describe("Feishu tenant token local response", () => {
  it("never returns the runner capability as a token", async () => {
    const { FEISHU_TENANT_TOKEN_LOCAL_SENTINEL } = await import("@opentag/shared");
    const operation = feishu.match("POST", "/open-apis/auth/v3/tenant_access_token/internal")?.operation;
    const payload = operation?.localResponse?.({}, { executionId: "e", capabilityTtlSeconds: 60 }) as
      | Record<string, unknown>
      | undefined;
    expect(payload?.tenant_access_token).toBe(FEISHU_TENANT_TOKEN_LOCAL_SENTINEL);
    expect(JSON.stringify(payload)).not.toContain("capability");
  });
});

describe("exchangeFeishuTenantToken abort path", () => {
  it("surfaces a bounded upstream failure when fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    await expect(
      exchangeFeishuTenantToken({ origin: "https://open.feishu.cn", appId: "a", appSecret: "b", fetchImpl }),
    ).rejects.toMatchObject({ kind: "upstream" });
  });
});
