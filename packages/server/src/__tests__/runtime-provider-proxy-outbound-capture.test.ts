import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RuntimeProxyAuthorization } from "../runtime-credentials/credential-broker.js";
import { FEISHU_OPERATIONS } from "../runtime-credentials/feishu-operations.js";
import { ProviderOperationRegistry } from "../runtime-credentials/operation-registry.js";
import {
  ImProviderProxyAdapter,
  type OutboundWriteCaptureEvent,
  type ProviderProxyRequest,
  type RuntimeProxyError,
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
    bindingId: "binding-from-request",
    method: "POST",
    path: "/api/chat.postMessage",
    headers: {},
    body: jsonBody({ channel: "C0123ABCD", text: "hello" }),
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
    bindingId: "binding-authorized",
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

function adapter(options: {
  provider?: "slack" | "feishu";
  fetchImpl?: typeof fetch;
  capture?: { calls: OutboundWriteCaptureEvent[]; error?: Error };
}) {
  const provider = options.provider ?? "slack";
  const instance = new ImProviderProxyAdapter({
    provider,
    registry: new ProviderOperationRegistry(provider === "slack" ? SLACK_OPERATIONS : FEISHU_OPERATIONS),
    urlHandles: new RuntimeUrlHandleStore(),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    outboundCapture: {
      capture: async (event) => {
        options.capture?.calls.push(event);
        if (options.capture?.error) throw options.capture.error;
      },
    },
  });
  return instance;
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function fetchOnce(payload: unknown, init: ResponseInit = {}): { calls: number; fetchImpl: typeof fetch } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    fetchImpl: (async () => {
      state.calls += 1;
      return jsonResponse(payload, init);
    }) as typeof fetch,
  };
}

async function readBody(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const SLACK_SUCCESS = {
  ok: true,
  channel: "C0123ABCD",
  ts: "1790042400.000100",
  message: { type: "message", text: "Confirmed", bot_id: "B0123BOT" },
};

describe("ImProviderProxyAdapter outbound capture", () => {
  it("hands the verified success to capture with the native payload before URL rewriting", async () => {
    const payload = {
      ...SLACK_SUCCESS,
      message: { ...SLACK_SUCCESS.message, url_private: "https://files.slack.com/files-pri/secret" },
    };
    const upstream = fetchOnce(payload);
    const capture = { calls: [] as OutboundWriteCaptureEvent[] };
    const instance = adapter({ fetchImpl: upstream.fetchImpl, capture });
    const response = await instance.handle(request(), authorization());

    expect(upstream.calls).toBe(1);
    expect(capture.calls).toHaveLength(1);
    const event = capture.calls[0];
    if (!event) throw new Error("Expected one capture call");
    expect(event).toMatchObject({
      provider: "slack",
      operationId: "chat.postMessage",
      // The Server-authorized binding, never the request body.
      bindingId: "binding-authorized",
      query: "",
      pathParams: {},
    });
    const capturedPayload = event.responsePayload as { message?: { url_private?: string } };
    expect(capturedPayload.message?.url_private).toBe("https://files.slack.com/files-pri/secret");
    // The caller still receives the rewritten response with handles, never the native URL.
    const body = JSON.parse(await readBody(response.body)) as { message?: { url_private?: string } };
    expect(body.message?.url_private).toContain("/__opentag__/handles/");
    expect(event.observedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(event.requestBody).toMatchObject({ channel: "C0123ABCD" });
  });

  it("does not capture a business rejection", async () => {
    const upstream = fetchOnce({ ok: false, error: "channel_not_found" });
    const capture = { calls: [] as OutboundWriteCaptureEvent[] };
    const instance = adapter({ fetchImpl: upstream.fetchImpl, capture });
    const response = await instance.handle(request(), authorization());

    expect(response.status).toBe(200);
    expect(capture.calls).toHaveLength(0);
    expect(upstream.calls).toBe(1);
  });

  it("does not capture an unconfirmed outcome and still reports write_outcome_unknown", async () => {
    const upstream = fetchOnce({ ok: "maybe" });
    const capture = { calls: [] as OutboundWriteCaptureEvent[] };
    const instance = adapter({ fetchImpl: upstream.fetchImpl, capture });

    await expect(instance.handle(request(), authorization())).rejects.toMatchObject({
      name: "RuntimeProxyError",
      code: "write_outcome_unknown",
    } satisfies Partial<RuntimeProxyError>);
    expect(capture.calls).toHaveLength(0);
    expect(upstream.calls).toBe(1);
  });

  it("does not capture a definite platform rejection status", async () => {
    const upstream = fetchOnce({ ok: false, error: "invalid_auth" }, { status: 403 });
    const capture = { calls: [] as OutboundWriteCaptureEvent[] };
    const instance = adapter({ fetchImpl: upstream.fetchImpl, capture });
    const response = await instance.handle(request(), authorization());

    expect(response.status).toBe(403);
    expect(capture.calls).toHaveLength(0);
  });

  it("captures a Feishu reply success with the verified reply target", async () => {
    const payload = {
      code: 0,
      msg: "success",
      data: {
        message_id: "om_child",
        chat_id: "oc_chat",
        root_id: "om_root",
        parent_id: "om_parent",
        msg_type: "text",
        create_time: "1790042400000",
        body: { content: '{"text":"Confirmed"}' },
      },
    };
    const upstream = fetchOnce(payload);
    const capture = { calls: [] as OutboundWriteCaptureEvent[] };
    const instance = adapter({ provider: "feishu", fetchImpl: upstream.fetchImpl, capture });
    const response = await instance.handle(
      request({
        provider: "feishu",
        path: "/open-apis/im/v1/messages/om_parent/reply",
        body: jsonBody({ msg_type: "text", content: '{"text":"Confirmed"}' }),
      }),
      authorization({ provider: "feishu", cli: { provider: "feishu", appId: "cli_a", teamBrand: "feishu" } }),
    );

    expect(response.status).toBe(200);
    expect(upstream.calls).toBe(1);
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]).toMatchObject({
      provider: "feishu",
      operationId: "feishu.im.messages.reply",
      pathParams: { message_id: "om_parent" },
    });
  });

  it("a capture failure preserves the confirmed response and the single platform attempt", async () => {
    const upstream = fetchOnce(SLACK_SUCCESS);
    const capture = { calls: [] as OutboundWriteCaptureEvent[], error: new Error("database is down") };
    const instance = adapter({ fetchImpl: upstream.fetchImpl, capture });
    const response = await instance.handle(request(), authorization());

    expect(response.status).toBe(200);
    expect(JSON.parse(await readBody(response.body))).toMatchObject({ ok: true, ts: "1790042400.000100" });
    expect(capture.calls).toHaveLength(1);
    // Exactly one upstream attempt: a capture failure never causes a resend.
    expect(upstream.calls).toBe(1);
  });

  it("bounds the wait for a stalled capture port and preserves the confirmed response", async () => {
    const upstream = fetchOnce(SLACK_SUCCESS);
    const instance = new ImProviderProxyAdapter({
      provider: "slack",
      registry: new ProviderOperationRegistry(SLACK_OPERATIONS),
      urlHandles: new RuntimeUrlHandleStore(),
      fetchImpl: upstream.fetchImpl,
      captureWaitMs: 20,
      outboundCapture: { capture: () => new Promise<void>(() => undefined) },
    });

    const response = await instance.handle(request(), authorization());

    expect(response.status).toBe(200);
    expect(JSON.parse(await readBody(response.body))).toMatchObject({ ok: true, ts: "1790042400.000100" });
    expect(upstream.calls).toBe(1);
  });

  it("logs controlled capture failures without the thrown error payload", async () => {
    const upstream = fetchOnce(SLACK_SUCCESS);
    const logs: Record<string, unknown>[] = [];
    const instance = new ImProviderProxyAdapter({
      provider: "slack",
      registry: new ProviderOperationRegistry(SLACK_OPERATIONS),
      urlHandles: new RuntimeUrlHandleStore(),
      fetchImpl: upstream.fetchImpl,
      logger: { error: (fields) => logs.push(fields), warn: (fields) => logs.push(fields) },
      outboundCapture: {
        capture: async () => {
          throw new Error("Failed query parameters include synthetic-private-message-body");
        },
      },
    });

    const response = await instance.handle(request(), authorization());

    expect(response.status).toBe(200);
    expect(logs).toEqual([{ code: "IM_OUTBOUND_CAPTURE_FAILED", provider: "slack", operationId: "chat.postMessage" }]);
    expect(JSON.stringify(logs)).not.toContain("synthetic-private-message-body");
  });
});
