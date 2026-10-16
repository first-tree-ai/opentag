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
      registryId: "mcp/notion",
      installable: true,
      whenToUse: { en: "Use for pages and wikis.", zh: "用于页面和知识库。" },
      capabilities: ["search-docs"],
      keywords: ["wiki"],
      status: "active",
      risk: { sideEffects: "write", dataAccess: "private" },
      category: "general",
      website: "https://www.notion.com",
      iconUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      order: 10,
      defaultAuthKind: "oauth",
    },
  ],
};

describe("public MCP catalog packages", () => {
  const packageServer = {
    ...mcpResponse.servers[0],
    installable: false,
    packages: [
      {
        registryType: "npm",
        identifier: "@scope/server",
        version: "1.0.0",
        runtimeHint: "npx",
        transport: "stdio",
        packageArguments: [{ type: "named", name: "--port" }],
        environmentVariables: [{ name: "SERVER_API_KEY", isSecret: true, isRequired: true }],
      },
    ],
    prerequisites: ["Node.js 22"],
    platforms: ["linux"],
  };

  it("round-trips a packages-only server", () => {
    const parsed = PublicMcpCatalogResponseSchema.parse({ ...mcpResponse, servers: [packageServer] });
    expect(parsed.servers[0]?.installable).toBe(false);
    expect(parsed.servers[0]?.packages?.[0]?.identifier).toBe("@scope/server");
  });

  it("rejects package values, defaults, and an unknown registry type", () => {
    const withVariable = (variable: Record<string, unknown>) => ({
      ...mcpResponse,
      servers: [{ ...packageServer, packages: [{ ...packageServer.packages[0], environmentVariables: [variable] }] }],
    });
    expect(PublicMcpCatalogResponseSchema.safeParse(withVariable({ name: "X", value: "v" })).success).toBe(false);
    expect(PublicMcpCatalogResponseSchema.safeParse(withVariable({ name: "X", default: "v" })).success).toBe(false);
    const badType = { ...packageServer, packages: [{ ...packageServer.packages[0], registryType: "cargo" }] };
    expect(PublicMcpCatalogResponseSchema.safeParse({ ...mcpResponse, servers: [badType] }).success).toBe(false);
  });
});

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
      { remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }] },
      { auth: { methods: ["oauth"] } },
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
