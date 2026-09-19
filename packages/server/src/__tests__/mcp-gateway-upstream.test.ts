import { MCP_MODERN_PROTOCOL_VERSION } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { McpUpstreamCaller } from "../services/mcp/mcp-gateway-upstream.js";
import type { McpFetchInit, McpFetchResponse, McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";

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
    const result = await call(fetcher);
    expect(result).toMatchObject({
      era: "modern",
      protocolVersion: MCP_MODERN_PROTOCOL_VERSION,
      eraInvalidated: false,
    });
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
    const result = await call(fetcher, { cachedVersion: "2099-01-01" });
    expect(result.era).toBe("modern");
    expect(sent.map((exchange) => exchange.method)).toEqual(["tools/call", "tools/call"]);
    expect(result.eraInvalidated).toBe(true);
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
    const result = await call(fetcher, { cachedEra: "legacy", cachedVersion: "2025-06-18" });
    expect(result).toMatchObject({ era: "legacy", protocolVersion: "2025-06-18" });
    expect(sent.map((exchange) => exchange.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
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
    const result = await call(fetcher, { cachedEra: "legacy" });
    expect(result.protocolVersion).toBe("");
    expect(sent[1]?.headers["MCP-Protocol-Version"]).toBeUndefined();
  });

  /*
   * An unrecognizable body on a rejection means the peer predates this client, so the handshake is
   * the only way forward — the one case where downgrading is correct.
   */
  it("downgrades when the peer answers a modern call with a pre-modern body", async () => {
    const { fetcher, sent } = scriptedFetcher((body, hop) => {
      if (hop === 0) {
        return { status: 404, headers: new Headers({ "content-type": "text/html" }), text: "<html>Not Found</html>" };
      }
      return rpcOk(body, body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { content: [] });
    });
    const result = await call(fetcher, { cachedEra: null, cachedVersion: null });
    expect(result.era).toBe("legacy");
    expect(sent.map((exchange) => exchange.method)).toEqual(["tools/call", "initialize", "tools/call"]);
  });

  it("reports a cached modern era as invalidated once it proves to be legacy", async () => {
    const { fetcher } = scriptedFetcher((body, hop) => {
      if (hop === 0) {
        return { status: 404, headers: new Headers({ "content-type": "text/html" }), text: "<html/>" };
      }
      return rpcOk(body, body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { content: [] });
    });
    const result = await call(fetcher);
    expect(result).toMatchObject({ era: "legacy", eraInvalidated: true });
  });
});

describe("failures", () => {
  it("propagates a transport failure that says nothing about the era", async () => {
    const { fetcher } = scriptedFetcher(() => ({
      status: 500,
      headers: new Headers({ "content-type": "application/json" }),
      text: "{}",
    }));
    await expect(call(fetcher)).rejects.toThrow();
  });

  it("propagates an upstream JSON-RPC tool error unchanged", async () => {
    const { fetcher } = scriptedFetcher((body) => rpcFail(body, 200, { code: -32602, message: "bad arguments" }));
    await expect(call(fetcher)).rejects.toThrow(/bad arguments/);
  });
});
