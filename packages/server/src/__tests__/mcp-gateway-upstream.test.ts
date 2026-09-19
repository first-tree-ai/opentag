import { MCP_MODERN_PROTOCOL_VERSION } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { McpUpstreamCaller } from "../services/mcp/mcp-gateway-upstream.js";
import {
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_RUNTIME_TIMEOUT_MS,
  type McpFetchInit,
  type McpFetchResponse,
  McpOutboundFetcher,
} from "../services/mcp/mcp-url-policy.js";

/**
 * Era dispatch for a runtime tool call.
 *
 * The probe already knows how to speak to both eras, but its knowledge is a fixed two-step script;
 * a tool call is one arbitrary method with its own budget. What must not diverge between them is the
 * downgrade *rule*: on a rejection the body decides, and a modern peer that merely dislikes our
 * version is retried, never downgraded — a modern Server would refuse `initialize` too.
 */

const ACCOUNT = "account-1";
const URL_ = "https://linear.example.com/mcp";

interface Exchange {
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A fetcher scripted by request method, recording what each hop actually sent. */
function scriptedFetcher(script: (body: Record<string, unknown>, hop: number) => McpFetchResponse) {
  const sent: Exchange[] = [];
  let hop = 0;
  const fetcher = {
    fetchOutbound: async (_accountId: string, _url: string, init: McpFetchInit = {}): Promise<McpFetchResponse> => {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      sent.push({
        method: String(body.method ?? ""),
        body,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      return script(body, hop++);
    },
  } as unknown as McpOutboundFetcher;
  return { fetcher, sent };
}

function rpcOk(body: Record<string, unknown>, result: unknown): McpFetchResponse {
  return {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
  };
}

function rpcFail(body: Record<string, unknown>, status: number, error: unknown): McpFetchResponse {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: JSON.stringify({ jsonrpc: "2.0", id: body.id, error }),
  };
}

function call(fetcher: McpOutboundFetcher, overrides: Record<string, unknown> = {}) {
  return new McpUpstreamCaller({ fetcher }).call({
    accountId: ACCOUNT,
    url: URL_,
    authHeaders: { authorization: "Bearer upstream" },
    method: "tools/call",
    params: { name: "create_issue", arguments: {} },
    name: "create_issue",
    cachedEra: "modern",
    cachedVersion: MCP_MODERN_PROTOCOL_VERSION,
    ...overrides,
  });
}

describe("the modern path", () => {
  it("calls once at the row's cached version", async () => {
    const { fetcher, sent } = scriptedFetcher((body) => rpcOk(body, { content: [] }));
    await call(fetcher);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("tools/call");
    expect(sent[0]?.headers["MCP-Protocol-Version"]).toBe(MCP_MODERN_PROTOCOL_VERSION);
  });

  it("carries the Agent's upstream authorization header", async () => {
    const { fetcher, sent } = scriptedFetcher((body) => rpcOk(body, { content: [] }));
    await call(fetcher);
    expect(sent[0]?.headers.authorization).toBe("Bearer upstream");
  });

  it("defaults to the modern version when the row has no cached one", async () => {
    const { fetcher, sent } = scriptedFetcher((body) => rpcOk(body, { content: [] }));
    await call(fetcher, { cachedVersion: null });
    expect(sent[0]?.headers["MCP-Protocol-Version"]).toBe(MCP_MODERN_PROTOCOL_VERSION);
  });

  /*
   * `-32022` is the modern "unsupported protocol version" signal: the peer IS modern and named the
   * versions it speaks. Retrying with one of those is right; downgrading to `initialize` is not.
   */
  it("retries at a version the peer advertised rather than downgrading", async () => {
    const { fetcher, sent } = scriptedFetcher((body, hop) =>
      hop === 0
        ? rpcFail(body, 400, {
            code: -32022,
            message: "unsupported",
            data: { supported: [MCP_MODERN_PROTOCOL_VERSION] },
          })
        : rpcOk(body, { content: [] }),
    );
    await call(fetcher, { cachedVersion: "2099-01-01" });
    // Two dispatches, and both on the modern path: the refusal proved the first never executed.
    expect(sent.map((exchange) => exchange.method)).toEqual(["tools/call", "tools/call"]);
    expect(sent[1]?.headers["MCP-Protocol-Version"]).toBe(MCP_MODERN_PROTOCOL_VERSION);
  });
});

describe("the legacy path", () => {
  it("handshakes before the call when the row records the legacy era", async () => {
    const { fetcher, sent } = scriptedFetcher((body) =>
      body.method === "initialize"
        ? {
            status: 200,
            headers: new Headers({ "content-type": "application/json", "mcp-session-id": "sess-1" }),
            text: JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { protocolVersion: "2025-06-18", capabilities: {} },
            }),
          }
        : rpcOk(body, { content: [] }),
    );
    await call(fetcher, { cachedEra: "legacy", cachedVersion: "2025-06-18" });
    expect(sent.map((exchange) => exchange.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(sent[2]?.headers["MCP-Protocol-Version"]).toBe("2025-06-18");
    // The session the handshake opened rides every subsequent request.
    expect(sent[2]?.headers["mcp-session-id"]).toBe("sess-1");
  });

  it("skips the initialized notification when the peer opened no session", async () => {
    const { fetcher, sent } = scriptedFetcher((body) =>
      rpcOk(body, body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { content: [] }),
    );
    await call(fetcher, { cachedEra: "legacy" });
    expect(sent.map((exchange) => exchange.method)).toEqual(["initialize", "tools/call"]);
  });

  /*
   * The supported set includes the modern version, so a legacy peer naming it must not have the
   * modern header stamped on a handshake-based session — the exact confusion the probe guards too.
   */
  it("refuses to speak a non-legacy version on the legacy path", async () => {
    const { fetcher, sent } = scriptedFetcher((body) =>
      rpcOk(body, body.method === "initialize" ? { protocolVersion: MCP_MODERN_PROTOCOL_VERSION } : { content: [] }),
    );
    await call(fetcher, { cachedEra: "legacy" });
    expect(sent[1]?.headers["MCP-Protocol-Version"]).toBeUndefined();
  });
});

/*
 * A tool call is not idempotent. Replaying one can file the issue twice and report only the second,
 * so every case below asserts the *number of dispatches*, not merely that the call failed.
 */
describe("a failed call is never replayed", () => {
  it.each([
    {
      name: "an HTTP 500",
      respond: (body: Record<string, unknown>) => rpcFail(body, 500, { code: -32603, message: "boom" }),
    },
    {
      name: "an HTTP 200 carrying -32603",
      respond: (body: Record<string, unknown>) => rpcFail(body, 200, { code: -32603, message: "internal" }),
    },
    {
      /* `-32601` can come from inside the tool, so it is not evidence about the protocol era. */
      name: "a -32601 that may have come from the tool",
      respond: (body: Record<string, unknown>) => rpcFail(body, 404, { code: -32601, message: "no such tool" }),
    },
    {
      /* Previously read as "this peer predates us" and answered by replaying over the handshake. */
      name: "a 404 whose body is not a modern error",
      respond: () => ({
        status: 404,
        headers: new Headers({ "content-type": "text/html" }),
        text: "<html>Not Found</html>",
      }),
    },
    {
      name: "a 400 whose body is not a modern error",
      respond: () => ({
        status: 400,
        headers: new Headers({ "content-type": "text/html" }),
        text: "<html>Bad Request</html>",
      }),
    },
    {
      name: "an upstream argument complaint",
      respond: (body: Record<string, unknown>) => rpcFail(body, 200, { code: -32602, message: "bad arguments" }),
    },
  ])("dispatches once for $name", async ({ respond }) => {
    const { fetcher, sent } = scriptedFetcher((body) => respond(body));
    await expect(call(fetcher)).rejects.toThrow();
    expect(sent.filter((exchange) => exchange.method === "tools/call")).toHaveLength(1);
    // Nor may it fall back to the handshake, which would dispatch the call a second time.
    expect(sent.some((exchange) => exchange.method === "initialize")).toBe(false);
  });

  it("dispatches once on the legacy path too", async () => {
    const { fetcher, sent } = scriptedFetcher((body) =>
      body.method === "initialize"
        ? rpcOk(body, { protocolVersion: "2025-06-18" })
        : rpcFail(body, 500, { code: -32603, message: "boom" }),
    );
    await expect(call(fetcher, { cachedEra: "legacy" })).rejects.toThrow();
    expect(sent.filter((exchange) => exchange.method === "tools/call")).toHaveLength(1);
  });

  it("still reports the upstream failure rather than swallowing it", async () => {
    const { fetcher } = scriptedFetcher((body) => rpcFail(body, 200, { code: -32602, message: "bad arguments" }));
    await expect(call(fetcher)).rejects.toThrow(/bad arguments/);
  });
});

/*
 * The runtime fetcher is a second instance, not a second configuration of the same one: `#inFlight`
 * is per instance, so separating the objects is what separates the budgets. These assert the two
 * properties the gateway depends on, at the level a composition change could break them.
 */
describe("the runtime outbound budget", () => {
  it("is longer than the probe deadline", () => {
    expect(MCP_RUNTIME_TIMEOUT_MS).toBeGreaterThan(MCP_DEFAULT_TIMEOUT_MS);
  });

  it("counts concurrency separately from the management fetcher", async () => {
    const stall = new Promise<never>(() => undefined);
    const management = new McpOutboundFetcher({
      allowLoopback: true,
      maxConcurrentPerAccount: 1,
      fetch: (async () => stall) as unknown as typeof globalThis.fetch,
      resolveAddresses: async () => ["203.0.113.10"],
    });
    const runtime = new McpOutboundFetcher({
      allowLoopback: true,
      maxConcurrentPerAccount: 1,
      fetch: (async () => stall) as unknown as typeof globalThis.fetch,
      resolveAddresses: async () => ["203.0.113.10"],
    });
    // Fill the management budget and leave it held, as a slow probe would.
    void management.fetchOutbound(ACCOUNT, URL_, { method: "POST" }).catch(() => undefined);
    await vi.waitFor(() =>
      expect(management.fetchOutbound(ACCOUNT, URL_, { method: "POST" })).rejects.toThrow(/Too many concurrent/),
    );
    // The runtime fetcher still has its own slot; a probe cannot starve a live tool call.
    const admitted = runtime.fetchOutbound(ACCOUNT, URL_, { method: "POST" });
    await expect(Promise.race([admitted, timeoutMarker()])).resolves.toBe("still-running");
  });
});

/** Resolves after a tick, so a request that was admitted (and is stalling) is distinguishable. */
function timeoutMarker(): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve("still-running"), 10));
}
