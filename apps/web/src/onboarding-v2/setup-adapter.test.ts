/**
 * The HTTP Agent Setup adapter, and its alignment with the in-memory one.
 *
 * The two adapters are held to the same behavior: the snapshot the in-memory model derives is the
 * snapshot the HTTP adapter parses back verbatim, and both refuse a write that does not name the
 * current binding. If the two ever disagree, the pages tested against the memory adapter stop
 * meaning anything about production.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, BrowserApi, ResponseSchemaError } from "../api.js";
import { SETUP_AGENT_ID, setupAgent } from "./agent-setup-test-fixtures.js";
import { type AgentSetupAdapter, createHttpSetupAdapter } from "./setup-adapter.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const BINDING_ID = "44444444-4444-4444-8444-444444444444";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorEnvelope(status: number, code: string): Response {
  return jsonResponse({ error: { code, message: `refused: ${code}`, category: "deterministic" } }, status);
}

function setDocumentCookie(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")?.set;
  if (!setter) throw new Error("The test DOM does not expose a cookie setter");
  setter.call(document, value);
}

afterEach(() => {
  setDocumentCookie("opentag_csrf=; Path=/; Max-Age=0");
});

describe("createHttpSetupAdapter", () => {
  it("reads the canonical snapshot for the exact Agent", async () => {
    const { adapter: memory } = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true },
    });
    const snapshot = await memory.readSnapshot(SETUP_AGENT_ID);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`/api/v1/agents/${SETUP_AGENT_ID}/setup`);
      expect(init?.method ?? "GET").toBe("GET");
      return jsonResponse(snapshot);
    });

    const adapter = createHttpSetupAdapter(new BrowserApi(fetchImpl));
    await expect(adapter.readSnapshot(SETUP_AGENT_ID)).resolves.toEqual(snapshot);
  });

  it("rejects a malformed snapshot rather than handing the page a non-canonical one", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ stage: "mostly-ready" }));
    const adapter = createHttpSetupAdapter(new BrowserApi(fetchImpl));
    const failure = await adapter.readSnapshot(SETUP_AGENT_ID).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ResponseSchemaError);
    expect(failure).toMatchObject({
      code: "invalid_response_schema",
      routeTemplate: "/api/v1/agents/:id/setup",
    });
  });

  it("surfaces the Server's refusal with its code", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => errorEnvelope(404, "RESOURCE_NOT_FOUND"));
    const adapter = createHttpSetupAdapter(new BrowserApi(fetchImpl));
    const failure = await adapter.readSnapshot(SETUP_AGENT_ID).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(404);
    expect((failure as ApiError).code).toBe("RESOURCE_NOT_FOUND");
  });

  it("starts a real preparation operation before Check again reads a snapshot", async () => {
    setDocumentCookie("opentag_csrf=refresh-csrf; Path=/");
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`/api/v1/agents/${SETUP_AGENT_ID}/setup/refresh`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("X-OpenTag-CSRF")).toBe("refresh-csrf");
      return new Response(null, { status: 204 });
    });

    const adapter = createHttpSetupAdapter(new BrowserApi(fetchImpl));
    await expect(adapter.refreshPreparation(SETUP_AGENT_ID)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("opens a Feishu attempt on the exact Agent with the requested intent", async () => {
    setDocumentCookie("opentag_csrf=setup-csrf; Path=/");
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`/api/v1/agents/${SETUP_AGENT_ID}/im-binding/feishu/setup-attempts`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(
        JSON.stringify({
          intent: "replace",
          expectedMessaging: {
            kind: "bound",
            provider: "feishu",
            bindingId: BINDING_ID,
            credentialGeneration: 3,
          },
        }),
      );
      expect(new Headers(init?.headers).get("X-OpenTag-CSRF")).toBe("setup-csrf");
      return jsonResponse({
        id: ATTEMPT_ID,
        agentId: SETUP_AGENT_ID,
        intent: "replace",
        state: "awaiting_user",
        qrUrl: "https://accounts.feishu.cn/device",
        expiresAt: "2026-09-01T10:10:00.000Z",
        errorCode: null,
        completedAt: null,
        createdAt: "2026-09-01T10:00:00.000Z",
      });
    });

    const adapter = createHttpSetupAdapter(new BrowserApi(fetchImpl));
    await expect(
      adapter.startFeishuAttempt(SETUP_AGENT_ID, "replace", {
        kind: "bound",
        provider: "feishu",
        bindingId: BINDING_ID,
        credentialGeneration: 3,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels the exact open Feishu attempt", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`/api/v1/im-bindings/feishu/setup-attempts/${ATTEMPT_ID}/cancel`);
      expect(init?.method).toBe("POST");
      return jsonResponse({
        id: ATTEMPT_ID,
        agentId: SETUP_AGENT_ID,
        intent: "create",
        state: "canceled",
        qrUrl: null,
        expiresAt: "2026-09-01T10:10:00.000Z",
        errorCode: null,
        completedAt: "2026-09-01T10:01:00.000Z",
        createdAt: "2026-09-01T10:00:00.000Z",
      });
    });

    const adapter = createHttpSetupAdapter(new BrowserApi(fetchImpl));
    await expect(adapter.cancelFeishuAttempt(ATTEMPT_ID)).resolves.toBeUndefined();
  });

  it("starts the Slack install and returns the URL the browser is sent to", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`/api/v1/agents/${SETUP_AGENT_ID}/im-binding/slack/oauth/start`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(
        JSON.stringify({
          intent: "reauthorize",
          returnSurface: "agent-setup",
          expectedMessaging: {
            kind: "bound",
            provider: "slack",
            bindingId: BINDING_ID,
            credentialGeneration: 4,
          },
        }),
      );
      return jsonResponse({
        authorizationUrl: "https://slack.com/oauth/v2/authorize?state=signed",
        expiresAt: "2026-09-01T10:10:00.000Z",
      });
    });

    const adapter = createHttpSetupAdapter(new BrowserApi(fetchImpl));
    await expect(
      adapter.startSlackInstall(SETUP_AGENT_ID, "reauthorize", {
        kind: "bound",
        provider: "slack",
        bindingId: BINDING_ID,
        credentialGeneration: 4,
      }),
    ).resolves.toBe("https://slack.com/oauth/v2/authorize?state=signed");
  });

  it("unbinds the exact current binding", async () => {
    setDocumentCookie("opentag_csrf=unbind-csrf; Path=/");
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`/api/v1/agents/${SETUP_AGENT_ID}/im-binding/unbind`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ provider: "slack", bindingId: BINDING_ID }));
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(new Headers(init?.headers).get("X-OpenTag-CSRF")).toBe("unbind-csrf");
      return new Response(null, { status: 204 });
    });

    const adapter = createHttpSetupAdapter(new BrowserApi(fetchImpl));
    await expect(adapter.unbindMessaging(SETUP_AGENT_ID, "slack", BINDING_ID)).resolves.toBeUndefined();
  });
});

describe("Agent Setup adapter alignment", () => {
  it("reads the same snapshot through HTTP that the in-memory model derives", async () => {
    const { adapter: memory, controls } = createMemorySetupAdapter({ agent: setupAgent() });
    await memory.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    controls.scanFeishuCode();
    const expected = await memory.readSnapshot(SETUP_AGENT_ID);

    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(expected));
    const http = createHttpSetupAdapter(new BrowserApi(fetchImpl));
    await expect(http.readSnapshot(SETUP_AGENT_ID)).resolves.toEqual(expected);
  });

  it("rejects an unbind that does not name the current binding on both adapters", async () => {
    const { adapter: memory } = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "feishu", reachable: true },
    });
    await expect(memory.unbindMessaging(SETUP_AGENT_ID, "feishu", BINDING_ID)).rejects.toThrow(
      /not the current binding/,
    );

    const fetchImpl = vi.fn<typeof fetch>(async () => errorEnvelope(409, "IM_BINDING_NOT_FOUND"));
    const http = createHttpSetupAdapter(new BrowserApi(fetchImpl));
    await expect(http.unbindMessaging(SETUP_AGENT_ID, "feishu", BINDING_ID)).rejects.toBeInstanceOf(ApiError);
  });

  it("moves both adapters through the same create scan ready transition", async () => {
    const { adapter: memory, controls } = createMemorySetupAdapter({ agent: setupAgent() });

    // The HTTP side is driven by a Server that answers with the memory model's current snapshot,
    // so each write lands on exactly the state the in-memory adapter is holding.
    const api = new BrowserApi(vi.fn<typeof fetch>(memoryBackedFetch(memory)));
    const http = createHttpSetupAdapter(api);

    await http.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    const authorizing = await http.readSnapshot(SETUP_AGENT_ID);
    expect(authorizing.messaging).toMatchObject({ kind: "authorizing", provider: "feishu" });

    controls.scanFeishuCode();
    controls.completeHandoff();
    const ready = await http.readSnapshot(SETUP_AGENT_ID);
    expect(ready.stage).toBe("ready");
    expect(ready.messaging).toMatchObject({ kind: "ready", provider: "feishu" });
  });
});

/** A fetch that answers with the in-memory model's state, standing in for the Server. */
function memoryBackedFetch(memory: AgentSetupAdapter): typeof fetch {
  return async (input) => {
    const path = String(input);
    if (path.endsWith("/setup")) return jsonResponse(await memory.readSnapshot(SETUP_AGENT_ID));
    if (path.endsWith("/im-binding/feishu/setup-attempts")) return openMemoryAttempt(memory);
    throw new Error(`unexpected request: ${path}`);
  };
}

async function openMemoryAttempt(memory: AgentSetupAdapter): Promise<Response> {
  await memory.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
  const snapshot = await memory.readSnapshot(SETUP_AGENT_ID);
  const attempt = snapshot.messaging;
  const feishuAttempt = attempt.kind === "authorizing" && attempt.provider === "feishu" ? attempt : undefined;
  return jsonResponse({
    id: feishuAttempt?.attemptId ?? "",
    agentId: SETUP_AGENT_ID,
    intent: "create",
    state: "awaiting_user",
    qrUrl: feishuAttempt?.qrUrl ?? null,
    expiresAt: "2026-09-01T10:10:00.000Z",
    errorCode: null,
    completedAt: null,
    createdAt: "2026-09-01T10:00:00.000Z",
  });
}
