import { describe, expect, it } from "vitest";
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES } from "../../mcp-catalog.gen.js";
import { capabilitiesFromTools, deriveId, nextOrder, scaffoldEntry, slugify } from "../entry.js";
import { classifyChallenge, parseRpcBody, probeMcpEndpoint, safeText } from "../probe.js";
import { anonymousFetch, pagedFetch } from "./support.js";

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
    const failing = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { cursor?: string } };
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: {} } }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (body.method === "tools/list" && body.params?.cursor === undefined) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "a" }], nextCursor: "n" } }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: failing })).toMatchObject({
      ok: true,
      tools: [],
      toolsComplete: false,
    });
  });

  it("retries initialize with an older protocol version after a 400", async () => {
    const versions: string[] = [];
    const picky = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string; params?: { protocolVersion?: string } };
      if (body.method === "initialize") {
        versions.push(body.params?.protocolVersion ?? "");
        if (body.params?.protocolVersion === "2025-11-25") return new Response("bad version", { status: 400 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "p" } } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: picky })).toMatchObject({
      ok: true,
      authKind: "none",
    });
    expect(versions).toEqual(["2025-11-25", "2025-06-18"]);
  });

  it("uses a complete SSE result without waiting for the stream to close", async () => {
    const encoder = new TextEncoder();
    const open = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      if (body.method !== "initialize") return new Response(null, { status: 202 });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"open"}}}\n\n',
            ),
          );
          // Never closed: a server may keep the stream open after answering.
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const result = await probeMcpEndpoint("https://x.test/mcp", { fetch: open, timeoutMs: 2000 });
    expect(result).toMatchObject({ ok: true, authKind: "none", serverInfo: { name: "open" } });
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
        probe: { ...probe, authKind: "oauth", tools: [], toolsComplete: false },
        category,
      },
      MCP_CATALOG_ENTRIES,
      MCP_CATALOG_CATEGORIES,
    );
    expect(scaffold.yaml).toContain("    oauth: {}");
    expect(scaffold.yaml).toContain("    side_effects: write");
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
