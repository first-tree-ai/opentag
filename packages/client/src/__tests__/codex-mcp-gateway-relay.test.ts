import { MCP_GATEWAY_REQUEST_MAX_BYTES } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodexMcpGatewayRelay,
  codexMcpGatewayServersOverride,
  startCodexMcpGatewayRelay,
} from "../providers/codex/mcp-gateway-relay.js";

const GATEWAY = { url: "https://server.example.test/api/v1/mcp", token: "otmg_secret" };
const relays: CodexMcpGatewayRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

async function start(fetchUpstream?: typeof fetch): Promise<CodexMcpGatewayRelay> {
  const relay = await startCodexMcpGatewayRelay(fetchUpstream ? { fetch: fetchUpstream } : {});
  relays.push(relay);
  return relay;
}

function post(relay: CodexMcpGatewayRelay, body: unknown, init: { headers?: Record<string, string> } = {}) {
  return fetch(relay.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${relay.token}`,
      "content-type": "application/json",
      ...init.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("Codex MCP gateway relay", () => {
  it("mounts the relay as the only, pre-approved MCP server reading its bearer from the environment", () => {
    expect(codexMcpGatewayServersOverride("http://127.0.0.1:4100/mcp")).toBe(
      'mcp_servers={ "opentag-mcp" = { url = "http://127.0.0.1:4100/mcp", bearer_token_env_var = "OPENTAG_MCP_RELAY_TOKEN", default_tools_approval_mode = "approve" } }',
    );
  });

  it("serves only its own path to its own bearer", async () => {
    const relay = await start();
    expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const origin = new URL(relay.url).origin;
    expect((await fetch(`${origin}/other`, { method: "POST" })).status).toBe(404);
    expect((await fetch(relay.url, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await post(relay, {}, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect(
      (await post(relay, {}, { headers: { authorization: `Bearer ${"x".repeat(relay.token.length)}` } })).status,
    ).toBe(401);
    const get = await fetch(relay.url, { headers: { authorization: `Bearer ${relay.token}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(get.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a request body above the gateway bound", async () => {
    const relay = await start();
    const response = await post(relay, "x".repeat(MCP_GATEWAY_REQUEST_MAX_BYTES + 1));
    expect(response.status).toBe(413);
  });

  it("answers the MCP handshake with an empty catalogue while detached", async () => {
    const relay = await start();
    const initialize = await post(relay, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(await initialize.json()).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } } },
    });
    const legacy = await post(relay, { jsonrpc: "2.0", id: "a", method: "initialize", params: null });
    expect(await legacy.json()).toMatchObject({ id: "a", result: { protocolVersion: "2025-03-26" } });
    expect((await post(relay, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect(await (await post(relay, { jsonrpc: "2.0", id: 2, method: "ping" })).json()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {},
    });
    expect(await (await post(relay, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json()).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { tools: [] },
    });
    expect(
      await (await post(relay, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "x" } })).json(),
    ).toMatchObject({ id: 4, result: { isError: true } });
    expect(await (await post(relay, { jsonrpc: "2.0", id: 5, method: "resources/list" })).json()).toMatchObject({
      id: 5,
      error: { code: -32601 },
    });
    for (const invalid of ["not json", "[1]", "null", JSON.stringify({ id: 1 })]) {
      expect((await post(relay, invalid)).status).toBe(400);
    }
  });

  it("forwards to the attached gateway with the execution bearer and returns its answer", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchUpstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a__b" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const relay = await start(fetchUpstream as typeof fetch);
    relay.setUpstream(GATEWAY);
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const response = await post(relay, body, { headers: { "mcp-protocol-version": "2025-03-26" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a__b" }] } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(GATEWAY.url);
    expect(calls[0]?.init).toMatchObject({ method: "POST", redirect: "error" });
    // The relay bearer never leaves the Computer; only the execution bearer reaches the Server.
    expect(calls[0]?.init.headers).toEqual({
      accept: "*/*",
      authorization: "Bearer otmg_secret",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-03-26",
    });
    expect(JSON.parse(Buffer.from(calls[0]?.init.body as Uint8Array).toString("utf8"))).toEqual(body);

    relay.setUpstream(undefined);
    await post(relay, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(fetchUpstream).toHaveBeenCalledOnce();
  });

  it("relays gateway rejections, including ones without a content type", async () => {
    const relay = await start((async () => new Response(null, { status: 409 })) as unknown as typeof fetch);
    relay.setUpstream(GATEWAY);
    const response = await post(relay, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBeNull();
  });

  it("answers an unreachable gateway as a JSON-RPC failure for the same request", async () => {
    const relay = await start((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    relay.setUpstream(GATEWAY);
    const numbered = await post(relay, { jsonrpc: "2.0", id: 9, method: "tools/call" });
    expect(numbered.status).toBe(502);
    expect(await numbered.json()).toMatchObject({ id: 9, error: { code: -32603 } });
    for (const body of ["not json", JSON.stringify({ jsonrpc: "2.0", id: { nested: true } }), "null"]) {
      expect(await (await post(relay, body)).json()).toMatchObject({ id: null });
    }
  });

  it("fails a request whose gateway response cannot be read", async () => {
    const relay = await start((async () => ({
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => {
        throw new Error("body stream broke");
      },
    })) as unknown as typeof fetch);
    relay.setUpstream(GATEWAY);
    const response = await post(relay, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(502);
  });

  it("cancels the gateway call when Codex abandons the request", async () => {
    let upstreamSignal: AbortSignal | undefined;
    let markReached: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    const relay = await start((async (_url: string, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      markReached();
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as unknown as typeof fetch);
    relay.setUpstream(GATEWAY);
    const controller = new AbortController();
    const pending = fetch(relay.url, {
      method: "POST",
      headers: { authorization: `Bearer ${relay.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      signal: controller.signal,
    }).catch(() => undefined);
    await reached;
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
  });

  it("closes once and stops serving", async () => {
    const relay = await startCodexMcpGatewayRelay();
    relay.setUpstream(GATEWAY);
    const first = relay.close();
    expect(relay.close()).toBe(first);
    await first;
    await expect(post(relay, { jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow();
  });
});
