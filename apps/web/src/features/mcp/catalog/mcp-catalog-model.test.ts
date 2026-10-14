import type { McpCatalogEntry } from "@opentag/mcp-presets";
import { CANVA_DEVELOPER_PORTAL_MCP_URL, type MCPAgentServer, type MCPServer } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import {
  catalogEntryState,
  catalogEntryUrls,
  comparableUrl,
  entriesInCategory,
  findCatalogBinding,
  findCatalogEntryByUrl,
  localizedText,
  matchesCatalogEntry,
  resolveCatalogEntries,
} from "./mcp-catalog-model.js";

function catalogEntry(overrides: Partial<McpCatalogEntry> = {}): McpCatalogEntry {
  return {
    id: "notion",
    name: "notion",
    title: { en: "Notion", zh: "Notion" },
    description: { en: "Docs and wikis.", zh: "文档与知识库。" },
    url: "https://mcp.notion.com/mcp",
    defaultAuthKind: "oauth",
    category: "general",
    website: "https://www.notion.com",
    iconUrl: "/assets/notion.svg",
    order: 10,
    ...overrides,
  };
}

function accountServer(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "notion",
    description: null,
    url: "https://mcp.notion.com/mcp",
    defaultAuthKind: "oauth",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    revision: 1,
    boundAgentCount: 0,
    authorizedAgentCount: 0,
    lastProbedAt: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function mount(overrides: Partial<MCPAgentServer> = {}): MCPAgentServer {
  return {
    mcpServerId: "11111111-1111-4111-8111-111111111111",
    name: "notion",
    description: null,
    discoveredDescription: null,
    enabled: true,
    effective: {
      url: "https://mcp.notion.com/mcp",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
    },
    overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
    authorization: {
      kind: "oauth",
      status: "active",
      hasCredential: true,
      scopes: null,
      accessTokenExpiresAt: null,
      authorizationServer: null,
      probeState: "succeeded",
      probedAt: null,
      probeError: null,
      toolsCount: 3,
      toolsTruncated: false,
      failureCode: null,
      revision: 1,
    },
    snapshot: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("localized catalog text", () => {
  it("returns the requested locale without falling back", () => {
    const text = { en: "Docs and wikis.", zh: "文档与知识库。" };
    expect(localizedText(text, "en")).toBe("Docs and wikis.");
    expect(localizedText(text, "zh")).toBe("文档与知识库。");
  });
});

describe("catalog search", () => {
  it("matches a term that appears only in the active locale's description", () => {
    const entry = catalogEntry();
    expect(matchesCatalogEntry(entry, "知识库", "zh")).toBe(true);
    expect(matchesCatalogEntry(entry, "知识库", "en")).toBe(false);
  });

  it("matches the entry name and URL", () => {
    const entry = catalogEntry();
    expect(matchesCatalogEntry(entry, "NOTION", "en")).toBe(true);
    expect(matchesCatalogEntry(entry, "mcp.notion.com", "en")).toBe(true);
  });

  it("matches everything for an empty query and nothing for an absent term", () => {
    const entry = catalogEntry();
    expect(matchesCatalogEntry(entry, "   ", "en")).toBe(true);
    expect(matchesCatalogEntry(entry, "linear", "en")).toBe(false);
  });
});

describe("catalog URL comparison", () => {
  it("treats spellings of the same endpoint as equal", () => {
    expect(comparableUrl("https://MCP.Notion.com/mcp")).toBe(comparableUrl("https://mcp.notion.com/mcp"));
    expect(comparableUrl("https://mcp.notion.com")).toBe(comparableUrl("https://mcp.notion.com/"));
  });

  it("keeps a value it cannot parse comparable against itself", () => {
    expect(comparableUrl("not a url")).toBe("not a url");
  });
});

describe("per-Agent catalog state", () => {
  it("recognizes an installed service with connection parameters and a trailing slash", () => {
    const mounted = mount({ effective: { ...mount().effective, url: "https://mcp.notion.com/mcp/?workspace=demo" } });
    expect(catalogEntryState(catalogEntry(), [], [mounted])).toBe("added");
  });
  it("is available when the Agent does not mount the Server", () => {
    expect(catalogEntryState(catalogEntry(), [accountServer()], [])).toBe("available");
  });

  it("is available when the Agent mounts a different Server", () => {
    const other = mount({
      mcpServerId: "22222222-2222-4222-8222-222222222222",
      effective: { ...mount().effective, url: "https://mcp.linear.app/mcp" },
    });
    expect(catalogEntryState(catalogEntry(), [accountServer()], [other])).toBe("available");
  });

  it("offers connection when mounted without an active authorization", () => {
    const authorization = mount().authorization;
    const mounted = mount({ authorization: authorization && { ...authorization, status: "pending" } });
    expect(catalogEntryState(catalogEntry(), [accountServer()], [mounted])).toBe("unconnected");
  });

  it("is added when mounted with an active authorization", () => {
    expect(catalogEntryState(catalogEntry(), [accountServer()], [mount()])).toBe("added");
  });

  it("finds an overridden installation even when another Agent's definition comes first", () => {
    const own = accountServer();
    const other = accountServer({ id: "22222222-2222-4222-8222-222222222222" });
    const mounted = mount({ effective: { ...mount().effective, url: "https://internal.example.com/mcp" } });
    expect(findCatalogBinding(catalogEntry(), [other, own], [mounted])).toBe(mounted);
    expect(findCatalogBinding(catalogEntry(), [other], [mounted])).toBeUndefined();
  });
  it("matches an Agent-level URL override back to the entry", () => {
    const mounted = mount({ effective: { ...mount().effective, url: "https://internal.example.com/mcp" } });
    expect(catalogEntryState(catalogEntry(), [accountServer()], [mounted])).toBe("added");
  });
});

describe("category grouping", () => {
  it("keeps only the requested category, in order", () => {
    const entries = [
      catalogEntry({ id: "a", order: 10 }),
      catalogEntry({ id: "b", category: "engineering", order: 5 }),
      catalogEntry({ id: "c", order: 20 }),
    ];
    expect(entriesInCategory(entries, "general").map((entry) => entry.id)).toEqual(["a", "c"]);
  });
});

describe("catalog service identity", () => {
  it("recognizes an official endpoint with normalized spelling and connection parameters", () => {
    const entry = catalogEntry();
    expect(findCatalogEntryByUrl(" https://MCP.Notion.com:443/mcp/?workspace=demo#tools ", [entry])).toBe(entry);
  });

  it.each([
    "https://mcp.notion.com.example.com/mcp",
    "https://custom.example.com/mcp",
    "https://mcp.notion.com/other",
    "http://mcp.notion.com/mcp",
    "https://notion:mypass@mcp.notion.com/mcp",
    "not a url",
  ])("does not assign a product logo to %s", (url) => {
    expect(findCatalogEntryByUrl(url, [catalogEntry()])).toBeUndefined();
  });
});

describe("deployment catalog endpoints", () => {
  const canva = catalogEntry({ id: "canva", name: "canva", url: "https://mcp.canva.com/mcp" });
  const notion = catalogEntry();

  it("identifies an entry by its shipped endpoint and its deployment-client endpoint", () => {
    expect(catalogEntryUrls(notion)).toEqual([notion.url]);
    expect(catalogEntryUrls(canva)).toEqual([canva.url, CANVA_DEVELOPER_PORTAL_MCP_URL]);
    expect(findCatalogEntryByUrl(CANVA_DEVELOPER_PORTAL_MCP_URL, [notion, canva])).toBe(canva);
    expect(findCatalogEntryByUrl(`${CANVA_DEVELOPER_PORTAL_MCP_URL}/`, [notion, canva])).toBe(canva);
    expect(findCatalogEntryByUrl("https://mcp.canva.com/mcp", [notion, canva])).toBe(canva);
  });

  it("keeps the catalog as shipped when the deployment replaces nothing", () => {
    const entries = [notion, canva];
    expect(resolveCatalogEntries(entries, [])).toBe(entries);
  });

  it("replaces only the named entry's endpoint and keeps its shipped identity", () => {
    const resolved = resolveCatalogEntries(
      [notion, canva],
      [{ catalogId: "canva", url: CANVA_DEVELOPER_PORTAL_MCP_URL }],
    );
    expect(resolved[0]).toBe(notion);
    expect(resolved[1]).toEqual({ ...canva, url: CANVA_DEVELOPER_PORTAL_MCP_URL, shippedUrl: canva.url });
    // The preferred endpoint comes first, and the shipped one is never lost or repeated.
    expect(catalogEntryUrls(resolved[1] as McpCatalogEntry)).toEqual([CANVA_DEVELOPER_PORTAL_MCP_URL, canva.url]);
    expect(findCatalogEntryByUrl(canva.url, resolved)).toBe(resolved[1]);
    expect(findCatalogEntryByUrl(CANVA_DEVELOPER_PORTAL_MCP_URL, resolved)).toBe(resolved[1]);
  });

  it("reports an Agent's working waitlist mount as added for the replaced entry", () => {
    const served = resolveCatalogEntries([canva], [{ catalogId: "canva", url: CANVA_DEVELOPER_PORTAL_MCP_URL }])[0];
    const waitlist = accountServer({ name: "canva", url: canva.url });
    const working = mount({
      mcpServerId: waitlist.id,
      name: "canva",
      effective: { ...mount().effective, url: canva.url },
    });
    expect(findCatalogBinding(served as McpCatalogEntry, [waitlist], [working])).toBe(working);
    expect(catalogEntryState(served as McpCatalogEntry, [waitlist], [working])).toBe("added");
    // The same holds when the Account list has not loaded and only the mount's URL is known.
    expect(catalogEntryState(served as McpCatalogEntry, [], [working])).toBe("added");
  });

  it("refuses an endpoint the shared contract does not name for that entry", () => {
    const entries = [notion, canva];
    expect(resolveCatalogEntries(entries, [{ catalogId: "canva", url: "https://evil.example/mcp" }])).toEqual(entries);
    expect(resolveCatalogEntries(entries, [{ catalogId: "notion", url: CANVA_DEVELOPER_PORTAL_MCP_URL }])).toEqual(
      entries,
    );
    expect(resolveCatalogEntries(entries, [{ catalogId: "unknown", url: CANVA_DEVELOPER_PORTAL_MCP_URL }])).toEqual(
      entries,
    );
  });
});
