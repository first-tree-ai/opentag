import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { RuntimeSourceRecorder } from "../runtime-credentials/source-recorder.js";
import { RuntimeUrlHandleStore } from "../runtime-credentials/url-handle-store.js";
import type { RuntimeWriteJournal } from "../runtime-credentials/write-journal.js";
import { RuntimeWriteJournalUnavailableError } from "../runtime-credentials/write-journal.js";
import { FileSessionControlStore } from "../services/session-control-store/index.js";

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

function recordingJournal(): RuntimeWriteJournal & {
  intents: unknown[];
  outcomes: unknown[];
} {
  const journal = {
    intents: [] as unknown[],
    outcomes: [] as unknown[],
    async beginWrite(intent: unknown) {
      this.intents.push(intent);
      return { intentHash: "f".repeat(64) };
    },
    async completeWrite(sessionId: string, outcome: unknown) {
      this.outcomes.push({ sessionId, outcome });
    },
  };
  return journal;
}

const unavailableJournal: RuntimeWriteJournal = {
  beginWrite: () => Promise.reject(new RuntimeWriteJournalUnavailableError()),
  completeWrite: () => Promise.reject(new RuntimeWriteJournalUnavailableError()),
};

function adapter(
  options: {
    provider?: "slack" | "feishu";
    fetchImpl?: typeof fetch;
    journal?: RuntimeWriteJournal;
    sourceRecorder?: RuntimeSourceRecorder;
    urlHandles?: RuntimeUrlHandleStore;
  } = {},
) {
  const provider = options.provider ?? "slack";
  const urlHandles = options.urlHandles ?? new RuntimeUrlHandleStore();
  const instance = new ImProviderProxyAdapter({
    provider,
    registry: new ProviderOperationRegistry(provider === "slack" ? SLACK_OPERATIONS : FEISHU_OPERATIONS),
    urlHandles,
    journal: options.journal ?? recordingJournal(),
    ...(options.sourceRecorder ? { sourceRecorder: options.sourceRecorder } : {}),
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

async function withRealStore<T>(run: (store: FileSessionControlStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "opentag-adapter-form-"));
  try {
    return await run(new FileSessionControlStore({ root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

  it("does not automatically retry writes and records journal outcomes", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return jsonResponse({ ok: false, error: "channel_not_found" });
    }) as typeof fetch;
    const journal = recordingJournal();
    const { instance } = adapter({ fetchImpl, journal });
    const response = await instance.handle(
      request({ body: jsonBody({ channel: "C1", text: "hello" }) }),
      authorization(),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(journal.intents).toHaveLength(1);
    expect(journal.outcomes).toHaveLength(1);
    expect(journal.outcomes[0]).toMatchObject({
      outcome: { state: "rejected", resultCode: "channel_not_found" },
    });
  });

  it("fails closed before forwarding when the durable write journal is unavailable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { instance } = adapter({ fetchImpl, journal: unavailableJournal });
    await expect(instance.handle(request(), authorization())).rejects.toMatchObject({
      code: "write_journal_unavailable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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

  function recorder(): RuntimeSourceRecorder & { records: unknown[] } {
    return {
      records: [] as unknown[],
      async recordSource(record: unknown) {
        this.records.push(record);
      },
    };
  }

  it("rewrites native signed URLs to fixed-origin handles and records the read", async () => {
    const fetchImpl = (async () => jsonResponse(fileInfo)) as typeof fetch;
    const source = recorder();
    const { instance, urlHandles } = adapter({ fetchImpl, sourceRecorder: source });
    const response = await instance.handle(
      request({ path: "/api/files.info", body: jsonBody({ file: "F1" }) }),
      authorization(),
    );
    const payload = JSON.parse(await readBody(response.body)) as {
      file: { url_private: string };
    };
    expect(payload.file.url_private).toMatch(/^https:\/\/slack\.com\/__opentag__\/handles\/[A-Za-z0-9_-]+$/);
    expect(payload.file.url_private).not.toContain("files.slack.com");
    expect(source.records).toHaveLength(1);
    expect(source.records[0]).toMatchObject({ sessionId: SESSION, provider: "slack" });
    expect(urlHandles.size).toBe(1);
  });

  it("fails closed when a protected read has no durable recorder", async () => {
    const fetchImpl = (async () => jsonResponse(fileInfo)) as typeof fetch;
    const { instance } = adapter({ fetchImpl });
    await expect(
      instance.handle(request({ path: "/api/files.info", body: jsonBody({ file: "F1" }) }), authorization()),
    ).rejects.toMatchObject({ code: "source_record_unavailable" });
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
      resource: "channel:C-FIXTURE",
    },
    {
      forwarded: "channel=C-FIXTURE&ts=1710000000.000100&text=native+acceptance+updated",
      form: "channel=C-FIXTURE&ts=1710000000.000100&text=native+acceptance+updated&token=otrh_local",
      operation: "chat.update",
      path: "/api/chat.update",
      resource: "channel:C-FIXTURE",
    },
    {
      forwarded: "channel=C-FIXTURE&ts=1710000000.000100",
      form: "channel=C-FIXTURE&ts=1710000000.000100&token=otrh_local",
      operation: "chat.delete",
      path: "/api/chat.delete",
      resource: "channel:C-FIXTURE",
    },
    {
      forwarded: "filename=upload.bin&length=1048576",
      form: "filename=upload.bin&length=1048576&token=otrh_local",
      operation: "files.getUploadURLExternal",
      path: "/api/files.getUploadURLExternal",
      resource: "upload.bin",
    },
    {
      forwarded: "channel_id=C-FIXTURE&files=%5B%7B%22id%22%3A%22F_FIXTURE%22%7D%5D",
      form: "channel_id=C-FIXTURE&files=%5B%7B%22id%22%3A%22F_FIXTURE%22%7D%5D&token=otrh_local",
      operation: "files.completeUploadExternal",
      path: "/api/files.completeUploadExternal",
      resource: "channel:C-FIXTURE",
    },
  ])("forwards the native $operation form body untouched and journals it", async (fixture) => {
    await withRealStore(async (store) => {
      const beginWrite = vi.spyOn(store, "beginWrite");
      const { calls, fetchImpl } = captureFetch();
      const { instance } = adapter({ fetchImpl, journal: store });

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

      const intent = beginWrite.mock.calls[0]?.[0];
      expect(intent).toMatchObject({ operation: fixture.operation, provider: "slack", resource: fixture.resource });
      await expect(store.readWrite(SESSION, intent?.operationId as string)).resolves.toMatchObject({
        outcome: { state: "succeeded" },
        resolution: "succeeded",
      });
      expect(await store.listUnresolvedWrites(SESSION)).toEqual([]);
    });
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
  ])("rejects %s before upstream or journal", async (_case, form, code) => {
    const { calls, fetchImpl } = captureFetch();
    const journal = recordingJournal();
    const { instance } = adapter({ fetchImpl, journal });
    await expect(
      instance.handle(
        request({ headers: FORM_HEADERS, body: bodyOf(new TextEncoder().encode(form)) }),
        authorization(),
      ),
    ).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(0);
    expect(journal.intents).toHaveLength(0);
  });

  it("rejects an oversized native form before upstream", async () => {
    const { calls, fetchImpl } = captureFetch();
    const journal = recordingJournal();
    const { instance } = adapter({ fetchImpl, journal });
    const oversized = new TextEncoder().encode(`text=${"x".repeat(140 * 1024)}`);
    await expect(
      instance.handle(request({ headers: FORM_HEADERS, body: bodyOf(oversized) }), authorization()),
    ).rejects.toMatchObject({ code: "body_too_large" });
    expect(calls).toHaveLength(0);
    expect(journal.intents).toHaveLength(0);
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
    const journal = recordingJournal();
    const { instance } = adapter({ fetchImpl, journal });
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
    expect(journal.intents[0]).toMatchObject({ operation: "chat.delete", resource: "channel:C-QUERY" });
  });
});

describe("ImProviderProxyAdapter with the real durable SessionControlStore", () => {
  it.each([
    {
      body: { channel: "C1", text: "hello" },
      operation: "chat.postMessage",
      path: "/api/chat.postMessage",
      resource: "channel:C1",
      upstream: { ok: true, ts: "1710000000.000100" },
    },
    {
      body: { filename: "report.txt", length: 3 },
      operation: "files.getUploadURLExternal",
      path: "/api/files.getUploadURLExternal",
      resource: "report.txt",
      upstream: { file_id: "F1", ok: true, upload_url: "https://files.slack.com/upload/v1/ABC" },
    },
  ])("journals the native $operation intent through the real store and resolves it", async (fixture) => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "opentag-adapter-store-"));
    try {
      const store = new FileSessionControlStore({ root });
      const beginWrite = vi.spyOn(store, "beginWrite");
      const fetchImpl = (async () => jsonResponse(fixture.upstream)) as unknown as typeof fetch;
      const { instance } = adapter({ fetchImpl, journal: store });

      const response = await instance.handle(
        request({ path: fixture.path, body: jsonBody(fixture.body) }),
        authorization(),
      );
      expect(response.status).toBe(200);
      expect(beginWrite).toHaveBeenCalledTimes(1);
      const intent = beginWrite.mock.calls[0]?.[0];
      expect(intent).toMatchObject({
        operation: fixture.operation,
        provider: "slack",
        resource: fixture.resource,
        sessionId: SESSION,
      });
      const stored = await store.readWrite(SESSION, intent?.operationId as string);
      expect(stored).toMatchObject({
        intent: { operation: fixture.operation, provider: "slack" },
        outcome: { state: "succeeded" },
        resolution: "succeeded",
      });
      expect(await store.listUnresolvedWrites(SESSION)).toEqual([]);

      // A completed write releases the resource for a fresh, separately journaled intent.
      await expect(
        instance.handle(request({ path: fixture.path, body: jsonBody(fixture.body) }), authorization()),
      ).resolves.toMatchObject({ status: 200 });
      expect(beginWrite).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ImProviderProxyAdapter write receipts", () => {
  function statusFetch(status: number, payload: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
  }

  it("records proven success only for HTTP 2xx with explicit provider success evidence", async () => {
    await withRealStore(async (store) => {
      const beginWrite = vi.spyOn(store, "beginWrite");
      const { instance } = adapter({ fetchImpl: captureFetch({ ok: true, ts: "1" }).fetchImpl, journal: store });
      await expect(
        instance.handle(request({ body: jsonBody({ channel: "C1", text: "hello" }) }), authorization()),
      ).resolves.toMatchObject({ status: 200 });
      const intent = beginWrite.mock.calls[0]?.[0];
      await expect(store.readWrite(SESSION, intent?.operationId as string)).resolves.toMatchObject({
        outcome: { state: "succeeded", resultCode: "http_200" },
        resolution: "succeeded",
      });
    });
  });

  it("records an explicit provider rejection with its controlled code and relays the response", async () => {
    await withRealStore(async (store) => {
      const beginWrite = vi.spyOn(store, "beginWrite");
      const { instance } = adapter({
        fetchImpl: captureFetch({ ok: false, error: "channel_not_found" }).fetchImpl,
        journal: store,
      });
      await expect(
        instance.handle(request({ body: jsonBody({ channel: "C1" }) }), authorization()),
      ).resolves.toMatchObject({ status: 200 });
      const intent = beginWrite.mock.calls[0]?.[0];
      await expect(store.readWrite(SESSION, intent?.operationId as string)).resolves.toMatchObject({
        outcome: { state: "rejected", resultCode: "channel_not_found" },
        resolution: "rejected",
      });
    });
  });

  it.each([
    ["an ambiguous 5xx provider failure", 503, { ok: false, error: "server_error" }, "http_503"],
    ["a 408 provider timeout", 408, { ok: true, ts: "1" }, "http_408"],
    ["a 2xx response without success evidence", 200, {}, "provider_outcome_unconfirmed"],
  ])("records %s as unknown and never returns a successful write", async (_label, status, payload, resultCode) => {
    await withRealStore(async (store) => {
      const { instance } = adapter({ fetchImpl: statusFetch(status, payload), journal: store });
      await expect(
        instance.handle(request({ body: jsonBody({ channel: "C1" }) }), authorization()),
      ).rejects.toMatchObject({ code: "write_outcome_unknown" });
      const unresolved = await store.listUnresolvedWrites(SESSION);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatchObject({ outcome: { state: "unknown", resultCode } });
    });
  });

  it("blocks a same-resource retry before upstream while an unknown receipt is unresolved", async () => {
    await withRealStore(async (store) => {
      const failed = adapter({ fetchImpl: statusFetch(503, {}), journal: store });
      await expect(
        failed.instance.handle(request({ body: jsonBody({ channel: "C1" }) }), authorization()),
      ).rejects.toMatchObject({ code: "write_outcome_unknown" });
      let calls = 0;
      const retry = adapter({
        fetchImpl: (async () => {
          calls += 1;
          return jsonResponse({ ok: true });
        }) as typeof fetch,
        journal: store,
      });
      await expect(
        retry.instance.handle(request({ body: jsonBody({ channel: "C1" }) }), authorization()),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(calls).toBe(0);
    });
  });

  it("surfaces write_outcome_unknown when the durable completion fails and never retries cleanup", async () => {
    await withRealStore(async (store) => {
      const completeWrite = vi.spyOn(store, "completeWrite").mockRejectedValueOnce(new Error("disk unavailable"));
      const { instance } = adapter({ fetchImpl: captureFetch({ ok: true }).fetchImpl, journal: store });
      await expect(
        instance.handle(request({ body: jsonBody({ channel: "C1" }) }), authorization()),
      ).rejects.toMatchObject({ code: "write_outcome_unknown" });
      expect(completeWrite).toHaveBeenCalledTimes(1);
      const unresolved = await store.listUnresolvedWrites(SESSION);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]?.outcome).toBeUndefined();
    });
  });
});

describe("ImProviderProxyAdapter upload handle receipts", () => {
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
      resource: "F_FIXTURE",
    });
  }

  it("journals the upload bytes intent before the first upstream byte and resolves a 2xx", async () => {
    await withRealStore(async (store) => {
      const urlHandles = new RuntimeUrlHandleStore();
      const handleId = uploadHandle(urlHandles);
      const originalBeginWrite = store.beginWrite.bind(store);
      const order: string[] = [];
      const beginWrite = vi.spyOn(store, "beginWrite").mockImplementation(async (intent) => {
        order.push("journal");
        return originalBeginWrite(intent as never);
      });
      const forwarded: string[] = [];
      let operationsAtFetch: string[] = [];
      const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
        operationsAtFetch = (await store.listUnresolvedWrites(SESSION)).map((write) => write.intent.operation);
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
      const { instance } = adapter({ fetchImpl, journal: store, urlHandles });

      const response = await instance.handle(
        uploadRequest(handleId, bodyOf(new TextEncoder().encode("file-"), new TextEncoder().encode("bytes"))),
        authorization({ recheck }),
      );
      expect(response.status).toBe(200);
      expect(operationsAtFetch).toEqual(["slack.files.upload_bytes"]);
      expect(order).toEqual(["journal", "recheck"]);
      expect(forwarded.join("")).toBe("file-bytes");
      expect(recheck).toHaveBeenCalledTimes(1);
      expect(await readBody(response.body)).toContain('"ok":true');

      const intent = beginWrite.mock.calls[0]?.[0];
      expect(intent).toMatchObject({
        executionId: EXECUTION,
        operation: "slack.files.upload_bytes",
        provider: "slack",
        resource: "F_FIXTURE",
        sessionId: SESSION,
      });
      expect(intent?.requestHash).toMatch(/^[a-f0-9]{64}$/);
      const serialized = JSON.stringify(intent);
      expect(serialized).not.toContain("file-bytes");
      expect(serialized).not.toContain("files.slack.com");
      await expect(store.readWrite(SESSION, intent?.operationId as string)).resolves.toMatchObject({
        outcome: { state: "succeeded", resultCode: "http_200" },
        resolution: "succeeded",
      });
    });
  });

  it("records a definite 4xx upload rejection and relays the provider response", async () => {
    await withRealStore(async (store) => {
      const urlHandles = new RuntimeUrlHandleStore();
      const handleId = uploadHandle(urlHandles);
      const beginWrite = vi.spyOn(store, "beginWrite");
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ error: "invalid" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      const { instance } = adapter({ fetchImpl, journal: store, urlHandles });

      const response = await instance.handle(
        uploadRequest(handleId, bodyOf(new TextEncoder().encode("denied"))),
        authorization(),
      );
      expect(response.status).toBe(403);
      const intent = beginWrite.mock.calls[0]?.[0];
      await expect(store.readWrite(SESSION, intent?.operationId as string)).resolves.toMatchObject({
        outcome: { state: "rejected", resultCode: "http_403" },
        resolution: "rejected",
      });
    });
  });

  it("records an unknown 5xx upload and blocks a same-resource retry before upstream", async () => {
    await withRealStore(async (store) => {
      const urlHandles = new RuntimeUrlHandleStore();
      const handleId = uploadHandle(urlHandles);
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return new Response(JSON.stringify({}), { status: 503, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const { instance } = adapter({ fetchImpl, journal: store, urlHandles });

      await expect(
        instance.handle(uploadRequest(handleId, bodyOf(new TextEncoder().encode("bytes"))), authorization()),
      ).rejects.toMatchObject({ code: "write_outcome_unknown" });
      const unresolved = await store.listUnresolvedWrites(SESSION);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatchObject({
        intent: { operation: "slack.files.upload_bytes", resource: "F_FIXTURE" },
        outcome: { state: "unknown", resultCode: "http_503" },
      });

      await expect(
        instance.handle(uploadRequest(handleId, bodyOf(new TextEncoder().encode("bytes"))), authorization()),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(calls).toBe(1);
    });
  });

  it("records an unknown receipt when the upload transport fails", async () => {
    await withRealStore(async (store) => {
      const urlHandles = new RuntimeUrlHandleStore();
      const handleId = uploadHandle(urlHandles);
      const fetchImpl = (async () => {
        throw new Error("connection reset");
      }) as unknown as typeof fetch;
      const { instance } = adapter({ fetchImpl, journal: store, urlHandles });
      await expect(
        instance.handle(uploadRequest(handleId, bodyOf(new TextEncoder().encode("bytes"))), authorization()),
      ).rejects.toMatchObject({ code: "write_outcome_unknown" });
      const unresolved = await store.listUnresolvedWrites(SESSION);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatchObject({ outcome: { state: "unknown", resultCode: "proxy_error" } });
    });
  });
});
