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
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    calls,
    logger,
    probe: new McpProbe({
      fetcher: new McpOutboundFetcher({ ...PUBLIC_RESOLVE, allowLoopback: false, fetch: fetchImpl }),
      logger,
    }),
  };
}

/** The one probe request every test here makes; the fixture Server is always public and anonymous. */
function request() {
  return { accountId: ACCOUNT, url: ENDPOINT, authHeaders: {}, cachedEra: null, cachedVersion: null };
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

  it("skips a tool whose name is over its bound and keeps the rest of the page", async () => {
    const { probe, logger } = node(discover({}), () =>
      toolsPage([{ name: "a".repeat(129), description: "too long a name" }, { name: "kept" }]),
    );
    const result = await probe.probe(request());
    expect(result.probeState).toBe("succeeded");
    expect(result.tools.map((tool) => tool.name)).toEqual(["kept"]);
    expect(result.toolsSkipped).toBe(1);
    expect(result.toolsTruncated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT,
        url: ENDPOINT,
        tool: "a".repeat(129),
        reason: "over_bound",
        bound: "MCP_TOOL_NAME_MAX_BYTES",
        limitBytes: 128,
        observedBytes: 129,
      }),
      expect.any(String),
    );
  });

  it("accepts the description that used to fail the probe at the old 1 KiB bound", async () => {
    const { probe, logger } = node(discover({}), () => toolsPage([{ name: "ok", description: "d".repeat(1025) }]));
    const result = await probe.probe(request());
    expect(result.probeState).toBe("succeeded");
    expect(result.tools.map((tool) => tool.name)).toEqual(["ok"]);
    expect(result.toolsTruncated).toBe(false);
    expect(result.toolsSkipped).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("bounds the description in bytes: a multi-byte text just under 16 KiB survives", async () => {
    // "é" is two UTF-8 bytes, so 8191 of them are 16382 bytes — under the bound in bytes and far
    // under it in code units either way; the next case is the one that tells the two apart.
    const description = "é".repeat(8191);
    const { probe } = node(discover({}), () => toolsPage([{ name: "ok", description }]));
    const result = await probe.probe(request());
    expect(result.probeState).toBe("succeeded");
    expect(result.tools[0]?.description).toBe(description);
    expect(result.toolsTruncated).toBe(false);
  });

  it("bounds the description in bytes, not code units: multi-byte text just over 16 KiB is skipped", async () => {
    // 8193 two-byte characters are 16386 bytes: over the 16384-byte bound while only 8193 code
    // units long, which a `.max(16384)` in characters would have let through.
    const description = "é".repeat(8193);
    const { probe, logger } = node(discover({}), () => toolsPage([{ name: "wide", description }, { name: "kept" }]));
    const result = await probe.probe(request());
    expect(result.probeState).toBe("succeeded");
    expect(result.tools.map((tool) => tool.name)).toEqual(["kept"]);
    expect(result.toolsTruncated).toBe(true);
    expect(result.toolsSkipped).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "wide",
        bound: "MCP_TOOL_DESCRIPTION_MAX_BYTES",
        limitBytes: 16 * 1024,
        observedBytes: 16386,
      }),
      expect.any(String),
    );
  });

  it("skips a tool whose input schema serializes to more than 64 KiB", async () => {
    const { probe, logger } = node(discover({}), () =>
      toolsPage([
        { name: "kept", inputSchema: { type: "object" } },
        { name: "huge", inputSchema: { payload: "x".repeat(65_536) } },
      ]),
    );
    const result = await probe.probe(request());
    expect(result.probeState).toBe("succeeded");
    expect(result.tools.map((tool) => tool.name)).toEqual(["kept"]);
    expect(result.toolsTruncated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "huge", bound: "MCP_TOOL_INPUT_SCHEMA_MAX_BYTES", limitBytes: 64 * 1024 }),
      expect.any(String),
    );
    const [bindings] = logger.warn.mock.calls[0] as [{ observedBytes: number }];
    expect(bindings.observedBytes).toBeGreaterThan(64 * 1024);
  });

  it("skips a nameless entry and an entry that is not an object, without a bound to name", async () => {
    const { probe, logger } = node(discover({}), () =>
      toolsPage([{ description: "no name" }, "not a tool", { name: "" }, { name: "kept" }]),
    );
    const result = await probe.probe(request());
    expect(result.probeState).toBe("succeeded");
    expect(result.tools.map((tool) => tool.name)).toEqual(["kept"]);
    expect(result.toolsSkipped).toBe(3);
    expect(result.toolsTruncated).toBe(true);
    const reasons = logger.warn.mock.calls.map((call) => call[0] as { reason: string; tool: unknown });
    expect(reasons).toEqual([
      expect.objectContaining({ reason: "missing_name", tool: null }),
      expect.objectContaining({ reason: "not_an_object", tool: null }),
      expect.objectContaining({ reason: "missing_name", tool: null }),
    ]);
  });

  it("still succeeds, with an empty partial snapshot, when every tool on the page is skipped", async () => {
    const { probe } = node(discover({}), () =>
      toolsPage([{ name: "a".repeat(129) }, { name: "b", description: "d".repeat(16_385) }]),
    );
    const result = await probe.probe(request());
    expect(result.probeState).toBe("succeeded");
    expect(result.probeError).toBeNull();
    expect(result.tools).toEqual([]);
    expect(result.toolsCount).toBe(0);
    expect(result.toolsSkipped).toBe(2);
    expect(result.toolsTruncated).toBe(true);
  });

  it("keeps paging past a skipped tool instead of stopping at that page", async () => {
    let page = 0;
    const { probe } = node(discover({}), () => {
      page += 1;
      return page === 1
        ? toolsPage([{ name: "a".repeat(129) }, { name: "first" }], "cursor-1")
        : toolsPage([{ name: "second" }]);
    });
    const result = await probe.probe(request());
    expect(page).toBe(2);
    expect(result.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(result.toolsTruncated).toBe(true);
    expect(result.toolsSkipped).toBe(1);
  });

  it("counts skipped tools without a logger, so the probe does not depend on one", async () => {
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method?: string }).method ?? "";
      const result = method === "tools/list" ? { tools: [{ name: "a".repeat(129) }, { name: "kept" }] } : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const probe = new McpProbe({
      fetcher: new McpOutboundFetcher({ ...PUBLIC_RESOLVE, allowLoopback: false, fetch: fetchImpl }),
    });
    const result = await probe.probe(request());
    expect(result.tools.map((tool) => tool.name)).toEqual(["kept"]);
    expect(result.toolsSkipped).toBe(1);
  });

  it("still fails the probe when the tools answer is not usable at all", async () => {
    // Skipping is for one bad tool on a usable page. A page that is itself an error — a JSON-RPC
    // error body, a 5xx — is not a partial list, and reporting it as a healthy empty Server would
    // hide a rejected credential or a broken Server behind `succeeded`.
    const answers: Response[] = [
      { status: 200, body: { jsonrpc: "2.0", id: "1", error: { code: -32603, message: "tools broke" } } },
      { status: 500, raw: "boom", contentType: "text/plain" },
    ];
    for (const answer of answers) {
      const { probe, logger } = node(discover({}), () => answer);
      const result = await probe.probe(request());
      expect(result.probeState).toBe("failed");
      expect(result.probeError).not.toBeNull();
      expect(result.tools).toEqual([]);
      expect(result.toolsSkipped).toBe(0);
      expect(logger.warn).not.toHaveBeenCalled();
    }
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
   * every later request must speak that protocol rather than the modern one: no `Mcp-Method`, no
   * `_meta`, and `MCP-Protocol-Version` carrying the *negotiated* version. The modern version is what
   * `@modelcontextprotocol/sdk` rejects with `400 Unsupported protocol version`.
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
      // The negotiated version, not the modern one and not the 2025-03-26 default.
      expect(call.headers["mcp-protocol-version"]).toBe("2025-06-18");
      expect(call.headers["mcp-method"]).toBeUndefined();
      expect(call.body).not.toHaveProperty("params._meta");
      // The session the handshake returned is carried on the session-scoped call.
      expect(call.headers["mcp-session-id"]).toBe("session-1");
    }
  });

  it("omits the version header for the legacy version that predates it", async () => {
    /*
     * `2025-03-26` has no `MCP-Protocol-Version` at all, so sending one would be wrong in the other
     * direction: the header is specified to default to that version when absent.
     */
    const legacyCalls: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method?: string }).method ?? "";
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      if (method === "tools/list") legacyCalls.push(headers);
      if (method === "server/discover") return new Response("<html>Not Found</html>", { status: 404 });
      if (method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: "1", result: { protocolVersion: "2025-03-26", capabilities: {} } }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s" } },
        );
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
      cachedEra: null,
      cachedVersion: null,
    });

    expect(legacyCalls.length).toBeGreaterThan(0);
    for (const headers of legacyCalls) expect(headers["mcp-protocol-version"]).toBeUndefined();
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
