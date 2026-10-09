import { describe, expect, it } from "vitest";
import {
  PublicCatalogLocalizedTextSchema,
  PublicMcpCatalogResponseSchema,
  PublicSkillCatalogResponseSchema,
} from "../public-catalog.js";

const skillResponse = {
  categories: [{ id: "getting-started", order: 10 }],
  presets: [
    {
      name: "mcp-onboarding",
      description: "Teach an Agent to find and mount an MCP Server for itself",
      category: "getting-started",
      order: 10,
    },
  ],
};

const mcpResponse = {
  categories: [{ id: "general", label: { en: "General", zh: "通用" }, order: 10 }],
  servers: [
    {
      id: "notion",
      name: "notion",
      title: { en: "Notion", zh: "Notion" },
      description: { en: "Docs, wikis, and project pages.", zh: "文档、知识库与项目页面。" },
      category: "general",
      website: "https://www.notion.com",
      iconUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      order: 10,
      defaultAuthKind: "oauth",
    },
  ],
};

describe("public Skill catalog schema", () => {
  it("round-trips categories and presets with display fields only", () => {
    expect(PublicSkillCatalogResponseSchema.parse(skillResponse)).toEqual(skillResponse);
  });

  it("rejects archive identity, install state, and unknown keys on a preset", () => {
    for (const extra of [
      { archiveSha256: "a".repeat(64) },
      { archiveBytes: 1024 },
      { fileCount: 2 },
      { state: "installed" },
      { title: "MCP onboarding" },
    ]) {
      expect(
        PublicSkillCatalogResponseSchema.safeParse({
          ...skillResponse,
          presets: [{ ...skillResponse.presets[0], ...extra }],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects an unknown category id and a negative order", () => {
    expect(
      PublicSkillCatalogResponseSchema.safeParse({ ...skillResponse, categories: [{ id: "operations", order: 0 }] })
        .success,
    ).toBe(false);
    expect(
      PublicSkillCatalogResponseSchema.safeParse({
        ...skillResponse,
        presets: [{ ...skillResponse.presets[0], order: -1 }],
      }).success,
    ).toBe(false);
  });
});

describe("public MCP catalog schema", () => {
  it("round-trips categories and servers with localized copy", () => {
    expect(PublicMcpCatalogResponseSchema.parse(mcpResponse)).toEqual(mcpResponse);
  });

  it("requires both locales on every localized field", () => {
    expect(PublicCatalogLocalizedTextSchema.safeParse({ en: "General", zh: "通用" }).success).toBe(true);
    expect(PublicCatalogLocalizedTextSchema.safeParse({ en: "General" }).success).toBe(false);
    expect(PublicCatalogLocalizedTextSchema.safeParse({ en: "", zh: "通用" }).success).toBe(false);
    expect(
      PublicMcpCatalogResponseSchema.safeParse({
        ...mcpResponse,
        servers: [{ ...mcpResponse.servers[0], title: { en: "Notion" } }],
      }).success,
    ).toBe(false);
  });

  it("rejects endpoint URLs, authorization prefill fields, and unknown keys", () => {
    for (const extra of [
      { url: "https://mcp.notion.com/mcp" },
      { authHeader: "Authorization" },
      { authScheme: "Bearer" },
      { extraHeaders: { "x-workspace-id": "workspace" } },
    ]) {
      expect(
        PublicMcpCatalogResponseSchema.safeParse({
          ...mcpResponse,
          servers: [{ ...mcpResponse.servers[0], ...extra }],
        }).success,
      ).toBe(false);
    }
  });

  it("accepts every documented authorization kind and rejects an unknown one", () => {
    for (const kind of ["none", "bearer", "oauth"]) {
      const parsed = PublicMcpCatalogResponseSchema.parse({
        ...mcpResponse,
        servers: [{ ...mcpResponse.servers[0], defaultAuthKind: kind }],
      });
      expect(parsed.servers[0]?.defaultAuthKind).toBe(kind);
    }
    expect(
      PublicMcpCatalogResponseSchema.safeParse({
        ...mcpResponse,
        servers: [{ ...mcpResponse.servers[0], defaultAuthKind: "basic" }],
      }).success,
    ).toBe(false);
  });
});
