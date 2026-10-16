import { describe, expect, it } from "vitest";
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES } from "../../mcp-catalog.gen.js";
import { deriveId, nextOrder, scaffoldEntry, slugify } from "../entry.js";
import { classifyChallenge, parseRpcBody, probeMcpEndpoint } from "../probe.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("probeMcpEndpoint", () => {
  it("reads serverInfo and tools from an anonymous endpoint", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      calls.push(body.method);
      if (body.method === "initialize") {
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-06-18", serverInfo: { name: "Acme MCP", version: "2.1" } },
          },
          { headers: { "mcp-session-id": "s1" } },
        );
      }
      if (body.method === "tools/list") {
        return jsonResponse({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search" }, { name: "get" }] } });
      }
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const result = await probeMcpEndpoint("https://mcp.acme.test/mcp", { fetch: fakeFetch });
    expect(result).toMatchObject({ ok: true, authKind: "none", toolNames: ["search", "get"] });
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
  });

  it("fails on a non-MCP answer", async () => {
    const notFound = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await probeMcpEndpoint("https://x.test/mcp", { fetch: notFound })).toMatchObject({ ok: false });
  });

  it("parses an SSE body", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect(parseRpcBody("text/event-stream", body)?.result).toEqual({ ok: true });
  });
});

describe("scaffoldEntry", () => {
  const probe = {
    ok: true as const,
    authKind: "oauth" as const,
    evidence: "401 with an OAuth challenge",
    toolNames: [],
    serverInfo: { name: "Acme MCP Server", title: "Acme" },
  };

  it("derives ids and slugs", () => {
    expect(slugify("Acme  MCP!")).toBe("acme-mcp");
    expect(deriveId("https://mcp.acme.test/mcp", "Acme MCP Server")).toBe("acme");
    expect(deriveId("https://mcp.acme.test/mcp", undefined)).toBe("acme");
  });

  it("emits a YAML entry that follows the catalog rules", () => {
    const category = MCP_CATALOG_CATEGORIES[0]?.id ?? "";
    const scaffold = scaffoldEntry(
      { url: "https://mcp.acme.test/mcp", probe, category, website: "https://acme.test" },
      MCP_CATALOG_ENTRIES,
      MCP_CATALOG_CATEGORIES,
    );
    expect(scaffold.id).toBe("acme");
    expect(scaffold.yaml).toContain("- id: acme");
    expect(scaffold.yaml).toContain("defaultAuthKind: oauth");
    expect(scaffold.yaml).toContain(`order: ${nextOrder(MCP_CATALOG_ENTRIES, category)}`);
    expect(scaffold.todos.some((todo) => todo.startsWith("icon:"))).toBe(true);
  });

  it("rejects a duplicate endpoint and an unknown category", () => {
    const existing = MCP_CATALOG_ENTRIES[0];
    if (existing === undefined) throw new Error("catalog is empty");
    expect(() =>
      scaffoldEntry(
        { url: existing.url, probe, id: "other", category: existing.category },
        MCP_CATALOG_ENTRIES,
        MCP_CATALOG_CATEGORIES,
      ),
    ).toThrow(/already lists/);
    expect(() =>
      scaffoldEntry(
        { url: "https://mcp.acme.test/mcp", probe, category: "nope" },
        MCP_CATALOG_ENTRIES,
        MCP_CATALOG_CATEGORIES,
      ),
    ).toThrow(/--category/);
  });
});
