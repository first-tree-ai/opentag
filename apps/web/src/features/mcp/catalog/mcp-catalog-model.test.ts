import type { MCPAgentServer, MCPServer } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import type { McpCatalogEntry } from "./mcp-catalog.gen.js";
import {
  catalogEntryState,
  comparableUrl,
  entriesInCategory,
  findAccountServer,
  localizedText,
  matchesCatalogEntry,
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

describe("catalog entry reuse", () => {
  it("finds an Account definition with the same URL regardless of spelling", () => {
    const server = accountServer({ url: "https://MCP.Notion.com/mcp" });
    expect(findAccountServer(catalogEntry(), [server])).toBe(server);
  });

  it("returns nothing when the Account holds no definition for the entry", () => {
    expect(findAccountServer(catalogEntry(), [accountServer({ url: "https://mcp.linear.app/mcp" })])).toBeUndefined();
  });
});

describe("per-Agent catalog state", () => {
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

  it("is installed when mounted without an active authorization", () => {
    const authorization = mount().authorization;
    const mounted = mount({ authorization: authorization && { ...authorization, status: "pending" } });
    expect(catalogEntryState(catalogEntry(), [accountServer()], [mounted])).toBe("installed");
  });

  it("is authorized when mounted with an active authorization", () => {
    expect(catalogEntryState(catalogEntry(), [accountServer()], [mount()])).toBe("authorized");
  });

  it("matches an Agent-level URL override back to the entry", () => {
    const mounted = mount({ effective: { ...mount().effective, url: "https://internal.example.com/mcp" } });
    expect(catalogEntryState(catalogEntry(), [accountServer()], [mounted])).toBe("authorized");
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
