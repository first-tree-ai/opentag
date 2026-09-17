import { MCP_ERROR_CODES } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { McpProbe } from "../services/mcp/mcp-probe.js";
import { McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";

/**
 * Probing: `server/discover` then a *paginated* `tools/list`, plus the era handling that decides
 * whether an origin speaks the modern per-request model or the legacy handshake.
 *
 * The pagination assertions exist because a single-POST implementation looks correct against a
 * one-page Server and silently drops tools against a real one. `tools_truncated` is asserted to mean
 * "truncated or unfinished", not merely "the count cap was hit".
 */

const ACCOUNT = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const ENDPOINT = "https://mcp.example.com/mcp";

/**
 * A resolver answering one public address. The outbound gate resolves hostnames, and every test here
 * dials `mcp.example.com`, so without this they would each depend on real DNS.
 */
const PUBLIC_RESOLVE = { resolveAddresses: async (): Promise<string[]> => ["93.184.216.34"] };

interface Response {
  status: number;
  body?: unknown;
  raw?: string;
  contentType?: string;
}

function parseBody(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/**
 * A Server whose discovery answer is fixed and whose `tools/list` pages come from `pageTools`. The
 * page callback is only consulted for `tools/list`, so a test's page counter cannot be advanced by
 * the discovery request.
 */
function node(body: Response, pageTools?: (params: Record<string, unknown>) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const request = parseBody(call);
    const method = request.method;
    const params = (request.params ?? {}) as Record<string, unknown>;
    const next =
      (method === "tools/list" ? pageTools?.(params) : undefined) ??
      (method === "server/discover" ? body : { status: 404 });
    return new Response(next.raw ?? JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "content-type": next.contentType ?? "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    probe: new McpProbe({
      fetcher: new McpOutboundFetcher({ ...PUBLIC_RESOLVE, allowLoopback: false, fetch: fetchImpl }),
    }),
  };
}

function discover(body: Record<string, unknown>): Response {
  return { status: 200, body: { jsonrpc: "2.0", id: "1", result: body } };
}

function toolsPage(tools: unknown[], nextCursor?: string): Response {
  return {
    status: 200,
    body: { jsonrpc: "2.0", id: "1", result: { tools, ...(nextCursor ? { nextCursor } : {}) } },
  };
}

describe("MCP probe success path", () => {
  it("records the Server identity, capabilities, and instructions alongside the tools", async () => {
    const { probe } = node(
      discover({
        capabilities: { tools: {} },
        instructions: "Use these tools carefully.",
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
      }),
      () => toolsPage([{ name: "only" }]),
    );
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.instructions).toBe("Use these tools carefully.");
    expect(result.serverInfo).toEqual({ name: "fixture", version: "1" });
    expect(result.tools.map((tool) => tool.name)).toEqual(["only"]);
  });

  it("merges both pages into one snapshot instead of keeping only the first", async () => {
    let page = 0;
    const { probe } = node(discover({}), () => {
      page += 1;
      return page === 1
        ? toolsPage([{ name: "first", description: "one" }], "cursor-1")
        : toolsPage([{ name: "second", description: "two" }]);
    });
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });
    expect(result.probeState).toBe("succeeded");
    expect(result.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(result.toolsCount).toBe(2);
    expect(result.toolsTruncated).toBe(false);
  });

  it("sends the cursor on the second page and nothing on the first", async () => {
    const seen: unknown[] = [];
    let page = 0;
    const { probe } = node(discover({}), (params) => {
      seen.push(params.cursor);
      page += 1;
      return page === 1 ? toolsPage([{ name: "a" }], "c1") : toolsPage([{ name: "b" }]);
    });
    await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });
    expect(seen).toEqual([undefined, "c1"]);
  });

  it("marks a snapshot truncated when the tool cap is reached with a cursor outstanding", async () => {
    const page = (index: number): Response =>
      toolsPage(
        Array.from({ length: 100 }, (_, at) => ({ name: `t${index * 100 + at}` })),
        `cursor-${index + 1}`,
      );
    let call = 0;
    const { probe } = node(discover({}), () => {
      const response = page(call);
      call += 1;
      return response;
    });
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });
    expect(result.probeState).toBe("succeeded");
    expect(result.toolsTruncated).toBe(true);
    // The cap is a bound on what is stored, and the snapshot says so rather than pretending to be
    // the Server's full tool set.
    expect(result.toolsCount).toBeLessThanOrEqual(200);
  });

  it("fails the page when a tool exceeds a documented bound, rather than storing it mangled", async () => {
    const { probe } = node(discover({}), () => toolsPage([{ name: "a".repeat(129), description: "too long a name" }]));
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });
    expect(result.probeState).toBe("failed");
    expect(result.probeError).toContain(MCP_ERROR_CODES.PROBE_FAILED);
  });

  it("fails the page when a tool description exceeds its bound", async () => {
    const { probe } = node(discover({}), () => toolsPage([{ name: "ok", description: "d".repeat(1025) }]));
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });
    expect(result.probeState).toBe("failed");
  });

  it("fails the page when a tool input schema exceeds its bound", async () => {
    const { probe } = node(discover({}), () => toolsPage([{ name: "ok", inputSchema: { payload: "x".repeat(9000) } }]));
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });
    expect(result.probeState).toBe("failed");
  });

  it("parses an SSE discovery response", async () => {
    const { probe } = node(
      {
        status: 200,
        contentType: "text/event-stream",
        raw: 'data: {"jsonrpc":"2.0","id":"1","result":{"capabilities":{"tools":{}}}}\n\n',
      },
      () => toolsPage([{ name: "from-sse" }]),
    );
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });
    expect(result.probeState).toBe("succeeded");
    expect(result.tools.map((tool) => tool.name)).toEqual(["from-sse"]);
  });
});

describe("MCP probe era handling", () => {
  it("uses the modern request model when the Server answers server/discover", async () => {
    let page = 0;
    const { probe } = node(discover({}), () => {
      page += 1;
      return toolsPage([]);
    });
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });
    expect(result.protocolEra).toBe("modern");
    expect(result.protocolVersion).toBe("2026-07-28");
    // Exactly one tools/list request: a cursor-less page ends pagination.
    expect(page).toBe(1);
  });

  it("downgrades to the legacy handshake when a non-modern body answers 404", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method?: string }).method ?? "";
      methods.push(method);
      if (method === "server/discover") return new Response("<html>Not Found</html>", { status: 404 });
      if (method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: "1", result: { protocolVersion: "2025-06-18", capabilities: {} } }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" } },
        );
      }
      if (method === "notifications/initialized") return new Response("", { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { tools: [{ name: "legacy-tool" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const probe = new McpProbe({
      fetcher: new McpOutboundFetcher({ ...PUBLIC_RESOLVE, allowLoopback: false, fetch: fetchImpl }),
    });
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });
    expect(methods).toContain("initialize");
    expect(methods).toContain("notifications/initialized");
    expect(result.probeState).toBe("succeeded");
    expect(result.protocolEra).toBe("legacy");
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.tools.map((tool) => tool.name)).toEqual(["legacy-tool"]);
  });

  /*
   * The regression B7 names. A legacy Server answers `initialize` with a pre-modern version, and
   * every later request must speak that protocol: no `MCP-Protocol-Version` header, no `Mcp-Method`,
   * and no `_meta`. The modern header is what `@modelcontextprotocol/sdk` rejects with
   * `400 Unsupported protocol version`, which broke the legacy path immediately after a successful
   * handshake.
   */
  it("speaks the legacy protocol on every request after the handshake", async () => {
    const legacyCalls: { method: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string; params?: Record<string, unknown> };
      const method = body.method ?? "";
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      if (method !== "server/discover") legacyCalls.push({ method, headers, body: body as Record<string, unknown> });
      if (method === "server/discover") return new Response("<html>Not Found</html>", { status: 404 });
      if (method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: "1", result: { protocolVersion: "2025-06-18", capabilities: {} } }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" } },
        );
      }
      if (method === "notifications/initialized") return new Response("", { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { tools: [{ name: "legacy-tool" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const probe = new McpProbe({
      fetcher: new McpOutboundFetcher({ ...PUBLIC_RESOLVE, allowLoopback: false, fetch: fetchImpl }),
    });
    await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });

    const tools = legacyCalls.filter((call) => call.method === "tools/list");
    expect(tools.length).toBeGreaterThan(0);
    for (const call of tools) {
      expect(call.headers["mcp-protocol-version"]).toBeUndefined();
      expect(call.headers["mcp-method"]).toBeUndefined();
      expect(call.body).not.toHaveProperty("params._meta");
      // The session the handshake returned is carried on the session-scoped call.
      expect(call.headers["mcp-session-id"]).toBe("session-1");
    }
  });

  it("pages the legacy tool list to exhaustion instead of stopping at the first page", async () => {
    const pages = [
      { tools: [{ name: "a" }, { name: "b" }], nextCursor: "page-2" },
      { tools: [{ name: "c" }], nextCursor: "page-3" },
      { tools: [{ name: "d" }] },
    ];
    let page = 0;
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      const method = body.method ?? "";
      if (method === "server/discover") return new Response("<html>Not Found</html>", { status: 404 });
      if (method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: "1", result: { protocolVersion: "2025-06-18", capabilities: {} } }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" } },
        );
      }
      if (method === "notifications/initialized") return new Response("", { status: 202 });
      const next = pages[page] ?? { tools: [] };
      page += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: next }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const probe = new McpProbe({
      fetcher: new McpOutboundFetcher({ ...PUBLIC_RESOLVE, allowLoopback: false, fetch: fetchImpl }),
    });
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });

    // Every page was read and the snapshot is complete, so it is not marked truncated.
    expect(page).toBe(3);
    expect(result.tools.map((tool) => tool.name)).toEqual(["a", "b", "c", "d"]);
    expect(result.toolsTruncated).toBe(false);
  });

  it("retries with an advertised version instead of downgrading when a modern error answers 400", async () => {
    const versions: string[] = [];
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      versions.push(headers.get("mcp-protocol-version") ?? "");
      const method = (JSON.parse(String(init?.body)) as { method?: string }).method ?? "";
      if (method === "server/discover" && versions.length === 1) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            error: { code: -32022, message: "unsupported", data: { supported: ["2025-11-25"] } },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "server/discover") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { capabilities: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { tools: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const probe = new McpProbe({
      fetcher: new McpOutboundFetcher({ ...PUBLIC_RESOLVE, allowLoopback: false, fetch: fetchImpl }),
    });
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });
    expect(versions[0]).toBe("2026-07-28");
    expect(versions[1]).toBe("2025-11-25");
    expect(result.probeState).toBe("succeeded");
    // The retry kept the modern per-request model at the version the peer advertised: no
    // `initialize` handshake was attempted, which is the whole point of inspecting the body first.
    expect(result.protocolVersion).toBe("2025-11-25");
  });

  it("honours a cached legacy era and never sends a modern discovery request", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method?: string }).method ?? "";
      methods.push(method);
      if (method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { protocolVersion: "2025-03-26" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "notifications/initialized") return new Response("", { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { tools: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const probe = new McpProbe({
      fetcher: new McpOutboundFetcher({ ...PUBLIC_RESOLVE, allowLoopback: false, fetch: fetchImpl }),
    });
    await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: "legacy",
      cachedVersion: "2025-03-26",
    });
    expect(methods).not.toContain("server/discover");
    expect(methods[0]).toBe("initialize");
  });

  it("reports an unsupported protocol version as a failure with the era invalidated", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            error: { code: -32022, message: "no", data: { supported: ["2019-01-01"] } },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof globalThis.fetch;
    const probe = new McpProbe({
      fetcher: new McpOutboundFetcher({ ...PUBLIC_RESOLVE, allowLoopback: false, fetch: fetchImpl }),
    });
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: null,
      cachedVersion: null,
    });
    expect(result.probeState).toBe("failed");
    expect(result.eraInvalidated).toBe(true);
  });

  it("does not invalidate a cached era on a plain upstream failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof globalThis.fetch;
    const probe = new McpProbe({
      fetcher: new McpOutboundFetcher({ ...PUBLIC_RESOLVE, allowLoopback: false, fetch: fetchImpl }),
    });
    const result = await probe.probe({
      accountId: ACCOUNT,
      url: ENDPOINT,
      authHeaders: {},
      cachedEra: "modern",
      cachedVersion: "2026-07-28",
    });
    // A 5xx says nothing about the origin's protocol, so a correct cache survives it.
    expect(result.probeState).toBe("failed");
    expect(result.eraInvalidated).toBe(false);
  });
});
