import { randomUUID } from "node:crypto";
import { FEISHU_TENANT_TOKEN_LOCAL_SENTINEL } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeProxyAuthorization } from "../runtime-credentials/credential-broker.js";
import { FEISHU_OPERATIONS } from "../runtime-credentials/feishu-operations.js";
import { FeishuTenantTokenExchangeError } from "../runtime-credentials/feishu-tenant-token.js";
import { ProviderOperationRegistry } from "../runtime-credentials/operation-registry.js";
import {
  ImProviderProxyAdapter,
  type OutboundWriteCapture,
  type OutboundWriteCaptureEvent,
  type ProviderProxyRequest,
  RuntimeProxyError,
  type SessionTaskAnchorResolution,
} from "../runtime-credentials/provider-proxy-adapter.js";
import { SLACK_OPERATIONS } from "../runtime-credentials/slack-operations.js";
import { RuntimeUrlHandleStore } from "../runtime-credentials/url-handle-store.js";

const EXECUTION = randomUUID();
const SESSION = randomUUID();

function request(overrides: Partial<ProviderProxyRequest> = {}): ProviderProxyRequest {
  return {
    executionId: EXECUTION,
    sessionId: SESSION,
    provider: "slack",
    bindingId: "binding-1",
    method: "POST",
    path: "/api/chat.postMessage",
    headers: {},
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

function jsonBody(value: unknown): AsyncIterable<Uint8Array> {
  return bodyOf(new TextEncoder().encode(JSON.stringify(value)));
}

function authorization(overrides: Partial<RuntimeProxyAuthorization> = {}): RuntimeProxyAuthorization {
  return {
    executionId: EXECUTION,
    provider: "slack",
    bindingId: "binding-1",
    purpose: "execution",
    scopeHash: "a".repeat(64),
    authorizationRevision: "slack:3:7",
    credentialGeneration: "3:7",
    sessionId: SESSION,
    accountId: randomUUID(),
    agentId: randomUUID(),
    cli: { provider: "slack", teamId: "T", botUserId: "B" },
    resolveMaterial: async () => ({ kind: "bearer", token: "real-token", origin: "https://slack.com" }),
    recheck: async () => undefined,
    ...overrides,
  };
}

function adapter(
  options: {
    provider?: "slack" | "feishu";
    fetchImpl?: typeof fetch;
    urlHandles?: RuntimeUrlHandleStore;
    publicOrigin?: string;
    resolveTaskAnchor?: (input: {
      sessionId: string;
      source?: RuntimeProxyAuthorization["source"];
      signal?: AbortSignal;
    }) => Promise<SessionTaskAnchorResolution>;
    outboundCapture?: OutboundWriteCapture;
  } = {},
) {
  const provider = options.provider ?? "slack";
  const urlHandles = options.urlHandles ?? new RuntimeUrlHandleStore();
  const instance = new ImProviderProxyAdapter({
    provider,
    registry: new ProviderOperationRegistry(provider === "slack" ? SLACK_OPERATIONS : FEISHU_OPERATIONS),
    urlHandles,
    ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
    ...(options.resolveTaskAnchor ? { resolveTaskAnchor: options.resolveTaskAnchor } : {}),
    ...(options.outboundCapture ? { outboundCapture: options.outboundCapture } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return { instance, urlHandles };
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

async function readBody(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded; charset=utf-8" };

interface CapturedCall {
  body: string;
  headers: Record<string, string>;
  method: string;
  url: string;
}

function captureFetch(payload: unknown = { ok: true, ts: "1710000000.000100" }): {
  calls: CapturedCall[];
  fetchImpl: typeof fetch;
} {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = init?.body;
    calls.push({
      body: body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : "",
      headers: (init?.headers ?? {}) as Record<string, string>,
      method: init?.method ?? "GET",
      url: String(input),
    });
    return jsonResponse(payload);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("ImProviderProxyAdapter operation registration", () => {
  it("validates Feishu bot identity while rejecting metadata and business operations in validation", async () => {
    const { calls, fetchImpl } = captureFetch({ code: 0, bot: { open_id: "ou_bot" } });
    const { instance } = adapter({ provider: "feishu", fetchImpl });
    const auth = authorization({
      provider: "feishu",
      purpose: "validation",
      resolveMaterial: async () => ({ kind: "bearer", token: "synthetic-token", origin: "https://open.feishu.cn" }),
    });
    const identity = await instance.handle(
      request({ provider: "feishu", method: "GET", path: "/open-apis/bot/v3/info" }),
      auth,
    );
    expect(JSON.parse(await readBody(identity.body))).toEqual({ code: 0, bot: { open_id: "ou_bot" } });
    expect(calls).toHaveLength(1);
    for (const [method, path, code] of [
      ["GET", "/api/tools/open/api_definition?protocol=meta&client_version=1.0.92", "validation_scope"],
      ["GET", "/open-apis/im/v1/chats", "validation_scope"],
      ["POST", "/open-apis/im/v1/messages", "validation_scope"],
      ["POST", "/api/tools/open/api_definition", "operation_not_registered"],
      ["GET", "/api/tools/open/unknown", "operation_not_registered"],
    ] as const) {
      await expect(instance.handle(request({ provider: "feishu", method, path }), auth)).rejects.toMatchObject({
        code,
      });
    }
    expect(calls).toHaveLength(1);
    const metadata = await instance.handle(
      request({
        provider: "feishu",
        method: "GET",
        path: "/api/tools/open/api_definition?protocol=meta&client_version=1.0.92",
      }),
      { ...auth, purpose: "execution" },
    );
    expect(metadata.status).toBe(200);
    expect(calls.at(-1)?.url).toBe(
      "https://open.feishu.cn/api/tools/open/api_definition?protocol=meta&client_version=1.0.92",
    );
  });

  it("rejects unregistered methods, paths, and providers", async () => {
    const { instance } = adapter();
    await expect(instance.handle(request({ method: "GET" }), authorization())).rejects.toMatchObject({
      code: "operation_not_registered",
    });
    await expect(instance.handle(request({ path: "/api/oauth.v2.access" }), authorization())).rejects.toMatchObject({
      code: "operation_not_registered",
    });
    await expect(
      instance.handle(request({ path: "/open-apis/bot/v3/info", method: "GET" }), authorization()),
    ).rejects.toMatchObject({ code: "operation_not_registered" });
  });

  it("rejects path confusion variants before template matching", async () => {
    const { instance } = adapter();
    for (const path of [
      "//api/chat.postMessage",
      "/api/../chat.postMessage",
      "/api/%2fchat.postMessage",
      "/api\\chat.postMessage",
      "api/chat.postMessage",
    ]) {
      await expect(instance.handle(request({ path }), authorization())).rejects.toMatchObject({
        code: "operation_not_registered",
      });
    }
  });

  it("strips caller identity headers and rejects the reserved internal header", async () => {
    const { instance } = adapter();
    await expect(instance.handle(request({ headers: { cookie: "session=x" } }), authorization())).rejects.toMatchObject(
      { code: "header_rejected" },
    );
    await expect(
      instance.handle(request({ headers: { "x-opentag-binding-id": "binding-2" } }), authorization()),
    ).rejects.toMatchObject({ code: "header_rejected" });
  });

  it("bounds JSON bodies", async () => {
    const { instance } = adapter();
    const oversized = new TextEncoder().encode(JSON.stringify({ text: "x".repeat(140 * 1024) }));
    await expect(instance.handle(request({ body: bodyOf(oversized) }), authorization())).rejects.toMatchObject({
      code: "body_too_large",
    });
  });

  it("restricts validation-purpose executions to read-only identity calls", async () => {
    const { instance } = adapter();
    await expect(instance.handle(request(), authorization({ purpose: "validation" }))).rejects.toMatchObject({
      code: "validation_scope",
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, user_id: "U1" }));
    const direct = adapter({ fetchImpl });
    await expect(
      direct.instance.handle(
        request({ path: "/api/auth.test" }),
        authorization({ purpose: "validation", provider: "slack" }),
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("ImProviderProxyAdapter upstream requests", () => {
  it("reconstructs a fixed-origin request with only the server token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ ok: true, ts: "1" });
    }) as typeof fetch;
    const { instance } = adapter({ fetchImpl });
    const response = await instance.handle(request({ headers: {} }), authorization());
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer real-token");
    expect(headers.cookie).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("answers the Feishu tenant token endpoint locally with a harmless sentinel", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { instance } = adapter({ provider: "feishu", fetchImpl });
    const response = await instance.handle(
      request({
        provider: "feishu",
        path: "/open-apis/auth/v3/tenant_access_token/internal",
        body: jsonBody({ app_id: "cli_a", app_secret: "secret" }),
      }),
      authorization({ provider: "feishu", cli: { provider: "feishu", appId: "cli_a", teamBrand: "feishu" } }),
    );
    const payload = JSON.parse(await readBody(response.body)) as Record<string, unknown>;
    expect(payload.tenant_access_token).toBe(FEISHU_TENANT_TOKEN_LOCAL_SENTINEL);
    expect(payload.tenant_access_token).not.toBe("c".repeat(43));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("makes exactly one upstream attempt and relays a definite provider rejection", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return jsonResponse({ ok: false, error: "channel_not_found" });
    }) as typeof fetch;
    const { instance } = adapter({ fetchImpl });
    const response = await instance.handle(
      request({ body: jsonBody({ channel: "C1", text: "hello" }) }),
      authorization(),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(await readBody(response.body))).toMatchObject({ ok: false, error: "channel_not_found" });
    expect(calls).toHaveLength(1);
  });

  it("filters protected response headers", async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { ok: true },
        { headers: { "set-cookie": "secret=1", "content-type": "application/json", "x-request-id": "r1" } },
      )) as typeof fetch;
    const { instance } = adapter({ fetchImpl });
    const response = await instance.handle(request({ path: "/api/auth.test" }), authorization());
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["x-request-id"]).toBe("r1");
  });
});

describe("ImProviderProxyAdapter protected handles", () => {
  const fileInfo = {
    ok: true,
    file: { id: "F1", name: "report.txt", url_private: "https://files.slack.com/files-pri/T-F/report" },
  };

  it("rewrites native signed URLs to fixed-origin handles", async () => {
    const fetchImpl = (async () => jsonResponse(fileInfo)) as typeof fetch;
    const { instance, urlHandles } = adapter({ fetchImpl });
    const response = await instance.handle(
      request({ path: "/api/files.info", body: jsonBody({ file: "F1" }) }),
      authorization(),
    );
    const payload = JSON.parse(await readBody(response.body)) as {
      file: { url_private: string };
    };
    expect(payload.file.url_private).toMatch(/^https:\/\/slack\.com\/__opentag__\/handles\/[A-Za-z0-9_-]+$/);
    expect(payload.file.url_private).not.toContain("files.slack.com");
    expect(urlHandles.size).toBe(1);
  });

  it("proxies a download handle with the current token, revalidation, and allowlisted redirects", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url === "https://files.slack.com/files-pri/T-F/report") {
        return new Response(null, { status: 302, headers: { location: "https://files.slack.com/signed/abc" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    const recheck = vi.fn(async () => undefined);
    const { instance, urlHandles } = adapter({ fetchImpl });
    const handleId = urlHandles.create({
      executionId: EXECUTION,
      provider: "slack",
      kind: "download",
      url: "https://files.slack.com/files-pri/T-F/report",
    });
    const response = await instance.handle(
      request({
        method: "GET",
        path: `/__opentag__/handles/${handleId}`,
        headers: {},
        body: bodyOf(),
      }),
      authorization({ recheck }),
    );
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      "https://files.slack.com/files-pri/T-F/report",
      "https://files.slack.com/signed/abc",
    ]);
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer real-token");
    expect(recheck).toHaveBeenCalledTimes(2);
    expect(await readBody(response.body)).toBe(Buffer.from([1, 2, 3]).toString("utf8"));
  });

  it("rejects a redirect hop outside the provider allowlist", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.com/steal" },
      })) as typeof fetch;
    const { instance, urlHandles } = adapter({ fetchImpl });
    const handleId = urlHandles.create({
      executionId: EXECUTION,
      provider: "slack",
      kind: "download",
      url: "https://files.slack.com/files-pri/T-F/report",
    });
    await expect(
      instance.handle(
        request({ method: "GET", path: `/__opentag__/handles/${handleId}`, body: bodyOf() }),
        authorization(),
      ),
    ).rejects.toMatchObject({ code: "handle_invalid" });
  });

  it("serves a download handle minted by a write response with a fresh fence check", async () => {
    const file = { id: "F1", thumb_360: "https://files.slack.com/files-tmb/T-F/thumb.png" };
    const recheck = vi.fn(async () => undefined);
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/api/chat.postMessage")) return jsonResponse({ ok: true, message: { files: [file] } });
      return new Response("downloaded body", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    const { instance } = adapter({ fetchImpl });
    const write = await instance.handle(request({ body: jsonBody({ channel: "C1", text: "hi" }) }), authorization());
    const payload = JSON.parse(await readBody(write.body)) as { message: { files: Array<{ thumb_360: string }> } };
    const handlePath = new URL(payload.message.files[0]?.thumb_360 ?? "").pathname;
    expect(handlePath).toMatch(/^\/__opentag__\/handles\//);

    const response = await instance.handle(
      request({ method: "GET", path: handlePath, body: bodyOf() }),
      authorization({ recheck }),
    );
    expect(response.status).toBe(200);
    expect(recheck).toHaveBeenCalled();
    expect(await readBody(response.body)).toBe("downloaded body");
  });

  it("binds handles to the exact execution, provider, and kind", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    const { instance, urlHandles } = adapter({ fetchImpl });
    const handleId = urlHandles.create({
      executionId: randomUUID(),
      provider: "slack",
      kind: "upload",
      url: "https://files.slack.com/upload/v1/ABC",
    });
    await expect(
      instance.handle(request({ method: "POST", path: `/__opentag__/handles/${handleId}` }), authorization()),
    ).rejects.toMatchObject({ code: "handle_invalid" });
  });
});

describe("RuntimeProxyError", () => {
  it("names the failure code", () => {
    expect(new RuntimeProxyError("cancelled").code).toBe("cancelled");
  });
});

describe("ImProviderProxyAdapter native Slack form bodies", () => {
  it.each([
    ["files.info", { file: "F1", count: 20, token: "caller-token" }, "file=F1&count=20"],
    ["conversations.info", { channel: "C1", include_num_members: true }, "channel=C1&include_num_members=true"],
    ["users.info", { user: "U1" }, "user=U1"],
    ["auth.test", {}, ""],
  ])("encodes explicit JSON for the legacy %s read endpoint", async (method, params, expectedBody) => {
    const { calls, fetchImpl } = captureFetch();
    const { instance } = adapter({ fetchImpl });
    await instance.handle(
      request({ path: `/api/${method}`, headers: { "content-type": "application/json" }, body: jsonBody(params) }),
      authorization(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0]?.body).toBe(expectedBody);
  });

  it.each([null, [], "file=F1"])("rejects non-object JSON read parameters before upstream: %j", async (params) => {
    const { calls, fetchImpl } = captureFetch();
    const { instance } = adapter({ fetchImpl });
    await expect(
      instance.handle(request({ path: "/api/files.info", body: jsonBody(params) }), authorization()),
    ).rejects.toMatchObject({ code: "body_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("bounds the expanded form encoding before upstream", async () => {
    const { calls, fetchImpl } = captureFetch();
    const { instance } = adapter({ fetchImpl });
    await expect(
      instance.handle(
        request({ path: "/api/files.info", body: jsonBody({ file: "中".repeat(20_000) }) }),
        authorization(),
      ),
    ).rejects.toMatchObject({ code: "body_too_large" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    {
      form: "file=F1&token=otrh_local",
      forwarded: "file=F1",
      operation: "files.info",
      path: "/api/files.info",
    },
    {
      forwarded: "channel=C-FIXTURE&text=native+acceptance",
      form: "channel=C-FIXTURE&text=native+acceptance&token=otrh_local",
      operation: "chat.postMessage",
      path: "/api/chat.postMessage",
    },
    {
      forwarded: "channel=C-FIXTURE&ts=1710000000.000100&text=native+acceptance+updated",
      form: "channel=C-FIXTURE&ts=1710000000.000100&text=native+acceptance+updated&token=otrh_local",
      operation: "chat.update",
      path: "/api/chat.update",
    },
    {
      forwarded: "channel=C-FIXTURE&ts=1710000000.000100",
      form: "channel=C-FIXTURE&ts=1710000000.000100&token=otrh_local",
      operation: "chat.delete",
      path: "/api/chat.delete",
    },
    {
      forwarded: "filename=upload.bin&length=1048576",
      form: "filename=upload.bin&length=1048576&token=otrh_local",
      operation: "files.getUploadURLExternal",
      path: "/api/files.getUploadURLExternal",
    },
    {
      forwarded: "channel_id=C-FIXTURE&files=%5B%7B%22id%22%3A%22F_FIXTURE%22%7D%5D",
      form: "channel_id=C-FIXTURE&files=%5B%7B%22id%22%3A%22F_FIXTURE%22%7D%5D&token=otrh_local",
      operation: "files.completeUploadExternal",
      path: "/api/files.completeUploadExternal",
    },
  ])("forwards the native $operation form body untouched in one upstream attempt", async (fixture) => {
    const { calls, fetchImpl } = captureFetch();
    const { instance } = adapter({ fetchImpl });

    const response = await instance.handle(
      request({ path: fixture.path, headers: FORM_HEADERS, body: bodyOf(new TextEncoder().encode(fixture.form)) }),
      authorization(),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `https://slack.com${fixture.path}` });
    expect(calls[0]?.headers).toMatchObject({
      authorization: "Bearer real-token",
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    });
    expect(calls[0]?.body).toBe(fixture.forwarded);
  });

  it("keeps auth.test working with the empty scrubbed native form body", async () => {
    const { calls, fetchImpl } = captureFetch({ ok: true, user_id: "U1" });
    const { instance } = adapter({ fetchImpl });
    const response = await instance.handle(
      request({ path: "/api/auth.test", headers: FORM_HEADERS, body: bodyOf() }),
      authorization(),
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded; charset=utf-8");
    expect(calls[0]?.body).toBe("");
  });

  it("keeps JSON semantics and strips the caller token in explicit JSON mode", async () => {
    const explicit = captureFetch();
    const { instance } = adapter({ fetchImpl: explicit.fetchImpl });
    await expect(
      instance.handle(
        request({
          headers: { "content-type": "application/json" },
          body: jsonBody({ channel: "C1", text: "hello", token: "otrh_local" }),
        }),
        authorization(),
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(explicit.calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(explicit.calls[0]?.body ?? "{}")).toEqual({ channel: "C1", text: "hello" });

    // Legacy default (no caller content-type) keeps the previous JSON behavior.
    const legacy = captureFetch();
    const legacyAdapter = adapter({ fetchImpl: legacy.fetchImpl });
    await expect(
      legacyAdapter.instance.handle(request({ body: jsonBody({ channel: "C2", text: "legacy" }) }), authorization()),
    ).resolves.toMatchObject({ status: 200 });
    expect(legacy.calls[0]?.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(legacy.calls[0]?.body ?? "{}")).toEqual({ channel: "C2", text: "legacy" });
  });

  it.each([
    ["a duplicate resource field", "channel=C1&channel=C2", "body_invalid"],
    ["a duplicate credential field", "token=otrh_a&token=otrh_b", "body_invalid"],
    ["malformed percent encoding", "text=%zz", "body_invalid"],
  ])("rejects %s before any upstream call", async (_case, form, code) => {
    const { calls, fetchImpl } = captureFetch();
    const { instance } = adapter({ fetchImpl });
    await expect(
      instance.handle(
        request({ headers: FORM_HEADERS, body: bodyOf(new TextEncoder().encode(form)) }),
        authorization(),
      ),
    ).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(0);
  });

  it("rejects an oversized native form before upstream", async () => {
    const { calls, fetchImpl } = captureFetch();
    const { instance } = adapter({ fetchImpl });
    const oversized = new TextEncoder().encode(`text=${"x".repeat(140 * 1024)}`);
    await expect(
      instance.handle(request({ headers: FORM_HEADERS, body: bodyOf(oversized) }), authorization()),
    ).rejects.toMatchObject({ code: "body_too_large" });
    expect(calls).toHaveLength(0);
  });

  it("rejects an unsupported content type without buffering the body", async () => {
    let iterated = false;
    const body: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        iterated = true;
        yield new TextEncoder().encode("irrelevant");
      },
    };
    const { calls, fetchImpl } = captureFetch();
    const { instance } = adapter({ fetchImpl });
    await expect(
      instance.handle(
        request({ headers: { "content-type": "multipart/form-data; boundary=----opentag" }, body }),
        authorization(),
      ),
    ).rejects.toMatchObject({ code: "body_invalid" });
    expect(iterated).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects ambiguous or conflicting Slack query resources", async () => {
    const { calls, fetchImpl } = captureFetch();
    const { instance } = adapter({ fetchImpl });
    const reject = (path: string, form: string) =>
      expect(
        instance.handle(
          request({ path, headers: FORM_HEADERS, body: bodyOf(new TextEncoder().encode(form)) }),
          authorization(),
        ),
      ).rejects.toMatchObject({ code: "body_invalid" });
    await reject("/api/chat.delete?channel=C1", "channel=C2&ts=1");
    await reject("/api/chat.delete?channel=C1&channel=C2", "ts=1");
    await reject("/api/chat.delete?token=otrh_query", "ts=1");
    expect(calls).toHaveLength(0);
  });

  it("uses and forwards the query resource when the native form omits it", async () => {
    const { calls, fetchImpl } = captureFetch();
    const { instance } = adapter({ fetchImpl });
    const response = await instance.handle(
      request({
        path: "/api/chat.delete?channel=C-QUERY",
        headers: FORM_HEADERS,
        body: bodyOf(new TextEncoder().encode("ts=171")),
      }),
      authorization(),
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe("https://slack.com/api/chat.delete?channel=C-QUERY");
  });
});

describe("ImProviderProxyAdapter write outcomes", () => {
  function statusFetch(status: number, payload: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
  }

  it("relays a proven success (HTTP 2xx plus explicit provider success evidence)", async () => {
    const { calls, fetchImpl } = captureFetch({ ok: true, ts: "1" });
    const { instance } = adapter({ fetchImpl });
    await expect(
      instance.handle(request({ body: jsonBody({ channel: "C1", text: "hello" }) }), authorization()),
    ).resolves.toMatchObject({ status: 200 });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["an ambiguous 5xx provider failure", 503, { ok: false, error: "server_error" }],
    ["a 408 provider timeout", 408, { ok: true, ts: "1" }],
    ["a 2xx response without success evidence", 200, {}],
  ])("surfaces %s as write_outcome_unknown, never a successful write", async (_label, status, payload) => {
    const fetchImpl = vi.fn(statusFetch(status, payload));
    const { instance } = adapter({ fetchImpl: fetchImpl as typeof fetch });
    await expect(
      instance.handle(request({ body: jsonBody({ channel: "C1" }) }), authorization()),
    ).rejects.toMatchObject({ code: "write_outcome_unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("converts an unparseable write response to write_outcome_unknown but preserves response_invalid for reads", async () => {
    const malformed = (async () =>
      new Response("this is not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const { instance } = adapter({ fetchImpl: malformed });
    await expect(
      instance.handle(request({ body: jsonBody({ channel: "C1" }) }), authorization()),
    ).rejects.toMatchObject({ code: "write_outcome_unknown" });
    await expect(instance.handle(request({ path: "/api/auth.test" }), authorization())).rejects.toMatchObject({
      code: "response_invalid",
    });
  });

  it("keeps pre-send fence failures intact with zero upstream calls", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { instance } = adapter({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const stale = authorization({
      recheck: async () => {
        throw Object.assign(new Error("revoked"), { code: "credential_stale" });
      },
    });
    await expect(instance.handle(request({ body: jsonBody({ channel: "C1" }) }), stale)).rejects.toMatchObject({
      code: "credential_stale",
    });
    const materialGone = authorization({
      resolveMaterial: async () => {
        throw Object.assign(new Error("closed"), { code: "execution_closed" });
      },
    });
    await expect(instance.handle(request({ body: jsonBody({ channel: "C1" }) }), materialGone)).rejects.toMatchObject({
      code: "execution_closed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["rejected", 10014, 400],
    ["rate_limited", 99991400, 429],
  ] as const)(
    "answers a %s Feishu token exchange in Feishu's shape without any upstream call",
    async (kind, code, status) => {
      const fetchImpl = vi.fn();
      const { instance } = adapter({ fetchImpl: fetchImpl as unknown as typeof fetch });
      const response = await instance.handle(
        request({ body: jsonBody({ channel: "C1" }) }),
        authorization({
          resolveMaterial: async () => {
            throw new FeishuTenantTokenExchangeError(kind, code);
          },
        }),
      );
      expect(response.status).toBe(status);
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body) chunks.push(chunk);
      expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({ code });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("keeps an unreachable Feishu token endpoint a proxy failure", async () => {
    const { instance } = adapter({ fetchImpl: vi.fn() as unknown as typeof fetch });
    const error = new FeishuTenantTokenExchangeError("upstream");
    await expect(
      instance.handle(
        request({ body: jsonBody({ channel: "C1" }) }),
        authorization({
          resolveMaterial: async () => {
            throw error;
          },
        }),
      ),
    ).rejects.toBe(error);
  });

  it("never replays a write after a transport failure; a caller retry is a fresh upstream request", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const { instance } = adapter({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      instance.handle(request({ body: jsonBody({ channel: "C1" }) }), authorization()),
    ).rejects.toMatchObject({ code: "write_outcome_unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A caller-initiated new request is a fresh single attempt; the proxy itself never replays.
    const second = captureFetch();
    const retry = adapter({ fetchImpl: second.fetchImpl });
    await expect(
      retry.instance.handle(request({ body: jsonBody({ channel: "C1" }) }), authorization()),
    ).resolves.toMatchObject({ status: 200 });
    expect(second.calls).toHaveLength(1);
  });
});

describe("ImProviderProxyAdapter upload handles", () => {
  function uploadRequest(handleId: string, body: AsyncIterable<Uint8Array>): ProviderProxyRequest {
    return request({
      method: "POST",
      path: `/__opentag__/handles/${handleId}`,
      headers: { "content-type": "application/octet-stream" },
      body,
    });
  }

  function uploadHandle(urlHandles: RuntimeUrlHandleStore): string {
    return urlHandles.create({
      executionId: EXECUTION,
      provider: "slack",
      kind: "upload",
      url: "https://files.slack.com/upload/v1/ABC",
    });
  }

  it("revalidates the live fence before the first upstream byte and relays a 2xx", async () => {
    const urlHandles = new RuntimeUrlHandleStore();
    const handleId = uploadHandle(urlHandles);
    const order: string[] = [];
    const forwarded: string[] = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      order.push("fetch");
      const body = init?.body;
      if (!body) throw new Error("upload body is missing");
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        forwarded.push(Buffer.from(chunk).toString("utf8"));
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const recheck = vi.fn(async () => {
      order.push("recheck");
    });
    const { instance } = adapter({ fetchImpl, urlHandles });

    const response = await instance.handle(
      uploadRequest(handleId, bodyOf(new TextEncoder().encode("file-"), new TextEncoder().encode("bytes"))),
      authorization({ recheck }),
    );
    expect(response.status).toBe(200);
    expect(order).toEqual(["recheck", "fetch"]);
    expect(forwarded.join("")).toBe("file-bytes");
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(await readBody(response.body)).toContain('"ok":true');
  });

  it("relays a definite 4xx upload rejection", async () => {
    const urlHandles = new RuntimeUrlHandleStore();
    const handleId = uploadHandle(urlHandles);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const { instance } = adapter({ fetchImpl, urlHandles });

    const response = await instance.handle(
      uploadRequest(handleId, bodyOf(new TextEncoder().encode("denied"))),
      authorization(),
    );
    expect(response.status).toBe(403);
  });

  it("surfaces an ambiguous 5xx upload as write_outcome_unknown after exactly one attempt", async () => {
    const urlHandles = new RuntimeUrlHandleStore();
    const handleId = uploadHandle(urlHandles);
    const fetchImpl = vi.fn(
      (async () =>
        new Response(JSON.stringify({}), {
          status: 503,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );
    const { instance } = adapter({ fetchImpl, urlHandles });

    await expect(
      instance.handle(uploadRequest(handleId, bodyOf(new TextEncoder().encode("bytes"))), authorization()),
    ).rejects.toMatchObject({ code: "write_outcome_unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces an upload transport failure as write_outcome_unknown without replaying", async () => {
    const urlHandles = new RuntimeUrlHandleStore();
    const handleId = uploadHandle(urlHandles);
    const fetchImpl = vi.fn((async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch);
    const { instance } = adapter({ fetchImpl, urlHandles });
    await expect(
      instance.handle(uploadRequest(handleId, bodyOf(new TextEncoder().encode("bytes"))), authorization()),
    ).rejects.toMatchObject({ code: "write_outcome_unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves the pre-send fence error for an upload with zero upstream calls", async () => {
    const urlHandles = new RuntimeUrlHandleStore();
    const handleId = uploadHandle(urlHandles);
    const fetchImpl = vi.fn(async () => new Response("never", { status: 200 })) as unknown as typeof fetch;
    const { instance } = adapter({ fetchImpl, urlHandles });
    const stale = authorization({
      recheck: async () => {
        throw Object.assign(new Error("revoked"), { code: "credential_stale" });
      },
    });
    await expect(
      instance.handle(uploadRequest(handleId, bodyOf(new TextEncoder().encode("bytes"))), stale),
    ).rejects.toMatchObject({ code: "credential_stale" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("ImProviderProxyAdapter Session ID footer", () => {
  const AGENT_ID = "11111111-2222-3333-4444-555555555555";
  const SESSION_ID = "12345678-aaaa-bbbb-cccc-ddddeeeeffff";
  const SHORT_ID = "12345678";
  const PUBLIC_ORIGIN = "https://opentag.example.com/";
  const SESSION_URL = `https://opentag.example.com/agents/${AGENT_ID}/tasks/${SESSION_ID}`;

  it("appends the Session ID footer to Slack text, markdown_text, and blocks while keeping captured requestBody untouched", async () => {
    const capturedEvents: OutboundWriteCaptureEvent[] = [];
    const { calls, fetchImpl } = captureFetch({ ok: true, ts: "1710000000.000100" });
    const { instance } = adapter({
      fetchImpl,
      publicOrigin: PUBLIC_ORIGIN,
      outboundCapture: {
        capture: async (event) => {
          capturedEvents.push(event);
        },
      },
    });
    const originalBody = {
      channel: "C1",
      text: "Hello from Slack",
      markdown_text: "**Hello** from Slack",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Section text" } }],
    };

    await instance.handle(
      request({ sessionId: SESSION_ID, body: jsonBody(originalBody) }),
      authorization({ sessionId: SESSION_ID, agentId: AGENT_ID }),
    );

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      channel: "C1",
      text: `Hello from Slack\n\n_<${SESSION_URL}|Session ${SHORT_ID}>_`,
      markdown_text: `**Hello** from Slack\n\n_[Session ${SHORT_ID}](${SESSION_URL})_`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Section text" } },
        { type: "context", elements: [{ type: "mrkdwn", text: `<${SESSION_URL}|Session ${SHORT_ID}>` }] },
      ],
    });
    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]?.requestBody).toEqual(originalBody);
    expect(capturedEvents[0]?.injectedSessionFooter).toEqual({
      sessionUrl: SESSION_URL,
      shortId: SHORT_ID,
      slackTextAppended: `\n\n_<${SESSION_URL}|Session ${SHORT_ID}>_`,
      slackBlockTextAppended: `<${SESSION_URL}|Session ${SHORT_ID}>`,
    });
  });

  it("keeps Slack text (<= 4,000 chars) and markdown_text (<= 12,000 chars) within field limits in JSON and form modes without truncating Agent text", async () => {
    const capturedEvents: OutboundWriteCaptureEvent[] = [];
    const { calls, fetchImpl } = captureFetch({ ok: true, ts: "1710000000.000100" });
    const { instance } = adapter({
      fetchImpl,
      publicOrigin: PUBLIC_ORIGIN,
      outboundCapture: {
        capture: async (event) => {
          capturedEvents.push(event);
        },
      },
    });
    const maxText = "t".repeat(4_000);
    const maxMarkdown = "m".repeat(12_000);

    // JSON mode at exact field limits: sent unmodified, injectedSessionFooter omitted
    await instance.handle(
      request({
        sessionId: SESSION_ID,
        body: jsonBody({ channel: "C1", text: maxText, markdown_text: maxMarkdown }),
      }),
      authorization({ sessionId: SESSION_ID, agentId: AGENT_ID }),
    );
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      channel: "C1",
      text: maxText,
      markdown_text: maxMarkdown,
    });
    expect(capturedEvents[0]?.injectedSessionFooter).toBeUndefined();

    // Form mode at exact field limits: sent unmodified, injectedSessionFooter omitted
    const form = new URLSearchParams({
      channel: "C1",
      text: maxText,
      markdown_text: maxMarkdown,
    }).toString();
    await instance.handle(
      request({
        sessionId: SESSION_ID,
        headers: FORM_HEADERS,
        body: bodyOf(new TextEncoder().encode(form)),
      }),
      authorization({ sessionId: SESSION_ID, agentId: AGENT_ID }),
    );
    expect(calls[1]?.body).toBe(form);
    expect(capturedEvents[1]?.injectedSessionFooter).toBeUndefined();
  });

  it("omits injectedSessionFooter when the annotated payload exceeds maxBodyBytes and falls back to prepared.bytes", async () => {
    const capturedEvents: OutboundWriteCaptureEvent[] = [];
    const { calls, fetchImpl } = captureFetch({ code: 0, data: { message_id: "om_big" } });
    const { instance } = adapter({
      provider: "feishu",
      fetchImpl,
      publicOrigin: PUBLIC_ORIGIN,
      outboundCapture: {
        capture: async (event) => {
          capturedEvents.push(event);
        },
      },
    });
    const feishuAuth = authorization({
      provider: "feishu",
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      cli: { provider: "feishu", appId: "cli_a", teamBrand: "feishu" },
      resolveMaterial: async () => ({ kind: "bearer", token: "t-token", origin: "https://open.feishu.cn" }),
    });
    const footerLikeText = `Session abcdef01: https://other.example/agents/other-agent/tasks/abcdef01-0000`;
    const nearLimitPayload = {
      receive_id: "oc_1",
      msg_type: "text",
      content: JSON.stringify({ text: `${"x".repeat(128 * 1024 - 180)}\n\n${footerLikeText}` }),
    };

    await instance.handle(
      request({
        provider: "feishu",
        sessionId: SESSION_ID,
        path: "/open-apis/im/v1/messages?receive_id_type=chat_id",
        body: jsonBody(nearLimitPayload),
      }),
      feishuAuth,
    );

    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual(nearLimitPayload);
    expect(capturedEvents[0]?.injectedSessionFooter).toBeUndefined();
  });

  it("appends the Session ID footer to Slack form-encoded chat.postMessage requests", async () => {
    const { calls, fetchImpl } = captureFetch({ ok: true, ts: "1710000000.000100" });
    const { instance } = adapter({ fetchImpl, publicOrigin: PUBLIC_ORIGIN });
    const form = new URLSearchParams({
      channel: "C1",
      text: "Form reply",
      blocks: JSON.stringify([{ type: "section", text: { type: "mrkdwn", text: "Form block" } }]),
    }).toString();

    await instance.handle(
      request({
        sessionId: SESSION_ID,
        headers: FORM_HEADERS,
        body: bodyOf(new TextEncoder().encode(form)),
      }),
      authorization({ sessionId: SESSION_ID, agentId: AGENT_ID }),
    );

    const params = new URLSearchParams(calls[0]?.body ?? "");
    expect(params.get("text")).toBe(`Form reply\n\n_<${SESSION_URL}|Session ${SHORT_ID}>_`);
    expect(JSON.parse(params.get("blocks") ?? "[]")).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Form block" } },
      { type: "context", elements: [{ type: "mrkdwn", text: `<${SESSION_URL}|Session ${SHORT_ID}>` }] },
    ]);
  });

  it("appends the Session ID footer to Feishu text, post, and interactive v1/v2 messages", async () => {
    const { calls, fetchImpl } = captureFetch({ code: 0, data: { message_id: "om_1" } });
    const { instance } = adapter({ provider: "feishu", fetchImpl, publicOrigin: PUBLIC_ORIGIN });
    const feishuAuth = authorization({
      provider: "feishu",
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      cli: { provider: "feishu", appId: "cli_a", teamBrand: "feishu" },
      resolveMaterial: async () => ({ kind: "bearer", token: "t-token", origin: "https://open.feishu.cn" }),
    });

    // 1. Feishu text
    await instance.handle(
      request({
        provider: "feishu",
        sessionId: SESSION_ID,
        path: "/open-apis/im/v1/messages?receive_id_type=chat_id",
        body: jsonBody({ receive_id: "oc_1", msg_type: "text", content: JSON.stringify({ text: "Hello Feishu" }) }),
      }),
      feishuAuth,
    );
    expect(JSON.parse(JSON.parse(calls[0]?.body ?? "{}").content)).toEqual({
      text: `Hello Feishu\n\nSession ${SHORT_ID}: ${SESSION_URL}`,
    });

    // 2. Feishu post (top-level and locale-wrapped)
    await instance.handle(
      request({
        provider: "feishu",
        sessionId: SESSION_ID,
        path: "/open-apis/im/v1/messages/om_parent/reply",
        body: jsonBody({
          msg_type: "post",
          content: JSON.stringify({
            zh_cn: { title: "Title", content: [[{ tag: "text", text: "Line 1" }]] },
          }),
        }),
      }),
      feishuAuth,
    );
    expect(JSON.parse(JSON.parse(calls[1]?.body ?? "{}").content)).toEqual({
      zh_cn: {
        title: "Title",
        content: [[{ tag: "text", text: "Line 1" }], [{ tag: "a", text: `Session ${SHORT_ID}`, href: SESSION_URL }]],
      },
    });

    // 3. Feishu interactive Card v2
    await instance.handle(
      request({
        provider: "feishu",
        sessionId: SESSION_ID,
        path: "/open-apis/im/v1/messages?receive_id_type=chat_id",
        body: jsonBody({
          receive_id: "oc_1",
          msg_type: "interactive",
          content: JSON.stringify({
            schema: "2.0",
            body: { elements: [{ tag: "markdown", content: "Card v2 body" }] },
          }),
        }),
      }),
      feishuAuth,
    );
    expect(JSON.parse(JSON.parse(calls[2]?.body ?? "{}").content)).toEqual({
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: "Card v2 body" },
          { tag: "markdown", text_size: "notation", content: `[Session ${SHORT_ID}](${SESSION_URL})` },
        ],
      },
    });

    // 4. Feishu interactive Card v1
    await instance.handle(
      request({
        provider: "feishu",
        sessionId: SESSION_ID,
        path: "/open-apis/im/v1/messages?receive_id_type=chat_id",
        body: jsonBody({
          receive_id: "oc_1",
          msg_type: "interactive",
          content: JSON.stringify({
            elements: [{ tag: "div", text: { tag: "lark_md", content: "Card v1 body" } }],
          }),
        }),
      }),
      feishuAuth,
    );
    expect(JSON.parse(JSON.parse(calls[3]?.body ?? "{}").content)).toEqual({
      elements: [
        { tag: "div", text: { tag: "lark_md", content: "Card v1 body" } },
        { tag: "note", elements: [{ tag: "lark_md", content: `[Session ${SHORT_ID}](${SESSION_URL})` }] },
      ],
    });
  });

  it("uses resolveTaskAnchor for the task URL while keeping Session <shortId> as the visible label, renders plain Session <shortId> when anchor is plain, and annotates message edits", async () => {
    const ANCHOR_A = "aaaa0000-1111-2222-3333-444444444444";
    const ANCHOR_B = "bbbb0000-1111-2222-3333-444444444444";
    let currentResolution: SessionTaskAnchorResolution = { kind: "link", taskAnchorId: ANCHOR_A };
    const slackCalls = captureFetch({ ok: true, ts: "1710000000.000100" });
    const slackAdapter = adapter({
      fetchImpl: slackCalls.fetchImpl,
      publicOrigin: PUBLIC_ORIGIN,
      resolveTaskAnchor: async () => currentResolution,
    });

    // Send A on group channel Session resolves URL to ANCHOR_A
    await slackAdapter.instance.handle(
      request({
        sessionId: SESSION_ID,
        path: "/api/chat.postMessage",
        body: jsonBody({ channel: "C1", text: "Reply to request A" }),
      }),
      authorization({ sessionId: SESSION_ID, agentId: AGENT_ID }),
    );
    const urlA = `https://opentag.example.com/agents/${AGENT_ID}/tasks/${ANCHOR_A}`;
    expect(JSON.parse(slackCalls.calls[0]?.body ?? "{}").text).toBe(
      `Reply to request A\n\n_<${urlA}|Session ${SHORT_ID}>_`,
    );

    // Edit via Slack chat.update also appends the footer idempotently
    await slackAdapter.instance.handle(
      request({
        sessionId: SESSION_ID,
        path: "/api/chat.update",
        body: jsonBody({ channel: "C1", ts: "1710000000.000100", text: "Edited reply A" }),
      }),
      authorization({ sessionId: SESSION_ID, agentId: AGENT_ID }),
    );
    expect(JSON.parse(slackCalls.calls[1]?.body ?? "{}").text).toBe(
      `Edited reply A\n\n_<${urlA}|Session ${SHORT_ID}>_`,
    );

    // Plain resolution (e.g. session-message on a group channel Session) renders plain Session <shortId> without link
    currentResolution = { kind: "plain" };
    await slackAdapter.instance.handle(
      request({
        sessionId: SESSION_ID,
        path: "/api/chat.postMessage",
        body: jsonBody({
          channel: "C1",
          text: "Plain reply",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "Plain block" } }],
        }),
      }),
      authorization({ sessionId: SESSION_ID, agentId: AGENT_ID }),
    );
    expect(JSON.parse(slackCalls.calls[2]?.body ?? "{}")).toEqual({
      channel: "C1",
      text: `Plain reply\n\n_Session ${SHORT_ID}_`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Plain block" } },
        { type: "context", elements: [{ type: "mrkdwn", text: `Session ${SHORT_ID}` }] },
      ],
    });

    // Second top-level request B on the same group channel Session resolves URL to ANCHOR_B
    currentResolution = { kind: "link", taskAnchorId: ANCHOR_B };
    const urlB = `https://opentag.example.com/agents/${AGENT_ID}/tasks/${ANCHOR_B}`;
    const feishuCalls = captureFetch({ code: 0, data: { message_id: "om_edit" } });
    const feishuAdapter = adapter({
      provider: "feishu",
      fetchImpl: feishuCalls.fetchImpl,
      publicOrigin: PUBLIC_ORIGIN,
      resolveTaskAnchor: async () => currentResolution,
    });
    const feishuAuth = authorization({
      provider: "feishu",
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      cli: { provider: "feishu", appId: "cli_a", teamBrand: "feishu" },
      resolveMaterial: async () => ({ kind: "bearer", token: "t-token", origin: "https://open.feishu.cn" }),
    });
    await feishuAdapter.instance.handle(
      request({
        provider: "feishu",
        sessionId: SESSION_ID,
        method: "PUT",
        path: "/open-apis/im/v1/messages/om_edit",
        body: jsonBody({ msg_type: "text", content: JSON.stringify({ text: "Updated Feishu reply B" }) }),
      }),
      feishuAuth,
    );
    expect(JSON.parse(JSON.parse(feishuCalls.calls[0]?.body ?? "{}").content)).toEqual({
      text: `Updated Feishu reply B\n\nSession ${SHORT_ID}: ${urlB}`,
    });
  });

  it("tracks exact per-component footer provenance when Slack text or a Feishu post locale already contains the footer", async () => {
    const capturedEvents: OutboundWriteCaptureEvent[] = [];
    const slackCalls = captureFetch({ ok: true, ts: "1710000000.000100" });
    const slackAdapter = adapter({
      fetchImpl: slackCalls.fetchImpl,
      publicOrigin: PUBLIC_ORIGIN,
      outboundCapture: {
        capture: async (event) => {
          capturedEvents.push(event);
        },
      },
    });
    const preAnnotatedText = `Reference body\n\n_<${SESSION_URL}|Session ${SHORT_ID}>_`;
    await slackAdapter.instance.handle(
      request({
        sessionId: SESSION_ID,
        body: jsonBody({
          channel: "C1",
          text: preAnnotatedText,
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "Block without link" } }],
        }),
      }),
      authorization({ sessionId: SESSION_ID, agentId: AGENT_ID }),
    );
    // text was NOT modified, only blocks was modified -> slackTextAppended is undefined!
    expect(JSON.parse(slackCalls.calls[0]?.body ?? "{}").text).toBe(preAnnotatedText);
    expect(capturedEvents[0]?.injectedSessionFooter).toEqual({
      shortId: SHORT_ID,
      sessionUrl: SESSION_URL,
      slackBlockTextAppended: `<${SESSION_URL}|Session ${SHORT_ID}>`,
    });

    const feishuCaptured: OutboundWriteCaptureEvent[] = [];
    const feishuCalls = captureFetch({ code: 0, data: { message_id: "om_post_mixed" } });
    const feishuAdapter = adapter({
      provider: "feishu",
      fetchImpl: feishuCalls.fetchImpl,
      publicOrigin: PUBLIC_ORIGIN,
      outboundCapture: {
        capture: async (event) => {
          feishuCaptured.push(event);
        },
      },
    });
    await feishuAdapter.instance.handle(
      request({
        provider: "feishu",
        sessionId: SESSION_ID,
        path: "/open-apis/im/v1/messages?receive_id_type=chat_id",
        body: jsonBody({
          receive_id: "oc_1",
          msg_type: "post",
          content: JSON.stringify({
            zh_cn: {
              title: "ZH",
              content: [
                [{ tag: "text", text: "ZH body" }],
                [{ tag: "a", text: `Session ${SHORT_ID}`, href: SESSION_URL }],
              ],
            },
            en_us: {
              title: "EN",
              content: [[{ tag: "text", text: "EN body" }]],
            },
          }),
        }),
      }),
      authorization({
        provider: "feishu",
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        cli: { provider: "feishu", appId: "cli_a", teamBrand: "feishu" },
        resolveMaterial: async () => ({ kind: "bearer", token: "t-token", origin: "https://open.feishu.cn" }),
      }),
    );
    expect(feishuCaptured[0]?.injectedSessionFooter).toEqual({
      shortId: SHORT_ID,
      sessionUrl: SESSION_URL,
      feishuPostLocalesAppended: ["en_us"],
      feishuPostSegmentText: `Session ${SHORT_ID}`,
      feishuPostSegmentHref: SESSION_URL,
    });
  });

  it("rechecks the live authority fence after resolveTaskAnchor settles and before any upstream byte is sent", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, ts: "1" })) as unknown as typeof fetch;
    let revoked = false;
    let releaseAnchor: (() => void) | undefined;
    const anchorStarted = new Promise<void>((resolve) => {
      releaseAnchor = resolve;
    });
    let continueAnchor: (() => void) | undefined;
    const anchorGate = new Promise<void>((resolve) => {
      continueAnchor = resolve;
    });

    const { instance } = adapter({
      fetchImpl,
      publicOrigin: PUBLIC_ORIGIN,
      resolveTaskAnchor: async () => {
        releaseAnchor?.();
        await anchorGate;
        return { kind: "link", taskAnchorId: SESSION_ID };
      },
    });
    const recheck = vi.fn(async () => {
      if (revoked) {
        throw Object.assign(new Error("revoked during anchor lookup"), { code: "credential_stale" });
      }
    });

    const pending = instance.handle(
      request({ sessionId: SESSION_ID, body: jsonBody({ channel: "C1", text: "hello" }) }),
      authorization({ sessionId: SESSION_ID, agentId: AGENT_ID, recheck }),
    );
    await anchorStarted;
    revoked = true;
    continueAnchor?.();

    await expect(pending).rejects.toMatchObject({ code: "credential_stale" });
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
