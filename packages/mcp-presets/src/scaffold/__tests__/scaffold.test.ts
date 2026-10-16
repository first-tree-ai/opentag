import { describe, expect, it } from "vitest";
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES } from "../../mcp-catalog.gen.js";
import { capabilitiesFromTools, deriveId, nextOrder, scaffoldEntry, slugify } from "../entry.js";
import { classifyChallenge, parseRpcBody, probeMcpEndpoint } from "../probe.js";
import { anonymousFetch } from "./support.js";

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
    expect(classifyChallenge(null).kind).toBe("bearer");
    expect(classifyChallenge('Bearer realm="api"').kind).toBe("bearer");
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
    expect(parseRpcBody("text/event-stream", body)?.result).toEqual({ ok: true });
    expect(parseRpcBody("text/event-stream", "data: nope\n")).toBeUndefined();
  });
});

describe("scaffoldEntry", () => {
  const probe = {
    ok: true as const,
    authKind: "none" as const,
    evidence: "initialize answered anonymously",
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
      { url: "https://mcp.acme.test/mcp", probe: { ...probe, authKind: "oauth", tools: [] }, category },
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
});
