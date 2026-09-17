import { randomUUID } from "node:crypto";
import { FEISHU_TENANT_TOKEN_LOCAL_SENTINEL } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeProxyAuthorization } from "../runtime-credentials/credential-broker.js";
import { FEISHU_OPERATIONS } from "../runtime-credentials/feishu-operations.js";
import { ProviderOperationRegistry } from "../runtime-credentials/operation-registry.js";
import {
  ImProviderProxyAdapter,
  type ProviderProxyRequest,
  RuntimeProxyError,
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
  options: { provider?: "slack" | "feishu"; fetchImpl?: typeof fetch; urlHandles?: RuntimeUrlHandleStore } = {},
) {
  const provider = options.provider ?? "slack";
  const urlHandles = options.urlHandles ?? new RuntimeUrlHandleStore();
  const instance = new ImProviderProxyAdapter({
    provider,
    registry: new ProviderOperationRegistry(provider === "slack" ? SLACK_OPERATIONS : FEISHU_OPERATIONS),
    urlHandles,
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
