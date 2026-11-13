import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseServerConfig } from "../config.js";
import type { RuntimeProxyAuthorization } from "../runtime-credentials/credential-broker.js";
import { FEISHU_OPERATIONS, FEISHU_PASSTHROUGH } from "../runtime-credentials/feishu-operations.js";
import { ProviderOperationRegistry, redactProxyPath } from "../runtime-credentials/operation-registry.js";
import {
  ImProviderProxyAdapter,
  type ProviderProxyRequest,
  RuntimeProxyError,
} from "../runtime-credentials/provider-proxy-adapter.js";
import { RuntimeUrlHandleStore } from "../runtime-credentials/url-handle-store.js";

const EXECUTION = randomUUID();
const SESSION = randomUUID();

function request(overrides: Partial<ProviderProxyRequest> = {}): ProviderProxyRequest {
  return {
    executionId: EXECUTION,
    sessionId: SESSION,
    provider: "feishu",
    bindingId: "binding-1",
    method: "POST",
    path: "/open-apis/bitable/v1/apps",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: bodyOf(),
    capability: "c".repeat(43),
    capabilityTtlSeconds: 60,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function* bodyOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

function textBody(value: string): AsyncIterable<Uint8Array> {
  return bodyOf(new TextEncoder().encode(value));
}

function authorization(overrides: Partial<RuntimeProxyAuthorization> = {}): RuntimeProxyAuthorization {
  return {
    executionId: EXECUTION,
    provider: "feishu",
    bindingId: "binding-1",
    purpose: "execution",
    scopeHash: "a".repeat(64),
    authorizationRevision: "feishu:3:7",
    credentialGeneration: "3:7",
    sessionId: SESSION,
    accountId: randomUUID(),
    agentId: randomUUID(),
    cli: { provider: "feishu", appId: "cli_app", brand: "feishu" },
    resolveMaterial: async () => ({ kind: "bearer", token: "real-token", origin: "https://open.feishu.cn" }),
    recheck: async () => undefined,
    ...overrides,
  } as RuntimeProxyAuthorization;
}

async function readBody(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

interface Call {
  url: string;
  init: RequestInit & { duplex?: string };
}

function upstream(response: () => Response): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function adapter(fetchImpl: typeof fetch, extra: { capture?: () => Promise<void> } = {}) {
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const capture = vi.fn(extra.capture ?? (async () => undefined));
  const instance = new ImProviderProxyAdapter({
    provider: "feishu",
    registry: new ProviderOperationRegistry(FEISHU_OPERATIONS, FEISHU_PASSTHROUGH),
    urlHandles: new RuntimeUrlHandleStore(),
    fetchImpl,
    logger,
    outboundCapture: { capture },
  });
  return { instance, logger, capture };
}

describe("Feishu passthrough registry", () => {
  const registry = new ProviderOperationRegistry(FEISHU_OPERATIONS, FEISHU_PASSTHROUGH);

  it("keeps explicit operations first and falls back for other open-apis paths", () => {
    expect(registry.match("POST", "/open-apis/im/v1/messages?receive_id_type=chat_id")?.operation.operationId).toBe(
      "feishu.im.messages.create",
    );
    expect(registry.match("POST", "/open-apis/auth/v3/tenant_access_token/internal")?.operation.operationId).toBe(
      "feishu.auth.tenant_access_token",
    );
    const fallback = registry.match("POST", "/open-apis/bitable/v1/apps?user_id_type=open_id");
    expect(fallback).toMatchObject({
      operation: { operationId: "feishu.passthrough", kind: "write", body: "auto", response: "auto" },
      params: {},
      query: "user_id_type=open_id",
    });
    expect(fallback?.operation.validationAllowed).toBeUndefined();
    expect(registry.match("GET", "/open-apis/docx/v1/documents/doxcnABC/blocks")?.operation).toMatchObject({
      operationId: "feishu.passthrough",
      kind: "read",
      body: "none",
    });
    // An explicit path with a method the table does not register also falls through.
    expect(registry.match("PATCH", "/open-apis/im/v1/messages/om_1")?.operation.operationId).toBe("feishu.passthrough");
    for (const domain of ["admin/v1/password/reset", "application/v6/applications/cli_x", "event/v1/outbound_ip"]) {
      expect(registry.match("GET", `/open-apis/${domain}`)?.operation.operationId).toBe("feishu.passthrough");
    }
  });

  it("refuses the denylist, aliases, other prefixes, and unsupported methods", () => {
    for (const [method, path] of [
      ["POST", "/open-apis/auth/v3/app_access_token/internal"],
      ["POST", "/open-apis/auth/v3/tenant_access_token"],
      ["GET", "/open-apis/auth/v3/tenant_access_token/internal"],
      ["POST", "/open-apis/authen/v1/oidc/access_token"],
      ["POST", "/open-apis/AUTHEN/v1/access_token"],
      ["POST", "/open-apis/%61uthen/v1/access_token"],
      ["POST", "/open-apis/../auth/v3/app_access_token/internal"],
      ["GET", "/open-apis"],
      ["GET", "/open-apis/"],
      ["GET", "/api/tools/open/other"],
      ["HEAD", "/open-apis/bitable/v1/apps"],
      // Aliases that URL parsing or Feishu routing would resolve to a denied or explicit path.
      ["POST", "/open-apis/docx/%2e%2e/auth/v3/tenant_access_token/internal"],
      ["POST", "/open-apis/drive/%2E%2e/authen/v1/access_token"],
      ["POST", "/open-apis/drive/.%2e/authen/v1/access_token"],
      ["POST", "/open-apis/drive/%2e./authen/v1/access_token"],
      ["POST", "/open-apis/drive/%2e/v1/files"],
      ["POST", "/open-apis/im/v1/messages/om_123/reply#frag"],
      ["POST", "/open-apis/im/v1/%6dessages?receive_id_type=chat_id"],
      ["POST", "/open-apis/im/v1/messages/"],
      ["GET", "/open-apis/im/v1/messages/om_1?x=#y"],
      ["GET", "/open-apis/im/v1/messages/%2e%2e"],
    ] as const) {
      expect(registry.match(method, path), `${method} ${path}`).toBeUndefined();
    }
  });

  it("is an exact allowlist without a passthrough rule", () => {
    expect(
      new ProviderOperationRegistry(FEISHU_OPERATIONS).match("POST", "/open-apis/bitable/v1/apps"),
    ).toBeUndefined();
  });

  it("redacts identifier-like path segments for audit logs", () => {
    expect(redactProxyPath("/open-apis/bitable/v1/apps/bascnAbC123/tables/tblXyZ/records?page_token=secret")).toBe(
      "/open-apis/bitable/v1/apps/{id}/tables/{id}/records",
    );
    expect(redactProxyPath("/open-apis/im/v1/chats/oc_0123abcd/members")).toBe("/open-apis/im/v1/chats/{id}/members");
    expect(redactProxyPath("/open-apis/docx/v1/documents/doxcn1/raw_content")).toBe(
      "/open-apis/docx/v1/documents/{id}/raw_content",
    );
    // Identifier positions are redacted whatever their shape, including lowercase words.
    expect(redactProxyPath("/open-apis/contact/v3/users/alice?user_id_type=user_id")).toBe(
      "/open-apis/contact/v3/users/{id}",
    );
    expect(redactProxyPath("/open-apis/contact/v3/users/synthetic-private-user/x_y")).toBe(
      "/open-apis/contact/v3/users/{id}/x_y",
    );
    expect(redactProxyPath("/open-apis/drive/explorer/v2/root_folder/meta")).toBe(
      "/open-apis/drive/explorer/v2/root_folder/{id}",
    );
    expect(redactProxyPath("/open-apis/im/v1/Messages/om_1")).toBe("/open-apis/im/v1/{id}/{id}");
    expect(redactProxyPath("/open-apis/alice/bob")).toBe("/open-apis/{id}/{id}");
  });
});

describe("Feishu passthrough adapter", () => {
  it("forwards raw JSON bodies, relays the parsed response, logs a redacted audit line, and skips capture", async () => {
    const { calls, fetchImpl } = upstream(() => json({ code: 0, data: { app: { app_token: "bascnNew" } } }));
    const { instance, logger, capture } = adapter(fetchImpl);
    const raw = '{"name":"Plan",  "folder_token":"fld1"}';
    const response = await instance.handle(
      request({ path: "/open-apis/bitable/v1/apps?user_id_type=open_id", body: textBody(raw) }),
      authorization(),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(await readBody(response.body))).toEqual({ code: 0, data: { app: { app_token: "bascnNew" } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://open.feishu.cn/open-apis/bitable/v1/apps?user_id_type=open_id");
    expect(calls[0]?.init.method).toBe("POST");
    expect(Buffer.from(calls[0]?.init.body as Uint8Array).toString("utf8")).toBe(raw);
    expect(calls[0]?.init.headers).toEqual({
      authorization: "Bearer real-token",
      "content-type": "application/json; charset=utf-8",
    });
    expect(capture).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { code: "PROVIDER_PROXY_PASSTHROUGH", provider: "feishu", method: "POST", path: "/open-apis/bitable/v1/apps" },
      "Provider proxy passthrough request",
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("open_id");
  });

  it("still captures explicit message sends", async () => {
    const { fetchImpl } = upstream(() => json({ code: 0, data: { message_id: "om_1" } }));
    const { instance, logger, capture } = adapter(fetchImpl);
    await instance.handle(
      request({ path: "/open-apis/im/v1/messages?receive_id_type=chat_id", body: textBody('{"receive_id":"oc_1"}') }),
      authorization(),
    );
    expect(capture).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("classifies passthrough writes", async () => {
    const rejected = adapter(upstream(() => json({ code: 99991672, msg: "no permission" }, 400)).fetchImpl);
    const relayed = await rejected.instance.handle(request({ body: textBody("{}") }), authorization());
    expect(relayed.status).toBe(400);
    expect(JSON.parse(await readBody(relayed.body))).toMatchObject({ code: 99991672 });

    for (const response of [
      () => json({ code: 0 }, 500),
      () => json({ data: {} }),
      () => new Response("bad gateway", { status: 502 }),
    ]) {
      const { instance } = adapter(upstream(response).fetchImpl);
      await expect(
        instance.handle(
          request({ method: "DELETE", path: "/open-apis/drive/v1/files/box1", body: bodyOf() }),
          authorization(),
        ),
      ).rejects.toMatchObject({ code: "write_outcome_unknown" });
    }

    const failing = adapter((async () => {
      throw new TypeError("socket hang up");
    }) as typeof fetch);
    await expect(failing.instance.handle(request({ body: textBody("{}") }), authorization())).rejects.toMatchObject({
      code: "write_outcome_unknown",
    });
  });

  it("streams non-JSON responses such as downloads", async () => {
    const { fetchImpl } = upstream(
      () => new Response("binary-bytes", { status: 200, headers: { "content-type": "application/octet-stream" } }),
    );
    const { instance } = adapter(fetchImpl);
    const response = await instance.handle(
      request({ method: "GET", path: "/open-apis/drive/v1/medias/box1/download", headers: {} }),
      authorization(),
    );
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(await readBody(response.body)).toBe("binary-bytes");
  });

  it("streams multipart uploads without buffering", async () => {
    const { calls, fetchImpl } = upstream(() => json({ code: 0, data: { file_token: "box2" } }));
    const { instance } = adapter(fetchImpl);
    const contentType = "multipart/form-data; boundary=x";
    await instance.handle(
      request({
        path: "/open-apis/drive/v1/medias/upload_all",
        headers: { "content-type": contentType },
        body: textBody("--x\r\n\r\npayload\r\n--x--"),
      }),
      authorization(),
    );
    expect(calls[0]?.init.body).toBeInstanceOf(Readable);
    expect(calls[0]?.init.duplex).toBe("half");
    expect(calls[0]?.init.headers).toMatchObject({ "content-type": contentType });
  });

  it("bounds buffered bodies at 1 MiB and refuses validation and denied paths", async () => {
    const { calls, fetchImpl } = upstream(() => json({ code: 0 }));
    const { instance } = adapter(fetchImpl);
    const oversized = bodyOf(new Uint8Array(1024 * 1024 + 1));
    await expect(instance.handle(request({ body: oversized }), authorization())).rejects.toMatchObject({
      code: "body_too_large",
    });
    await expect(
      instance.handle(request({ method: "GET", path: "/open-apis/contact/v3/users", headers: {} }), {
        ...authorization(),
        purpose: "validation",
      }),
    ).rejects.toMatchObject({ code: "validation_scope" });
    await expect(
      instance.handle(request({ path: "/open-apis/authen/v1/access_token", body: textBody("{}") }), authorization()),
    ).rejects.toEqual(new RuntimeProxyError("operation_not_registered"));
    expect(calls).toHaveLength(0);
  });
});

describe("OPENTAG_PROVIDER_PROXY_PASSTHROUGH", () => {
  const required = {
    BETTER_AUTH_SECRET: "a-better-auth-secret-of-at-least-32-characters",
    OPENTAG_DATABASE_URL: "postgresql://opentag:opentag@localhost:5432/opentag",
    OPENTAG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    OPENTAG_JWT_SECRET: "a-secret-that-is-at-least-32-characters",
    OPENTAG_PUBLIC_URL: "http://localhost:8000",
  };

  it("defaults on, accepts off, and rejects other values", () => {
    expect(parseServerConfig(required).providerProxyPassthrough).toBe(true);
    expect(parseServerConfig({ ...required, OPENTAG_PROVIDER_PROXY_PASSTHROUGH: "" }).providerProxyPassthrough).toBe(
      true,
    );
    expect(parseServerConfig({ ...required, OPENTAG_PROVIDER_PROXY_PASSTHROUGH: "on" }).providerProxyPassthrough).toBe(
      true,
    );
    expect(parseServerConfig({ ...required, OPENTAG_PROVIDER_PROXY_PASSTHROUGH: "off" }).providerProxyPassthrough).toBe(
      false,
    );
    expect(() => parseServerConfig({ ...required, OPENTAG_PROVIDER_PROXY_PASSTHROUGH: "true" })).toThrow();
  });
});
