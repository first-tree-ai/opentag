import { request as httpRequest } from "node:http";
import { CLOUD_MODEL_CHAT_COMPLETIONS_PATH } from "@opentag/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCloudModelProxyRoutes } from "../api/cloud-model-proxy.js";
import { CloudModelGrantService } from "../services/sandboxes/cloud-model-grants.js";
import {
  type CloudModelUpstream,
  FIXTURE_ERROR_BODY_MARKER,
  FIXTURE_MASTER_KEY,
  FIXTURE_RESPONSE_HEADER,
  type FixtureHandler,
  startCloudModelUpstream,
} from "./fixtures/cloud-model-upstream.js";

const SECRET = "unit-test-jwt-secret-at-least-32-characters";
const SANDBOX_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
/** Minimal valid chat history: the strict request schema requires at least one message. */
const CHAT_MESSAGES = [{ content: "hello", role: "user" }];
/** Deliberate pin of the route's CLOUD_MODEL_MAX_OUTPUT_TOKENS value: clamping tests assert it. */
const OUTPUT_TOKEN_CEILING = 65_536;

type ProxyConfig = Parameters<typeof registerCloudModelProxyRoutes>[1]["config"];

function makeConfig(upstreamBaseUrl: string, overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    allowedModels: ["model-a"],
    enabled: true,
    masterKey: FIXTURE_MASTER_KEY,
    maxRequestBytes: 64 * 1024,
    maxResponseBytes: 1024 * 1024,
    maxStreamsPerToken: 1,
    requestTimeoutMs: 5_000,
    tokenTtlSeconds: 60,
    upstreamBaseUrl,
    ...overrides,
  };
}

function makeGrants(options: { now?: () => Date; ttlSeconds?: number } = {}) {
  return new CloudModelGrantService(SECRET, {
    allowedModels: ["model-a"],
    maxStreamsPerToken: 1,
    sweepIntervalMs: 0,
    ttlSeconds: options.ttlSeconds ?? 60,
    ...(options.now ? { now: options.now } : {}),
  });
}

const cleanups: { apps: FastifyInstance[]; grants: CloudModelGrantService[]; upstreams: CloudModelUpstream[] } = {
  apps: [],
  grants: [],
  upstreams: [],
};

async function startFixture(handler: FixtureHandler): Promise<CloudModelUpstream> {
  const upstream = await startCloudModelUpstream(handler);
  cleanups.upstreams.push(upstream);
  return upstream;
}

async function makeStack(input: {
  app?: FastifyInstance;
  configOverrides?: Partial<ProxyConfig>;
  grants?: CloudModelGrantService;
  logger?: { level: string; stream: { write(line: string): void } };
  upstream: CloudModelUpstream;
}) {
  const grants = input.grants ?? makeGrants();
  cleanups.grants.push(grants);
  const app = input.app ?? Fastify({ logger: input.logger ?? false });
  cleanups.apps.push(app);
  registerCloudModelProxyRoutes(app, { config: makeConfig(input.upstream.baseUrl, input.configOverrides), grants });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  return { app, grants, port: address.port };
}

async function issueToken(grants: CloudModelGrantService, executionId = "turn-1", model = "model-a") {
  const issued = await grants.issue({ executionId, model, sandboxId: SANDBOX_ID, sessionId: SESSION_ID });
  if (!issued) throw new Error("grant issue failed");
  return issued;
}

function postModel(port: number, body: unknown, token?: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${CLOUD_MODEL_CHAT_COMPLETIONS_PATH}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    method: "POST",
    ...(signal ? { signal } : {}),
  });
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json().catch(() => undefined)) as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}

/** Raw socket client used where clean-FIN vs truncated-body detection matters. */
function rawModelRequest(
  port: number,
  token: string,
  body: unknown,
  options: { pauseAfterFirstChunkMs?: number } = {},
): Promise<{ aborted: boolean; bytes: number; complete: boolean; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest({
      headers: {
        authorization: `Bearer ${token}`,
        "content-length": Buffer.byteLength(payload),
        "content-type": "application/json",
      },
      host: "127.0.0.1",
      method: "POST",
      path: CLOUD_MODEL_CHAT_COMPLETIONS_PATH,
      port,
    });
    let aborted = false;
    let bytes = 0;
    let paused = false;
    request.on("error", reject);
    request.on("response", (response) => {
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (!paused && options.pauseAfterFirstChunkMs !== undefined) {
          paused = true;
          response.pause();
          setTimeout(() => response.destroy(), options.pauseAfterFirstChunkMs);
        }
      });
      response.on("aborted", () => {
        aborted = true;
      });
      response.on("error", () => undefined);
      response.on("close", () => {
        resolve({ aborted, bytes, complete: response.complete, statusCode: response.statusCode ?? 0 });
      });
    });
    request.end(payload);
  });
}

/** Open a streamed model request on a dedicated connection (no keep-alive pool reuse across aborts). */
function openModelStream(
  port: number,
  token: string,
  body: unknown,
): Promise<{ destroy(): void; firstChunkBytes: number; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest({
      agent: false,
      headers: {
        authorization: `Bearer ${token}`,
        "content-length": Buffer.byteLength(payload),
        "content-type": "application/json",
      },
      host: "127.0.0.1",
      method: "POST",
      path: CLOUD_MODEL_CHAT_COMPLETIONS_PATH,
      port,
    });
    request.on("error", reject);
    request.on("response", (response) => {
      let settled = false;
      const settle = (firstChunkBytes: number): void => {
        if (settled) return;
        settled = true;
        resolve({
          destroy: () => response.destroy(),
          firstChunkBytes,
          statusCode: response.statusCode ?? 0,
        });
      };
      response.once("data", (chunk: Buffer) => settle(chunk.byteLength));
      response.once("end", () => settle(0));
      response.once("close", () => settle(-1));
    });
    request.end(payload);
  });
}

function slotIsFree(grants: CloudModelGrantService, jti: string): boolean {
  const admission = grants.beginRequest(jti);
  if (!admission) return false;
  admission.release();
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const app of cleanups.apps.splice(0)) await app.close().catch(() => undefined);
  for (const upstream of cleanups.upstreams.splice(0)) await upstream.close();
  for (const grants of cleanups.grants.splice(0)) grants.close();
});

describe("Cloud model proxy route", () => {
  it("streams JSON through the fixed upstream path with the master key and releases admission", async () => {
    const upstream = await startFixture({
      kind: "json",
      payload: { choices: [], id: "chatcmpl-fixture" },
    });
    const { grants, port } = await makeStack({ upstream });
    const issued = await issueToken(grants);
    const response = await postModel(
      port,
      { messages: [{ content: "hi", role: "user" }], model: "model-a" },
      issued.token,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "chatcmpl-fixture" });
    expect(upstream.stats.paths).toEqual(["/chat/completions"]);
    expect(upstream.stats.sawFixtureMasterKey).toBe(true);
    expect((upstream.stats.lastRequestBody as { model?: string }).model).toBe("model-a");
    // Arbitrary upstream response headers are never relayed.
    expect(response.headers.get(FIXTURE_RESPONSE_HEADER)).toBeNull();
    const second = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a" }, issued.token);
    expect(second.status).toBe(200);
    await second.text();
  });

  it("streams SSE chunks and keeps the response byte-bounded", async () => {
    const upstream = await startFixture({ kind: "sse" });
    const { grants, port } = await makeStack({ upstream });
    const issued = await issueToken(grants);
    const response = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a", stream: true }, issued.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    for (const expected of ["fixture-chunk-0", "fixture-chunk-1", "fixture-chunk-2", "[DONE]"]) {
      expect(text).toContain(expected);
    }
    expect(upstream.stats.hits).toBe(1);
    // An upstream that streams anyway for a non-stream request is relayed (its caller fails
    // visibly in the JSON parser); the reverse direction is rejected below.
    const nonStream = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a" }, issued.token);
    expect(nonStream.status).toBe(200);
    await nonStream.text();
  });

  it("rejects missing, invalid, revoked, and expired tokens without contacting the upstream", async () => {
    const upstream = await startFixture({ kind: "json" });
    let now = new Date("2026-09-17T00:00:00.000Z");
    const grants = makeGrants({ now: () => now });
    const { port } = await makeStack({ grants, upstream });
    const missing = await postModel(port, { model: "model-a" });
    expect(missing.status).toBe(401);
    const invalid = await postModel(port, { model: "model-a" }, "not-a-token");
    expect(invalid.status).toBe(401);

    const revoked = await issueToken(grants, "turn-revoked");
    grants.revokeExecution("turn-revoked");
    const revokedResponse = await postModel(port, { model: "model-a" }, revoked.token);
    expect(revokedResponse.status).toBe(401);

    const expiring = await issueToken(grants, "turn-expiring");
    expect((await postModel(port, { messages: CHAT_MESSAGES, model: "model-a" }, expiring.token)).status).toBe(200);
    now = new Date(now.getTime() + 61_000);
    const expiredResponse = await postModel(port, { model: "model-a" }, expiring.token);
    expect(expiredResponse.status).toBe(401);
    expect(await errorCode(expiredResponse)).toBe("CLOUD_MODEL_TOKEN_INVALID");
    expect(upstream.stats.hits).toBe(1);
  });

  it("binds the token model and serves no arbitrary upstream path", async () => {
    const upstream = await startFixture({ kind: "json" });
    const { grants, port } = await makeStack({ upstream });
    const issued = await issueToken(grants);
    const wrongModel = await postModel(port, { messages: CHAT_MESSAGES, model: "model-b" }, issued.token);
    expect(wrongModel.status).toBe(403);
    expect(await errorCode(wrongModel)).toBe("CLOUD_MODEL_MODEL_DENIED");
    for (const path of ["/api/v1/cloud-model/models", "/api/v1/cloud-model/chat/completions/extra"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        body: JSON.stringify({ model: "model-a" }),
        headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
        method: "POST",
      });
      expect(response.status).toBe(404);
    }
    expect(upstream.stats.hits).toBe(0);
  });

  it("rejects sandbox-controlled routing and credential fields without contacting the upstream", async () => {
    const upstream = await startFixture({ kind: "json" });
    const { grants, port } = await makeStack({ upstream });
    const issued = await issueToken(grants);
    // The strict request schema is the allowlist: router/credential overrides a sandbox could use
    // to redirect the call or bypass the model binding are rejected before any upstream call.
    for (const extra of [
      { route: "fallback" },
      { models: ["model-a", "model-b"] },
      { provider: { order: ["cheap"], allow_fallbacks: true } },
      { providerOptions: { gateway: { order: ["other"] } } },
      { api_base: "https://attacker.example/v1" },
      { apiBase: "https://attacker.example/v1" },
      { base_url: "https://attacker.example/v1" },
      { api_key: "attacker-controlled-key" },
      { transforms: ["middle-out"] },
      { user: "attacker-controlled" },
    ]) {
      const response = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a", ...extra }, issued.token);
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect(await errorCode(response)).toBe("CLOUD_MODEL_REQUEST_INVALID");
    }
    expect(upstream.stats.hits).toBe(0);
  });

  it("bounds completions to a single choice and clamps output token budgets to the ceiling", async () => {
    const upstream = await startFixture({ kind: "json" });
    const { grants, port } = await makeStack({ upstream });
    const issued = await issueToken(grants);
    // n > 1 multiplies completions per call on the master key and is never emitted by Pi: reject.
    const multi = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a", n: 2 }, issued.token);
    expect(multi.status).toBe(400);
    expect(await errorCode(multi)).toBe("CLOUD_MODEL_REQUEST_INVALID");
    expect(upstream.stats.hits).toBe(0);
    // n = 1 is the only acceptable explicit value.
    const single = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a", n: 1 }, issued.token);
    expect(single.status).toBe(200);
    await single.text();
    expect((upstream.stats.lastRequestBody as { n?: number }).n).toBe(1);
    // Omitting both budget fields must not bypass the platform output ceiling.
    expect((upstream.stats.lastRequestBody as { max_tokens?: number }).max_tokens).toBe(OUTPUT_TOKEN_CEILING);
    // An uncapped token ask is clamped to the proxy ceiling, never relayed to the master key.
    const hugeTokens = await postModel(
      port,
      { messages: CHAT_MESSAGES, model: "model-a", max_tokens: 1_000_000_000 },
      issued.token,
    );
    expect(hugeTokens.status).toBe(200);
    await hugeTokens.text();
    expect((upstream.stats.lastRequestBody as { max_tokens?: number }).max_tokens).toBe(OUTPUT_TOKEN_CEILING);
    const hugeCompletion = await postModel(
      port,
      { messages: CHAT_MESSAGES, model: "model-a", max_completion_tokens: 1_000_000_000 },
      issued.token,
    );
    expect(hugeCompletion.status).toBe(200);
    await hugeCompletion.text();
    expect((upstream.stats.lastRequestBody as { max_completion_tokens?: number }).max_completion_tokens).toBe(
      OUTPUT_TOKEN_CEILING,
    );
    // A budget under the ceiling is forwarded untouched.
    const normal = await postModel(
      port,
      { messages: CHAT_MESSAGES, model: "model-a", max_tokens: 8_192 },
      issued.token,
    );
    expect(normal.status).toBe(200);
    await normal.text();
    expect((upstream.stats.lastRequestBody as { max_tokens?: number }).max_tokens).toBe(8_192);
    // Non-positive or fractional budgets are invalid.
    for (const maxTokens of [0, -1, 1.5]) {
      const response = await postModel(
        port,
        { messages: CHAT_MESSAGES, model: "model-a", max_tokens: maxTokens },
        issued.token,
      );
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("CLOUD_MODEL_REQUEST_INVALID");
    }
  });

  it("forwards a realistic pinned-Pi openai-completions payload to the upstream unchanged", async () => {
    // Shape mirrored from the image-pinned Pi (scripts/runner/pi: @earendil-works/pi-coding-agent
    // 0.84.2 → pi-ai openai-completions buildParams/convertMessages for a custom provider whose
    // model has no reasoning flag): stream with usage, store:false, the 16,384 provider-composer
    // default budget, strict function tools, and assistant/tool/image history.
    const piBody = {
      model: "model-a",
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "Change the button label." },
        {
          role: "assistant",
          content: "I will inspect the file.",
          tool_calls: [
            { id: "call_abc123", type: "function", function: { name: "read", arguments: '{"path":"src/a.ts"}' } },
          ],
        },
        { role: "tool", content: "export const a = 1;", tool_call_id: "call_abc123" },
        {
          role: "user",
          content: [
            { type: "text", text: "Here is the screenshot." },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          ],
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      store: false,
      max_completion_tokens: 16_384,
      temperature: 0.2,
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            strict: false,
          },
        },
      ],
      tool_choice: "auto",
    };
    const upstream = await startFixture({ kind: "sse" });
    const { grants, port } = await makeStack({ upstream });
    const issued = await issueToken(grants);
    const response = await postModel(port, piBody, issued.token);
    expect(response.status).toBe(200);
    await response.text();
    // Nothing is dropped, rewritten, or added between the Runner and the fixed upstream.
    expect(upstream.stats.lastRequestBody).toEqual(piBody);
  });

  it("accepts the DeepSeek reasoning fields and rejects out-of-range sampling", async () => {
    const upstream = await startFixture({ kind: "json" });
    const { grants, port } = await makeStack({ upstream });
    const issued = await issueToken(grants);
    // DeepSeek multi-turn reasoning: the reasoner's reasoning_content must round-trip on
    // assistant history, and thinking/reasoning_effort are the DeepSeek request switches.
    const body = {
      model: "model-a",
      messages: [
        { role: "user", content: "think" },
        { role: "assistant", content: "answer", reasoning_content: "chain of thought" },
        { role: "user", content: "continue" },
      ],
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      max_tokens: 8_192,
    };
    const response = await postModel(port, body, issued.token);
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.stats.lastRequestBody).toEqual(body);
    for (const extra of [{ temperature: 3 }, { temperature: -1 }, { top_p: 2 }]) {
      const invalid = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a", ...extra }, issued.token);
      expect(invalid.status).toBe(400);
      expect(await errorCode(invalid)).toBe("CLOUD_MODEL_REQUEST_INVALID");
    }
  });

  it("accepts every pinned-Pi reasoning echo field and replays signed tool-call details unchanged", async () => {
    const upstream = await startFixture({ kind: "sse" });
    const { grants, port } = await makeStack({ upstream });
    const issued = await issueToken(grants);
    // Shape mirrored from pi-ai 0.84.2 convertMessages/buildParams: Pi records whichever of
    // reasoning_content/reasoning/reasoning_text the upstream streamed and echoes it under the
    // same key, and replays each parsed encrypted thoughtSignature as reasoning_details.
    const toolCall = {
      id: "call_reasoning_1",
      type: "function",
      function: { name: "read", arguments: '{"path":"src/a.ts"}' },
    };
    const detail = {
      type: "reasoning.encrypted",
      id: "call_reasoning_1",
      data: "opaque-signed-payload",
      format: "google-gemini-v1",
      index: 0,
    };
    for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
      const body = {
        model: "model-a",
        messages: [
          { role: "user", content: "read the file" },
          {
            role: "assistant",
            content: "working",
            tool_calls: [toolCall],
            [field]: "private chain of thought",
            reasoning_details: [detail],
          },
          { role: "tool", content: "file body", tool_call_id: "call_reasoning_1" },
        ],
        stream: true,
        max_tokens: 8_192,
      };
      const response = await postModel(port, body, issued.token);
      expect(response.status, field).toBe(200);
      await response.text();
      expect(upstream.stats.lastRequestBody, field).toEqual(body);
      const echoed = (
        upstream.stats.lastRequestBody as {
          messages: { reasoning_details?: { data?: string; format?: string; index?: number }[] }[];
        }
      ).messages[1]?.reasoning_details?.[0];
      expect(echoed).toEqual(detail);
    }
  });

  it("rejects reasoning detail shapes the pinned Pi never replays", async () => {
    const upstream = await startFixture({ kind: "json" });
    // Raise the body cap so the 64 KB detail bound is what rejects the oversized payload here.
    const { grants, port } = await makeStack({ upstream, configOverrides: { maxRequestBytes: 256 * 1024 } });
    const issued = await issueToken(grants);
    const withDetails = (details: unknown) => ({
      model: "model-a",
      messages: [
        {
          role: "assistant",
          content: "working",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
          reasoning_details: details,
        },
      ],
      stream: true,
    });
    const detail = { type: "reasoning.encrypted", id: "call_1", data: "opaque" };
    const tooManyFields = {
      ...detail,
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
    };
    for (const [caseName, body] of [
      ["non encrypted type", withDetails([{ ...detail, type: "reasoning.text" }])],
      ["nested object value", withDetails([{ ...detail, nested: { not: "scalar" } }])],
      ["oversized signed payload", withDetails([{ ...detail, data: "x".repeat(65 * 1024) }])],
      ["too many detail fields", withDetails([tooManyFields])],
      ["top-level reasoning field", { model: "model-a", messages: CHAT_MESSAGES, reasoning: "not allowlisted here" }],
    ] as const) {
      const response = await postModel(port, body, issued.token);
      expect(response.status, caseName).toBe(400);
      expect(await errorCode(response), caseName).toBe("CLOUD_MODEL_REQUEST_INVALID");
    }
    expect(upstream.stats.hits).toBe(0);
  });

  it("does not follow redirects off the fixed upstream", async () => {
    const target = await startFixture({ kind: "json" });
    const upstream = await startFixture({ kind: "redirect", location: `${target.baseUrl}/stolen` });
    const { grants, port } = await makeStack({ upstream });
    const issued = await issueToken(grants);
    const response = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a" }, issued.token);
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).not.toContain("redirect-fixture");
    expect(target.stats.hits).toBe(0);
    expect(upstream.stats.hits).toBe(1);
  });

  it("rejects request bodies over the configured limit", async () => {
    const upstream = await startFixture({ kind: "json" });
    const { grants, port } = await makeStack({ upstream });
    const issued = await issueToken(grants);
    const response = await postModel(
      port,
      { messages: [{ content: "x".repeat(128 * 1024), role: "user" }], model: "model-a" },
      issued.token,
    );
    expect(response.status).toBe(413);
    expect(upstream.stats.hits).toBe(0);
  });

  it("destroys a response that exceeds the byte cap instead of ending a truncated answer", async () => {
    const maxResponseBytes = 32 * 1024;
    const upstream = await startFixture({ kind: "overflow", chunkBytes: 8 * 1024, totalBytes: 3 * maxResponseBytes });
    const { grants, port } = await makeStack({ upstream, configOverrides: { maxResponseBytes } });
    const issued = await issueToken(grants);
    const result = await rawModelRequest(port, issued.token, { messages: CHAT_MESSAGES, model: "model-a" });
    expect(result.statusCode).toBe(200);
    expect(result.bytes).toBeLessThanOrEqual(maxResponseBytes + 1024);
    expect(result.complete).toBe(false);
    await vi.waitFor(() => expect(slotIsFree(grants, issued.claims.jti)).toBe(true), { interval: 10, timeout: 2_000 });
  });

  it("rejects successful responses with an unexpected content type or an empty body", async () => {
    const upstream = await startFixture({ kind: "bad-content-type" });
    const { grants, port } = await makeStack({ upstream });
    const issued = await issueToken(grants);
    const badType = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a" }, issued.token);
    expect(badType.status).toBe(502);
    expect(await errorCode(badType)).toBe("CLOUD_MODEL_UPSTREAM_INVALID");

    // A JSON 200 answering a stream request would look like a successful empty SSE answer.
    const jsonUpstream = await startFixture({ kind: "json" });
    const jsonStack = await makeStack({ upstream: jsonUpstream });
    const jsonIssued = await issueToken(jsonStack.grants, "turn-json-stream");
    const jsonToStream = await postModel(
      jsonStack.port,
      { messages: CHAT_MESSAGES, model: "model-a", stream: true },
      jsonIssued.token,
    );
    expect(jsonToStream.status).toBe(502);
    expect(await errorCode(jsonToStream)).toBe("CLOUD_MODEL_UPSTREAM_INVALID");

    const emptyUpstream = await startFixture({ kind: "empty" });
    const emptyStack = await makeStack({ upstream: emptyUpstream });
    const emptyIssued = await issueToken(emptyStack.grants, "turn-empty");
    const emptyResponse = await postModel(
      emptyStack.port,
      { messages: CHAT_MESSAGES, model: "model-a" },
      emptyIssued.token,
    );
    expect(emptyResponse.status).toBe(502);
    expect(await errorCode(emptyResponse)).toBe("CLOUD_MODEL_UPSTREAM_INVALID");
  });

  it("rejects an upstream that declares more bytes than the response cap without reading it", async () => {
    const maxResponseBytes = 32 * 1024;
    const upstream = await startFixture({ kind: "stall", declaredLength: 4 * maxResponseBytes });
    const { grants, port } = await makeStack({
      upstream,
      configOverrides: { maxResponseBytes, requestTimeoutMs: 30_000 },
    });
    const issued = await issueToken(grants);
    const response = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a" }, issued.token);
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("CLOUD_MODEL_UPSTREAM_INVALID");
    expect(slotIsFree(grants, issued.claims.jti)).toBe(true);
  });

  it("aborts the upstream and releases the slot when the client disconnects mid-stream", async () => {
    const upstream = await startFixture({ kind: "slow-sse", chunkIntervalMs: 20 });
    const { grants, port } = await makeStack({ upstream, configOverrides: { requestTimeoutMs: 30_000 } });
    const issued = await issueToken(grants);
    // A dedicated connection (no keep-alive pool) makes the disconnect a real socket destroy
    // owned and cleaned up by this test. Node 22's global fetch leaves a replacement idle
    // keep-alive socket after an abort, which holds `app.close()` until the server keep-alive
    // timeout and times the afterEach hook out even though the route aborted correctly.
    const stream = await openModelStream(port, issued.token, {
      messages: CHAT_MESSAGES,
      model: "model-a",
      stream: true,
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.firstChunkBytes).toBeGreaterThan(0);
    stream.destroy();
    await vi.waitFor(() => expect(upstream.stats.prematureClose).toBe(true), { interval: 10, timeout: 2_000 });
    await vi.waitFor(() => expect(slotIsFree(grants, issued.claims.jti)).toBe(true), { interval: 10, timeout: 2_000 });
  });

  it("releases a backpressured stream on disconnect without waiting for the request timeout", async () => {
    const upstream = await startFixture({ kind: "backpressure", chunkBytes: 16 * 1024, totalBytes: 64 * 1024 * 1024 });
    const { grants, port } = await makeStack({
      upstream,
      configOverrides: { maxResponseBytes: 64 * 1024 * 1024, requestTimeoutMs: 30_000 },
    });
    const issued = await issueToken(grants);
    const result = await rawModelRequest(
      port,
      issued.token,
      { messages: CHAT_MESSAGES, model: "model-a" },
      {
        pauseAfterFirstChunkMs: 200,
      },
    );
    expect(result.bytes).toBeGreaterThan(0);
    await vi.waitFor(() => expect(slotIsFree(grants, issued.claims.jti)).toBe(true), { interval: 10, timeout: 3_000 });
    await vi.waitFor(() => expect(upstream.stats.prematureClose).toBe(true), { interval: 10, timeout: 2_000 });
  });

  it("aborts the in-flight stream and invalidates the token on revocation", async () => {
    const upstream = await startFixture({ kind: "slow-sse", chunkIntervalMs: 20 });
    const { grants, port } = await makeStack({ upstream, configOverrides: { requestTimeoutMs: 30_000 } });
    const issued = await issueToken(grants);
    const response = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a", stream: true }, issued.token);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no response stream");
    expect((await reader.read()).done).toBe(false);
    grants.revokeExecution("turn-1");
    await vi.waitFor(() => expect(upstream.stats.prematureClose).toBe(true), { interval: 10, timeout: 2_000 });
    const after = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a" }, issued.token);
    expect(after.status).toBe(401);
  });

  it("answers a stalled upstream with a sanitized 504 and releases the slot", async () => {
    const upstream = await startFixture({ kind: "stall" });
    const { grants, port } = await makeStack({ upstream, configOverrides: { requestTimeoutMs: 400 } });
    const issued = await issueToken(grants);
    const response = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a" }, issued.token);
    expect(response.status).toBe(504);
    expect(await errorCode(response)).toBe("CLOUD_MODEL_UPSTREAM_TIMEOUT");
    expect(slotIsFree(grants, issued.claims.jti)).toBe(true);
  });

  it("sanitizes upstream error bodies and never relays or logs the master key", async () => {
    const logs: string[] = [];
    const upstream = await startFixture({ kind: "error", status: 401 });
    const { grants, port } = await makeStack({
      logger: {
        level: "info",
        stream: {
          write: (line: string) => {
            logs.push(line);
          },
        },
      },
      upstream,
    });
    const issued = await issueToken(grants);
    const response = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a" }, issued.token);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("CLOUD_MODEL_UPSTREAM_ERROR");
    expect(body).toContain('"upstreamStatus":401');
    expect(body).not.toContain(FIXTURE_MASTER_KEY);
    expect(body).not.toContain(FIXTURE_ERROR_BODY_MARKER);
    expect(response.headers.get(FIXTURE_RESPONSE_HEADER)).toBeNull();
    expect(logs.join("\n")).not.toContain(FIXTURE_MASTER_KEY);
    expect(logs.join("\n")).not.toContain(FIXTURE_ERROR_BODY_MARKER);

    const failing = await startFixture({ kind: "error", status: 503 });
    const failingStack = await makeStack({ upstream: failing });
    const failingIssued = await issueToken(failingStack.grants, "turn-503");
    const failingResponse = await postModel(
      failingStack.port,
      { messages: CHAT_MESSAGES, model: "model-a" },
      failingIssued.token,
    );
    expect(failingResponse.status).toBe(503);
    expect(await errorCode(failingResponse)).toBe("CLOUD_MODEL_UPSTREAM_ERROR");
  });

  it("bounds concurrent streams per token", async () => {
    const upstream = await startFixture({ kind: "slow-sse", chunkIntervalMs: 20 });
    const { grants, port } = await makeStack({ upstream, configOverrides: { requestTimeoutMs: 30_000 } });
    const issued = await issueToken(grants);
    const first = await openModelStream(port, issued.token, {
      messages: CHAT_MESSAGES,
      model: "model-a",
      stream: true,
    });
    expect(first.statusCode).toBe(200);
    expect(first.firstChunkBytes).toBeGreaterThan(0);
    const saturated = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a" }, issued.token);
    expect(saturated.status).toBe(429);
    expect(await errorCode(saturated)).toBe("CLOUD_MODEL_STREAMS_EXHAUSTED");
    first.destroy();
    await vi.waitFor(() => expect(slotIsFree(grants, issued.claims.jti)).toBe(true), { interval: 10, timeout: 2_000 });
    const after = await openModelStream(port, issued.token, {
      messages: CHAT_MESSAGES,
      model: "model-a",
      stream: true,
    });
    expect(after.statusCode).toBe(200);
    after.destroy();
  });

  it("aborts an open stream and releases the upstream on app.close within a bounded time", async () => {
    const upstream = await startFixture({ kind: "slow-sse", chunkIntervalMs: 10 });
    const { app, grants, port } = await makeStack({ upstream, configOverrides: { requestTimeoutMs: 30_000 } });
    const issued = await issueToken(grants);
    const response = await postModel(port, { messages: CHAT_MESSAGES, model: "model-a", stream: true }, issued.token);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no response stream");
    expect((await reader.read()).done).toBe(false);
    const outcome = await Promise.race([
      app.close().then(() => "closed" as const),
      delay(3_000).then(() => "timeout" as const),
    ]);
    expect(outcome).toBe("closed");
    await vi.waitFor(() => expect(upstream.stats.prematureClose).toBe(true), { interval: 10, timeout: 3_000 });
    expect(await grants.verify(issued.token)).toBeUndefined();
  }, 10_000);
});
