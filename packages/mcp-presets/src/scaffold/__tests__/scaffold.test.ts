import { describe, expect, it } from "vitest";
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES } from "../../mcp-catalog.gen.js";
import { capabilitiesFromTools, deriveId, nextOrder, scaffoldEntry, slugify } from "../entry.js";
import { classifyChallenge, parseRpcBody, probeMcpEndpoint, safeText } from "../probe.js";
import { anonymousFetch, legacyOnly, pagedFetch } from "./support.js";

describe("probeMcpEndpoint", () => {
  it("reads serverInfo and annotated tools from an anonymous endpoint", async () => {
    const calls: string[] = [];
    const result = await probeMcpEndpoint("https://mcp.acme.test/mcp", { fetch: anonymousFetch(calls) });
    expect(result).toMatchObject({ ok: true, authKind: "none", serverInfo: { name: "Acme MCP", version: "2.1" } });
    if (!result.ok) throw new Error("probe failed");
    expect(result.tools).toEqual([
      { name: "search_docs", description: "Search docs.", sideEffect: "none" },
      { name: "delete_doc", sideEffect: "destructive" },
      { name: "edit_doc", sideEffect: "write" },
    ]);
    expect(calls).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("classifies an OAuth challenge and a plain 401", async () => {
    const oauth = (async () =>
      new Response("", {
        status: 401,
        headers: {
          "www-authenticate": 'Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource"',
        },
      })) as unknown as typeof fetch;
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: oauth })).toMatchObject({
      ok: true,
      authKind: "oauth",
    });
    expect(classifyChallenge('Bearer realm="api"').kind).toBe("bearer");
    for (const header of [null, 'Basic realm="admin"', 'Digest realm="x"', ""]) {
      expect(classifyChallenge(header).kind).toBe("unknown");
    }
  });

  it("fails on a non-MCP answer, a network error, and a non-RPC 2xx", async () => {
    const notFound = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: notFound })).toMatchObject({ ok: false });
    const broken = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: broken })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("boom"),
    });
    const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: html })).toMatchObject({ ok: false });
  });

  it("parses an SSE body", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect(parseRpcBody("text/event-stream", body, 1)?.result).toEqual({ ok: true });
    expect(parseRpcBody("text/event-stream", body, 2)).toBeUndefined();
    expect(parseRpcBody("text/event-stream", "data: nope\n", 1)).toBeUndefined();
    const split = 'data: {"jsonrpc":"2.0",\r\ndata: "id":4,"result":{}}\r\n\r\n';
    expect(parseRpcBody("text/event-stream", split, 4)?.result).toEqual({});
    expect(parseRpcBody("text/event-stream", 'data: {"id":5,"result":{}}', 5, false)).toBeUndefined();
    expect(parseRpcBody("application/json", '[{"id":3,"result":{}}]', 3)).toBeDefined();
  });
});

describe("probe transport", () => {
  it("pages tools/list to exhaustion so a later destructive tool raises the risk", async () => {
    const headers: Array<Record<string, string>> = [];
    const result = await probeMcpEndpoint("https://x.test/mcp", { fetch: pagedFetch(headers) });
    if (!result.ok) throw new Error("probe failed");
    expect(result.toolsComplete).toBe(true);
    expect(result.tools.map((tool) => tool.name)).toEqual(["read_one", "drop_all"]);
    expect(headers.some((header) => header["mcp-protocol-version"] === "2025-06-18")).toBe(true);
  });

  it("fails closed when a continuation page fails or a tool is malformed", async () => {
    const failing = legacyOnly((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { cursor?: string } };
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: {} } }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (body.method === "tools/list" && body.params?.cursor === undefined) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "a" }], nextCursor: "n" } }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch);
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: failing })).toMatchObject({
      ok: true,
      tools: [],
      toolsComplete: false,
    });
  });

  it("retries initialize with an older protocol version after a 400", async () => {
    const versions: string[] = [];
    const picky = legacyOnly((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string; params?: { protocolVersion?: string } };
      if (body.method === "initialize") {
        versions.push(body.params?.protocolVersion ?? "");
        if (body.params?.protocolVersion === "2025-11-25") return new Response("bad version", { status: 400 });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-06-18", serverInfo: { name: "p" } },
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch);
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: picky })).toMatchObject({
      ok: true,
      authKind: "none",
    });
    expect(versions).toEqual(["2025-11-25", "2025-06-18"]);
  });

  it("uses a complete SSE result without waiting for the stream to close", async () => {
    const encoder = new TextEncoder();
    const open = legacyOnly((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      if (body.method !== "initialize") return new Response(null, { status: 202 });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"open"}}}\n\n',
            ),
          );
          // Never closed: a server may keep the stream open after answering.
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch);
    const result = await probeMcpEndpoint("https://x.test/mcp", { fetch: open, timeoutMs: 2000 });
    expect(result).toMatchObject({ ok: true, authKind: "none", serverInfo: { name: "open" } });
  });
});

describe("protocol eras", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /** A conforming modern peer: no `initialize`, `server/discover` plus stateless `tools/list`. */
  function modernPeer(
    seen: Array<{ method: string; headers: Record<string, string>; meta: unknown }> = [],
  ): typeof fetch {
    return (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string; params?: { _meta?: unknown } };
      seen.push({ method: body.method, headers: init.headers as Record<string, string>, meta: body.params?._meta });
      if (body.method === "server/discover") {
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: { serverInfo: { name: "Modern" }, supportedVersions: ["2026-07-28"] },
        });
      }
      if (body.method === "tools/list") {
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "ping", annotations: { readOnlyHint: true } }], nextCursor: null },
        });
      }
      return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nf" } }, 404);
    }) as unknown as typeof fetch;
  }

  it("probes a modern-only peer with server/discover and per-request metadata", async () => {
    const seen: Array<{ method: string; headers: Record<string, string>; meta: unknown }> = [];
    const result = await probeMcpEndpoint("https://x.test/mcp", { fetch: modernPeer(seen) });
    expect(result).toMatchObject({
      ok: true,
      authKind: "none",
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      toolsComplete: true,
    });
    expect(seen.map((call) => call.method)).toEqual(["server/discover", "tools/list"]);
    expect(seen[0]?.headers).toMatchObject({ "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" });
    expect(seen[0]?.meta).toMatchObject({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" });
  });

  it("falls back to initialize when the 404 body is not a modern error", async () => {
    const result = await probeMcpEndpoint("https://x.test/mcp", { fetch: anonymousFetch() });
    expect(result).toMatchObject({ ok: true, protocolEra: "legacy" });
  });

  it("retries with an advertised version and never downgrades on a modern error", async () => {
    const versions: string[] = [];
    const strict = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string };
      const version = (init.headers as Record<string, string>)["mcp-protocol-version"] ?? "";
      versions.push(`${body.method}@${version}`);
      if (version === "2026-07-28") {
        return json(
          {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32022, message: "version", data: { supported: ["2025-11-25"] } },
          },
          400,
        );
      }
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "tools/list" ? { tools: [] } : { serverInfo: { name: "S" } },
      });
    }) as unknown as typeof fetch;
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: strict })).toMatchObject({
      ok: true,
      authKind: "none",
    });
    expect(versions).toEqual(["server/discover@2026-07-28", "server/discover@2025-11-25", "tools/list@2025-11-25"]);

    const rejecting = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string };
      versions.push(body.method);
      return json({ jsonrpc: "2.0", id: body.id, error: { code: -32020, message: "mismatch" } }, 400);
    }) as unknown as typeof fetch;
    versions.length = 0;
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: rejecting })).toMatchObject({ ok: false });
    expect(versions).toEqual(["server/discover"]);
  });

  it("does not downgrade after a 2xx JSON-RPC error or a malformed 2xx", async () => {
    const methods: string[] = [];
    const twoXxError = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string };
      methods.push(body.method);
      return json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32022, message: "v", data: { supported: ["2025-11-25"] } },
      });
    }) as unknown as typeof fetch;
    // The advertised version is legacy, so the single retry stays on server/discover and fails.
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: twoXxError })).toMatchObject({ ok: false });
    expect(methods).not.toContain("initialize");
    methods.length = 0;
    const malformed = (async (_url: string, init: RequestInit) => {
      methods.push((JSON.parse(String(init.body)) as { method: string }).method);
      return json({ nope: true });
    }) as unknown as typeof fetch;
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: malformed })).toMatchObject({ ok: false });
    expect(methods).toEqual(["server/discover"]);
  });

  it("keeps a negotiated 2025-03-26 session free of the version header", async () => {
    const seen: Array<{ method: string; headers: Record<string, string> }> = [];
    const strict = legacyOnly((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id?: number; method: string };
      seen.push({ method: body.method, headers: init.headers as Record<string, string> });
      if (body.method === "initialize")
        return json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "Old" } } });
      if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch);
    const result = await probeMcpEndpoint("https://x.test/mcp", { fetch: strict });
    expect(result).toMatchObject({ ok: true, protocolEra: "legacy", protocolVersion: "2025-03-26" });
    for (const call of seen.filter((entry) => entry.method !== "initialize")) {
      expect(call.headers["mcp-protocol-version"]).toBeUndefined();
    }
  });

  it("fails when the legacy server negotiates a version this probe does not speak", async () => {
    const odd = legacyOnly((async () =>
      json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } })) as unknown as typeof fetch);
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: odd })).toMatchObject({ ok: false });
  });

  it("reads a modern error from a 400 SSE body, finite or open, before deciding to downgrade", async () => {
    const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32022, message: "v", data: { supported: ["2025-11-25"] } } })}\n\n`;
    for (const open of [false, true]) {
      const methods: string[] = [];
      const peer = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { id: number; method: string };
        const version = (init.headers as Record<string, string>)["mcp-protocol-version"];
        methods.push(`${body.method}@${version ?? ""}`);
        if (version === "2026-07-28") {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(event));
              if (!open) controller.close();
            },
          });
          return new Response(stream, { status: 400, headers: { "content-type": "text/event-stream" } });
        }
        return json({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list" ? { tools: [] } : {} });
      }) as unknown as typeof fetch;
      const result = await probeMcpEndpoint("https://x.test/mcp", { fetch: peer, timeoutMs: 2000 });
      expect(result).toMatchObject({ ok: true, protocolEra: "legacy" });
      expect(methods).toEqual(["server/discover@2026-07-28", "server/discover@2025-11-25", "tools/list@2025-11-25"]);
    }
  });

  it("assembles a multiline SSE event on an open stream for discover, initialize, and tools/list", async () => {
    const encoder = new TextEncoder();
    // One event, one `data:` line per line of pretty-printed JSON: valid only once the lines are joined.
    const sse = (message: object) =>
      `event: message\n${JSON.stringify(message, null, 2)
        .split("\n")
        .map((line) => `data: ${line}`)
        .join("\n")}\n\n`;
    const openStream = (message: object) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sse(message)));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const peer = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string };
      if (body.method === "server/discover") {
        return openStream({
          jsonrpc: "2.0",
          id: body.id,
          result: { _meta: { "io.modelcontextprotocol/serverInfo": { name: "Multi" } } },
        });
      }
      return openStream({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "read", annotations: { readOnlyHint: true } }] },
      });
    }) as unknown as typeof fetch;
    const result = await probeMcpEndpoint("https://x.test/mcp", { fetch: peer, timeoutMs: 2000 });
    expect(result).toMatchObject({
      ok: true,
      protocolEra: "modern",
      toolsComplete: true,
      serverInfo: { name: "Multi" },
    });
    if (result.ok) expect(result.tools.map((tool) => tool.name)).toEqual(["read"]);

    const legacy = legacyOnly((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (body.method === "initialize")
        return openStream({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "L" } },
        });
      if (body.method === "tools/list") return openStream({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch);
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: legacy, timeoutMs: 2000 })).toMatchObject({
      ok: true,
      protocolEra: "legacy",
      toolsComplete: true,
    });
  });

  it("recognizes a modern error split across data lines in a 400 SSE body", async () => {
    const lines = JSON.stringify(
      { jsonrpc: "2.0", id: 1, error: { code: -32022, message: "v", data: { supported: ["2025-11-25"] } } },
      null,
      2,
    ).split("\n");
    const methods: string[] = [];
    const peer = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string };
      const version = (init.headers as Record<string, string>)["mcp-protocol-version"];
      methods.push(`${body.method}@${version ?? ""}`);
      if (version === "2026-07-28") {
        const frame = `event: message\r\n${lines.map((line) => `data: ${line}`).join("\r\n")}\r\n\r\n`;
        return new Response(frame, { status: 400, headers: { "content-type": "text/event-stream" } });
      }
      return json({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list" ? { tools: [] } : {} });
    }) as unknown as typeof fetch;
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: peer })).toMatchObject({ ok: true });
    expect(methods).toEqual(["server/discover@2026-07-28", "server/discover@2025-11-25", "tools/list@2025-11-25"]);
  });

  it("treats a numeric or empty nextCursor as an incomplete inventory and null as absent", async () => {
    const withCursor = (cursor: unknown) =>
      (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { id: number; method: string };
        if (body.method === "server/discover")
          return json({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "C" } } });
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "r", annotations: { readOnlyHint: true } }], nextCursor: cursor },
        });
      }) as unknown as typeof fetch;
    for (const cursor of [123, ""]) {
      expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: withCursor(cursor) })).toMatchObject({
        ok: true,
        tools: [],
        toolsComplete: false,
      });
    }
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: withCursor(null) })).toMatchObject({
      toolsComplete: true,
    });
  });
});

describe("safeText", () => {
  it("renders untrusted text as one bounded JSON-escaped line", () => {
    expect(safeText("a\n- id: evil\r\u2028x")).toBe('"a - id: evil x"');
    expect(safeText("x".repeat(500)).length).toBeLessThan(200);
  });
});

describe("scaffoldEntry", () => {
  const probe = {
    ok: true as const,
    authKind: "none" as const,
    evidence: "initialize answered anonymously",
    toolsComplete: true,
    toolsAttempted: true,
    tools: [
      { name: "search_docs", sideEffect: "none" as const },
      { name: "delete_doc", sideEffect: "destructive" as const },
    ],
    serverInfo: { name: "Acme MCP Server", title: "Acme" },
  };
  const category = MCP_CATALOG_CATEGORIES[0]?.id ?? "";

  it("derives slugs, capabilities and the next order", () => {
    expect(slugify("Acme  MCP!")).toBe("acme-mcp");
    expect(deriveId("https://mcp.acme.test/mcp", "Acme MCP Server")).toBe("acme");
    expect(deriveId("https://mcp.acme.test/mcp", undefined)).toBe("acme");
    expect(capabilitiesFromTools(["search_docs", "search.docs", "Get-Page"])).toEqual(["search-docs", "get-page"]);
    expect(nextOrder([], "x")).toBe(10);
  });

  it("emits a registry-style YAML entry with risk derived from the tools", () => {
    const scaffold = scaffoldEntry(
      { url: "https://mcp.acme.test/mcp", probe, category, homepage: "https://acme.test" },
      MCP_CATALOG_ENTRIES,
      MCP_CATALOG_CATEGORIES,
    );
    expect(scaffold.id).toBe("acme");
    expect(scaffold.yaml).toContain("  id: mcp/acme");
    expect(scaffold.yaml).toContain("    default_kind: none");
    expect(scaffold.yaml).toContain("    icon_is_official: false");
    expect(scaffold.yaml).toContain("    side_effects: destructive");
    expect(scaffold.yaml).toContain("    data_access: public");
    expect(scaffold.yaml).toContain('capabilities: ["search-docs", "delete-doc"]');
    expect(scaffold.yaml).toContain(`    order: ${nextOrder(MCP_CATALOG_ENTRIES, category)}`);
    expect(scaffold.todos.some((todo) => todo.startsWith("icon:"))).toBe(true);
  });

  it("adds an oauth block and conservative risk when nothing was readable", () => {
    const scaffold = scaffoldEntry(
      {
        url: "https://mcp.acme.test/mcp",
        probe: { ...probe, authKind: "oauth", tools: [], toolsComplete: false, toolsAttempted: false },
        category,
      },
      MCP_CATALOG_ENTRIES,
      MCP_CATALOG_CATEGORIES,
    );
    expect(scaffold.yaml).toContain("    oauth: {}");
    expect(scaffold.yaml).toContain("    side_effects: destructive");
    expect(scaffold.yaml).toContain("    data_access: private");
    expect(scaffold.yaml).toContain('capabilities: ["use-acme"]');
  });

  it("rejects a duplicate slug or endpoint, a bad id, and an unknown category", () => {
    const existing = MCP_CATALOG_ENTRIES[0];
    if (existing?.url === undefined) throw new Error("catalog has no installable entry");
    const run = (input: object) =>
      scaffoldEntry(
        { url: "https://mcp.acme.test/mcp", probe, category, ...input },
        MCP_CATALOG_ENTRIES,
        MCP_CATALOG_CATEGORIES,
      );
    expect(() => run({ id: existing.id })).toThrow(/already has an entry/);
    expect(() => run({ url: existing.url, id: "other" })).toThrow(/already lists/);
    expect(() => run({ id: "Bad_ID" })).toThrow(/must match/);
    expect(() => run({ category: "nope" })).toThrow(/--category/);
  });
  it("treats a path-less URL as the same endpoint as its normalized form", () => {
    const existing = MCP_CATALOG_ENTRIES.find(
      (entry) => entry.url !== undefined && new URL(entry.url).pathname === "/",
    );
    if (existing?.url === undefined) return; // The committed catalog has no path-less endpoint.
    const bare = existing.url.replace(/\/$/, "");
    expect(() =>
      scaffoldEntry({ url: bare, probe, id: "other", category }, MCP_CATALOG_ENTRIES, MCP_CATALOG_CATEGORIES),
    ).toThrow(/already lists/);
  });

  it("matches a path-less URL against a differently written catalog URL", () => {
    const fake = {
      ...(MCP_CATALOG_ENTRIES[0] as object),
      id: "fake",
      url: "https://mcp.fake.test",
    } as (typeof MCP_CATALOG_ENTRIES)[number];
    expect(() =>
      scaffoldEntry({ url: "https://mcp.fake.test/", probe, id: "other", category }, [fake], MCP_CATALOG_CATEGORIES),
    ).toThrow(/already lists/);
  });

  it("requires an explicit method when the challenge proves none", () => {
    const unknown = {
      ...probe,
      authKind: "unknown" as const,
      evidence: "401 without a Bearer challenge",
      tools: [],
      toolsComplete: false,
    };
    expect(() =>
      scaffoldEntry(
        { url: "https://mcp.acme.test/mcp", probe: unknown, category },
        MCP_CATALOG_ENTRIES,
        MCP_CATALOG_CATEGORIES,
      ),
    ).toThrow(/--auth/);
    const forced = scaffoldEntry(
      { url: "https://mcp.acme.test/mcp", probe: unknown, category, authKind: "bearer" },
      MCP_CATALOG_ENTRIES,
      MCP_CATALOG_CATEGORIES,
    );
    expect(forced.yaml).toContain("default_kind: bearer");
  });

  it("keeps remote strings out of live YAML", () => {
    const hostile = { ...probe, evidence: "ok", serverInfo: { name: "x\n- id: mcp/evil", version: "1\n# y" } };
    const { yaml } = scaffoldEntry(
      { url: "https://mcp.acme.test/mcp", probe: hostile, category, id: "acme" },
      MCP_CATALOG_ENTRIES,
      MCP_CATALOG_CATEGORIES,
    );
    expect(yaml.split("\n").filter((line) => line.startsWith("- id:"))).toEqual([]);
    expect(yaml.match(/^ {2}id: /gm)?.length).toBe(1);
    expect(yaml).toContain('- name: "search_docs"');
  });

  it("bounds the slug so mcp/<slug> fits the 64-character registry id", () => {
    const long = "a".repeat(60);
    const ok = scaffoldEntry(
      { url: "https://mcp.acme.test/mcp", probe, category, id: long },
      MCP_CATALOG_ENTRIES,
      MCP_CATALOG_CATEGORIES,
    );
    expect(`mcp/${ok.id}`.length).toBe(64);
    expect(() =>
      scaffoldEntry(
        { url: "https://mcp.acme.test/mcp", probe, category, id: "a".repeat(61) },
        MCP_CATALOG_ENTRIES,
        MCP_CATALOG_CATEGORIES,
      ),
    ).toThrow(/at most 60/);
    expect(deriveId("https://mcp.acme.test/mcp", "b".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});
