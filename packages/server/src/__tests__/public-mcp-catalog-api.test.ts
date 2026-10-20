import { MCP_CATALOG_ENTRIES, type McpCatalogEntry } from "@opentag/mcp-presets";
import {
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_MODERN_PROTOCOL_VERSION,
  PUBLIC_MCP_CATALOG_PATH,
  PUBLIC_MCP_CATALOG_REQUEST_MAX_BYTES,
} from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RouteRateLimiter } from "../api/browser-auth.js";
import { createApp } from "../app.js";
import { MCP_META_SERVER_INFO } from "../services/mcp/mcp-transport.js";
import { projectCatalogEntry } from "../services/mcp-catalog/public-catalog-mcp.js";

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function catalogApp(options: Parameters<typeof createApp>[0] = {}) {
  const app = createApp(options);
  apps.push(app);
  return app;
}

const newApp = () => catalogApp();

async function rpc(instance: ReturnType<typeof createApp>, body: unknown) {
  return instance.inject({
    method: "POST",
    url: PUBLIC_MCP_CATALOG_PATH,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

async function call(instance: ReturnType<typeof createApp>, name: string, args?: Record<string, unknown>) {
  const response = await rpc(instance, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, ...(args === undefined ? {} : { arguments: args }) },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { result?: { content: { text: string }[]; isError?: boolean } };
}

/** The single text block every tool answers with, parsed. */
function payloadOf(body: { result?: { content: { text: string }[]; isError?: boolean } }) {
  return JSON.parse(body.result?.content[0]?.text ?? "null") as Record<string, unknown>;
}

describe("public catalog MCP endpoint: handshake", () => {
  /* Without an Authorization header: the whole point of this endpoint is that there is none. */
  it("answers initialize anonymously with this endpoint's identity", async () => {
    const response = await rpc(newApp(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const result = response.json().result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.serverInfo).toEqual({ name: "opentag-catalog", title: "openTag MCP Catalog", version: "1" });
    const instructions = result.instructions as string;
    expect(instructions.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(instructions, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(instructions).toContain("search_mcp_servers");
  });

  it("never answers the modern revision through the legacy handshake", async () => {
    const response = await rpc(newApp(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: MCP_MODERN_PROTOCOL_VERSION },
    });
    expect(response.json().result.protocolVersion).toBe(MCP_LEGACY_PROTOCOL_VERSIONS[0]);
  });

  it("falls back to the newest supported legacy version for a version it does not speak", async () => {
    const response = await rpc(newApp(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(response.json().result.protocolVersion).toBe(MCP_LEGACY_PROTOCOL_VERSIONS[0]);
  });

  /*
   * The modern revision needs `resultType`, per-request version metadata, and mirrored HTTP headers.
   * This endpoint implements none of them, so it must not list the revision: a negotiating client
   * then falls back to `initialize`, which it does implement.
   */
  it("advertises only the revisions it implements", async () => {
    const response = await rpc(newApp(), { jsonrpc: "2.0", id: 1, method: "server/discover" });
    const result = response.json().result as Record<string, unknown>;
    expect(result.supportedVersions).toEqual([...MCP_LEGACY_PROTOCOL_VERSIONS]);
    expect(result.supportedVersions).not.toContain(MCP_MODERN_PROTOCOL_VERSION);
    expect(result.protocolVersion).toBe(MCP_LEGACY_PROTOCOL_VERSIONS[0]);
    expect((result._meta as Record<string, unknown>)[MCP_META_SERVER_INFO]).toEqual({
      name: "opentag-catalog",
      title: "openTag MCP Catalog",
      version: "1",
    });
  });

  it("acknowledges a notification with no body", async () => {
    const response = await rpc(newApp(), { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe("");
  });

  it("answers an unknown method with a JSON-RPC method-not-found", async () => {
    const response = await rpc(newApp(), { jsonrpc: "2.0", id: 1, method: "prompts/list" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe(-32601);
  });

  it("rejects a non-JSON-RPC body", async () => {
    const response = await rpc(newApp(), { method: "ping" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe(-32600);
  });

  it("refuses GET and DELETE with the method list", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const response = await newApp().inject({ method, url: PUBLIC_MCP_CATALOG_PATH });
      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
      expect(response.json().error.code).toBe(-32600);
    }
  });

  it("answers a JSON-RPC envelope when the body exceeds the bound", async () => {
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_mcp_servers", arguments: { query: "x".repeat(PUBLIC_MCP_CATALOG_REQUEST_MAX_BYTES) } },
    });
    const response = await rpc(newApp(), oversized);
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe(-32700);
  });
});

describe("public catalog MCP endpoint: tools", () => {
  it("publishes the three catalog tools with closed input schemas", async () => {
    const response = await rpc(newApp(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = response.json().result.tools as { name: string; description: string; inputSchema: unknown }[];
    expect(tools.map((tool) => tool.name)).toEqual(["search_mcp_servers", "get_mcp_server", "list_mcp_categories"]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("searches by a query that mixes Latin and Chinese", async () => {
    const payload = payloadOf(await call(newApp(), "search_mcp_servers", { query: "notion笔记", limit: 50 }));
    const results = payload.results as Record<string, unknown>[];
    expect(results[0]?.id).toBe("notion");
  });

  it("searches by name and returns a pasteable configuration", async () => {
    const body = await call(newApp(), "search_mcp_servers", { query: "notion" });
    const payload = payloadOf(body);
    expect(payload.total).toBeGreaterThan(0);
    const results = payload.results as Record<string, unknown>[];
    const notion = results.find((entry) => entry.id === "notion");
    expect(notion).toBeDefined();
    expect(notion?.installable).toBe(true);
    expect(notion?.url).toBe("https://mcp.notion.com/mcp");
    expect(notion?.config).toEqual({
      mcpServers: { notion: { type: "http", url: "https://mcp.notion.com/mcp" } },
    });
    expect(notion?.installCommand).toBe("claude mcp add --transport http notion https://mcp.notion.com/mcp");
    /* Copy is localized; `en` is the default. */
    expect(notion?.title).toBe("Notion");
  });

  it("lists the whole active catalog for an empty query and localizes for zh", async () => {
    const payload = payloadOf(await call(newApp(), "search_mcp_servers", { query: "", locale: "zh", limit: 50 }));
    const active = MCP_CATALOG_ENTRIES.filter((entry) => entry.status === "active");
    expect(payload.total).toBe(active.length);
    const results = payload.results as Record<string, unknown>[];
    expect(results).toHaveLength(active.length);
    expect(results.find((entry) => entry.id === "notion")?.title).toBe("Notion");
    expect(results.find((entry) => entry.id === "notion")?.whenToUse).toContain("Notion");
  });

  it("filters by category", async () => {
    const payload = payloadOf(await call(newApp(), "search_mcp_servers", { category: "docs", limit: 50 }));
    const results = payload.results as Record<string, unknown>[];
    expect(results.length).toBeGreaterThan(0);
    for (const entry of results) expect(entry.category).toBe("docs");
  });

  it("clamps an oversized limit instead of refusing it", async () => {
    const payload = payloadOf(await call(newApp(), "search_mcp_servers", { limit: 999 }));
    const results = payload.results as Record<string, unknown>[];
    expect(results.length).toBe(Math.min(50, Number(payload.total)));
  });

  /*
   * Pasting the command must work. A catalog URL may carry a query string, and an unquoted `?` is a
   * glob in zsh, so the URL is quoted whenever it is not a bare path.
   */
  it("quotes a generated command whose URL carries a query", async () => {
    for (const id of ["atlassian", "exa"]) {
      const payload = payloadOf(await call(newApp(), "get_mcp_server", { id }));
      const url = payload.url as string;
      expect(url).toContain("?");
      expect(payload.installCommand).toBe(`claude mcp add --transport http ${payload.name} '${url}'`);
    }
  });

  /* An empty `authScheme` means "send the key with no prefix"; dropping it would hide that. */
  it("keeps a key-auth scheme that is deliberately empty", async () => {
    const payload = payloadOf(await call(newApp(), "get_mcp_server", { id: "exa" }));
    expect(payload.keyAuth).toEqual({ url: "https://mcp.exa.ai/mcp", authHeader: "x-api-key", authScheme: "" });
  });

  it("reads one Server by either identifier form, with its detail fields", async () => {
    for (const id of ["notion", "mcp/notion"]) {
      const payload = payloadOf(await call(newApp(), "get_mcp_server", { id }));
      expect(payload.id).toBe("notion");
      expect(payload.auth).toEqual({ methods: ["oauth"], defaultKind: "oauth" });
      expect(payload.remotes).toEqual([{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }]);
    }
  });

  it("answers an unknown Server as a JSON tool error, not a transport error", async () => {
    const response = await rpc(newApp(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_mcp_server", arguments: { id: "not-a-server" } },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json().result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0]?.text ?? "null") as { error: { code: string; id: string } };
    expect(error.error.code).toBe("unknown_server");
    expect(error.error.id).toBe("not-a-server");
  });

  it("answers a missing required argument as a JSON tool error", async () => {
    const body = await call(newApp(), "get_mcp_server", {});
    expect(body.result?.isError).toBe(true);
    const error = JSON.parse(body.result?.content[0]?.text ?? "null") as {
      error: { code: string; issues: { path: string }[] };
    };
    expect(error.error.code).toBe("invalid_arguments");
    expect(error.error.issues.map((issue) => issue.path)).toContain("id");
  });

  /*
   * A tool name that collides with `Object.prototype` must be refused like any other unknown tool:
   * an object-keyed table would have invoked `constructor` or `toString` and answered 200.
   */
  it("refuses a tool name inherited from Object.prototype", async () => {
    for (const name of ["constructor", "toString", "__defineGetter__", "hasOwnProperty"]) {
      const response = await rpc(newApp(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } });
      expect(response.statusCode, name).toBe(200);
      const result = response.json().result as { isError?: boolean; content: { text: string }[] };
      expect(result.isError, name).toBe(true);
      const error = JSON.parse(result.content[0]?.text ?? "null") as { error: { code: string } };
      expect(error.error.code, name).toBe("unknown_tool");
    }
  });

  /* The same collision on the method table: an inherited name is a transport-level unknown method. */
  it("refuses a JSON-RPC method inherited from Object.prototype", async () => {
    for (const method of ["constructor", "toString", "__defineGetter__", "hasOwnProperty"]) {
      const response = await rpc(newApp(), { jsonrpc: "2.0", id: 1, method });
      expect(response.statusCode, method).toBe(404);
      expect(response.json().error.code, method).toBe(-32601);
    }
  });

  it("answers an unknown tool as a JSON tool error", async () => {
    const body = await call(newApp(), "delete_everything");
    expect(body.result?.isError).toBe(true);
    const error = JSON.parse(body.result?.content[0]?.text ?? "null") as {
      error: { code: string; availableTools: string[] };
    };
    expect(error.error.code).toBe("unknown_tool");
    expect(error.error.availableTools).toContain("search_mcp_servers");
  });

  it("rejects a tools/call without a tool name", async () => {
    const response = await rpc(newApp(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    expect(response.json().error.code).toBe(-32602);
  });

  it("lists categories with counts that match the catalog", async () => {
    const payload = payloadOf(await call(newApp(), "list_mcp_categories"));
    const categories = payload.categories as Record<string, unknown>[];
    expect(categories.length).toBeGreaterThan(0);
    for (const category of categories) {
      expect(category.activeCount).toBe(
        MCP_CATALOG_ENTRIES.filter((entry) => entry.category === category.id && entry.status === "active").length,
      );
    }
  });
});

/*
 * The config a caller pastes must work. This walks the whole shipped catalog rather than the fields
 * one entry happens to have: the day an entry gains a static header or a flat auth header, this fails
 * instead of serving a config that silently omits it.
 */
/** The shell-safe form a generated command must use: a URL with a query cannot be left bare. */
function shellSafe(value: string): string {
  return /^[A-Za-z0-9._:/@%+=-]+$/.test(value) ? value : `'${value}'`;
}

/** One installable entry's connection fields, as a client pasting its config would receive them. */
function expectProjectedConnectionFields(entry: McpCatalogEntry): void {
  const projected = projectCatalogEntry(entry, "en");
  const config = projected.config as { mcpServers: Record<string, Record<string, unknown>> } | null;
  const server = config?.mcpServers[entry.name] as Record<string, unknown>;
  expect(projected.installable).toBe(true);
  expect(projected.url).toBe(entry.url);
  expect(projected.installCommand).toBe(`claude mcp add --transport http ${entry.name} ${shellSafe(entry.url ?? "")}`);
  expect(server.type).toBe("http");
  expect(server.url).toBe(entry.url);
  expect(server.headers).toEqual(entry.extraHeaders);
  expect(projected.authHeader).toEqual(entry.authHeader);
  expect(projected.authScheme).toEqual(entry.authScheme);
  expect(projected.keyAuth).toEqual(
    entry.keyAuth === undefined
      ? undefined
      : {
          url: entry.keyAuth.url,
          ...(entry.keyAuth.authHeader === undefined ? {} : { authHeader: entry.keyAuth.authHeader }),
          ...(entry.keyAuth.authScheme === undefined ? {} : { authScheme: entry.keyAuth.authScheme }),
        },
  );
}

/*
 * The config a caller pastes must work. This walks the whole shipped catalog rather than the fields
 * one entry happens to have: the day an entry gains a static header or a flat auth header, this fails
 * instead of serving a config that silently omits it.
 */
describe("public catalog MCP endpoint: connection fields", () => {
  it("projects every connection field the catalog carries", () => {
    for (const entry of MCP_CATALOG_ENTRIES.filter((candidate) => candidate.status === "active")) {
      if (entry.installable && typeof entry.url === "string") {
        expectProjectedConnectionFields(entry);
        continue;
      }
      const projected = projectCatalogEntry(entry, "en");
      expect(projected.installable).toBe(false);
      expect(projected.config).toBeNull();
      expect(projected.installCommand).toBeNull();
    }
  });

  /* No shipped entry carries a static header today, so the branch is exercised with a fixture. */
  it("carries a static header into the pasteable config", () => {
    const entry: McpCatalogEntry = {
      id: "static",
      registryId: "mcp/static",
      name: "static",
      title: { en: "Static", zh: "Static" },
      description: { en: "", zh: "" },
      whenToUse: { en: "", zh: "" },
      installable: true,
      url: "https://static.example/mcp",
      defaultAuthKind: "bearer",
      authHeader: "x-api-key",
      authScheme: "",
      extraHeaders: { "x-tenant": "public" },
      category: "development",
      website: "https://static.example",
      iconUrl: "",
      order: 1,
      status: "active",
      capabilities: ["read-things"],
      auth: { methods: ["bearer"], defaultKind: "bearer" },
      risk: { sideEffects: "none", dataAccess: "public" },
    };
    expectProjectedConnectionFields(entry);
    expect(projectCatalogEntry(entry, "en").config).toEqual({
      mcpServers: { static: { type: "http", url: "https://static.example/mcp", headers: { "x-tenant": "public" } } },
    });
  });
});

describe("public catalog MCP endpoint: request budget", () => {
  it("answers the request past the budget with a JSON-RPC 429", async () => {
    const instance = catalogApp({ publicMcpCatalog: { rateLimiter: new RouteRateLimiter(2, 60_000) } });
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await rpc(instance, ping)).statusCode).toBe(200);
    expect((await rpc(instance, ping)).statusCode).toBe(200);
    const limited = await rpc(instance, ping);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(limited.json().error.code).toBe(-32000);
  });
});
