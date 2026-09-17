import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeProxyAuthorization } from "../runtime-credentials/credential-broker.js";
import { FEISHU_OPERATIONS } from "../runtime-credentials/feishu-operations.js";
import { ProviderOperationRegistry } from "../runtime-credentials/operation-registry.js";
import { ImProviderProxyAdapter, type ProviderProxyRequest } from "../runtime-credentials/provider-proxy-adapter.js";
import { SLACK_OPERATIONS } from "../runtime-credentials/slack-operations.js";
import { RuntimeUrlHandleStore } from "../runtime-credentials/url-handle-store.js";

function fixture(provider: "slack" | "feishu", response: Response) {
  const executionId = randomUUID();
  const sessionId = randomUUID();
  const urlHandles = new RuntimeUrlHandleStore();
  const instance = new ImProviderProxyAdapter({
    provider,
    registry: new ProviderOperationRegistry(provider === "slack" ? SLACK_OPERATIONS : FEISHU_OPERATIONS),
    urlHandles,
    fetchImpl: vi.fn(async () => response),
  });
  const authorization: RuntimeProxyAuthorization = {
    executionId,
    sessionId,
    provider,
    bindingId: "binding",
    purpose: "execution",
    scopeHash: "a".repeat(64),
    authorizationRevision: "3:7",
    credentialGeneration: "3:7",
    accountId: randomUUID(),
    agentId: randomUUID(),
    cli:
      provider === "slack"
        ? { provider: "slack" as const, teamId: "T", botUserId: "B" }
        : { provider: "feishu" as const, appId: "app", teamBrand: "feishu" as const },
    resolveMaterial: async () => ({
      kind: "bearer",
      token: "real-token",
      origin: provider === "slack" ? "https://slack.com" : "https://open.feishu.cn",
    }),
    recheck: async () => undefined,
  };
  function request(path: string): ProviderProxyRequest {
    return {
      executionId,
      sessionId,
      provider,
      bindingId: "binding",
      path,
      method: provider === "slack" ? "POST" : "GET",
      headers: {},
      body: (async function* () {})(),
      capability: "c".repeat(43),
      capabilityTtlSeconds: 60,
      signal: new AbortController().signal,
    };
  }
  return { instance, authorization, request, urlHandles };
}

async function readBody(body: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

describe("IM response delivery contract", () => {
  it("does not forward a stale length after JSON serialization", async () => {
    const raw = '{ "ok": true, "team": "T" }';
    const f = fixture("slack", new Response(raw, { headers: { "content-length": String(Buffer.byteLength(raw)) } }));
    const result = await f.instance.handle(f.request("/api/auth.test"), f.authorization);
    const body = await readBody(result.body);
    expect(
      result.headers["content-length"] === undefined ||
        Number(result.headers["content-length"]) === Buffer.byteLength(body),
    ).toBe(true);
    expect(JSON.parse(body)).toEqual({ ok: true, team: "T" });
  });

  it("drops the upstream compressed length when fetch has decoded a download", async () => {
    const decoded = "text content ".repeat(500);
    const f = fixture(
      "feishu",
      new Response(decoded, {
        headers: { "content-encoding": "gzip", "content-length": "70", "content-type": "text/plain" },
      }),
    );
    const result = await f.instance.handle(f.request("/open-apis/drive/v1/files/F1/download"), f.authorization);
    expect(result.headers["content-length"]).toBeUndefined();
    expect(result.headers["content-encoding"]).toBeUndefined();
    expect(await readBody(result.body)).toBe(decoded);
  });

  it.each([
    ["slack", "/api/conversations.history?channel=C1", { ok: true, messages: [{ text: "private text" }] }],
    ["feishu", "/open-apis/docx/v1/documents/D1/raw_content", { code: 0, data: { content: "private text" } }],
  ] as const)("returns %s protected read output with no recording dependency", async (provider, path, payload) => {
    // The proxy keeps no source ledger: protected reads are authorized per request and returned.
    const f = fixture(provider, Response.json(payload));
    const result = await f.instance.handle(f.request(path), f.authorization);
    expect(result.status).toBe(200);
    expect(await readBody(result.body)).toContain("private text");
  });

  it("rewrites authenticated Slack thumbnails while preserving dimensions and ordinary text", async () => {
    const f = fixture(
      "slack",
      Response.json({
        ok: true,
        file: {
          id: "F1",
          thumb_360: "https://files.slack.com/files-tmb/T-F/thumb.png",
          thumb_360_gif: "https://files.slack.com/files-tmb/T-F/thumb.gif",
          thumb_pdf: "https://files.slack.com/files-tmb/T-F/pdf.png",
          thumb_360_w: 360,
          thumb_tiny: "base64",
          title: "https://example.com/title",
        },
      }),
    );
    const result = await f.instance.handle(f.request("/api/files.info?file=F1"), f.authorization);
    const body = JSON.parse(await readBody(result.body));
    for (const key of ["thumb_360", "thumb_360_gif", "thumb_pdf"]) {
      expect(body.file[key]).toMatch(/^https:\/\/slack\.com\/__opentag__\/handles\//);
    }
    expect(body.file).toMatchObject({ thumb_360_w: 360, thumb_tiny: "base64", title: "https://example.com/title" });
    expect(f.urlHandles.size).toBe(3);
  });
});

describe("IM identity and ordinary reads", () => {
  it.each([
    ["slack", "/api/auth.test"],
    ["feishu", "/open-apis/bot/v3/info"],
    ["feishu", "/api/tools/open/api_definition"],
  ] as const)("serves the %s identity/public read %s", async (provider, path) => {
    const f = fixture(provider, Response.json({ ok: true, code: 0 }));
    await expect(f.instance.handle(f.request(path), f.authorization)).resolves.toMatchObject({ status: 200 });
  });

  it.each([
    ["slack", "/api/bots.info"],
    ["feishu", "/open-apis/im/v1/chats"],
  ] as const)("serves non-identity %s reads the same way", async (provider, path) => {
    const f = fixture(provider, Response.json({ ok: true, code: 0 }));
    await expect(f.instance.handle(f.request(path), f.authorization)).resolves.toMatchObject({ status: 200 });
  });
});

describe("Slack protected file rewrites across registered operations", () => {
  const file = {
    id: "F1",
    thumb_480: "https://files.slack.com/files-tmb/T-F/t480.png",
    thumb_480_gif: "https://files.slack.com/files-tmb/T-F/t480.gif",
    thumb_video: "https://files.slack.com/files-tmb/T-F/t.mp4",
    thumb_480_w: 480,
    thumb_tiny: "base64",
    title: "see https://files.slack.com/not-a-field",
    url_private: "https://files.slack.com/files-pri/T-F/f",
  };
  it.each([
    ["chat.postMessage", "/api/chat.postMessage", { ok: true, message: { files: [file] } }],
    ["chat.update", "/api/chat.update", { ok: true, message: { files: [file] } }],
    ["files.completeUploadExternal", "/api/files.completeUploadExternal", { ok: true, files: [file] }],
    ["reactions.get", "/api/reactions.get", { ok: true, message: { files: [file] } }],
  ] as const)("rewrites protected file fields for %s responses", async (_operation, path, payload) => {
    const f = fixture("slack", Response.json(payload));
    const result = await f.instance.handle(f.request(path), f.authorization);
    const body = JSON.parse(await readBody(result.body)) as {
      files?: Array<Record<string, unknown>>;
      message?: { files?: Array<Record<string, unknown>> };
    };
    const rewritten = body.message?.files?.[0] ?? body.files?.[0];
    if (!rewritten) throw new Error("the Slack file object was not returned");
    for (const key of ["url_private", "thumb_480", "thumb_480_gif", "thumb_video"]) {
      expect(String(rewritten[key])).toMatch(/^https:\/\/slack\.com\/__opentag__\/handles\//);
    }
    expect(rewritten).toMatchObject({
      thumb_480_w: 480,
      thumb_tiny: "base64",
      title: "see https://files.slack.com/not-a-field",
    });
    expect(f.urlHandles.size).toBe(4);
  });
});
