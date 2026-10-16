import { MCP_CATALOG_ENTRIES, type McpInstallableCatalogEntry } from "@opentag/mcp-presets";
import { CANVA_DEVELOPER_PORTAL_MCP_URL } from "@opentag/shared/browser";
import { describe, expect, it, vi } from "vitest";
import { installableEntries } from "./catalog/mcp-catalog-model.js";
import { connectionAuthKind, connectionPreset } from "./mcp-connection-model.js";
import { authorization, detail, entry } from "./mcp-test-fixtures.js";

vi.mock("@opentag/mcp-presets", () => ({
  MCP_CATALOG_ENTRIES: [
    {
      id: "service",
      name: "service",
      installable: true,
      url: "https://service.test/mcp",
      defaultAuthKind: "oauth",
      oauthScopes: ["read"],
      keyAuth: { url: "https://service.test/key", authHeader: "x-api-key", authScheme: "" },
    },
    {
      id: "canva",
      name: "canva",
      installable: true,
      url: "https://mcp.canva.com/mcp",
      defaultAuthKind: "oauth",
    },
  ],
}));

describe("connection method precedence", () => {
  it.each(["oauth", "bearer", "none"] as const)("preserves Agent %s over the definition and catalog", (kind) => {
    const binding = entry({ authorization: { ...authorization(), kind } });
    expect(connectionAuthKind("https://service.test/mcp", binding, detail(1).server)).toBe(kind);
  });
  it.each(["oauth", "bearer", "none"] as const)("preserves Account %s over the catalog default", (kind) => {
    expect(
      connectionAuthKind("https://service.test/mcp", entry({ authorization: null }), {
        ...detail(1).server,
        defaultAuthKind: kind,
      }),
    ).toBe(kind);
  });
  it("uses a preset only for an exactly matching endpoint", () => {
    expect(connectionAuthKind("https://service.test/mcp")).toBe("oauth");
    expect(connectionPreset(" https://SERVICE.test/mcp ")).toBe(MCP_CATALOG_ENTRIES[0]);
    for (const url of [
      "https://service.test/mcp/",
      "https://service.test/mcp?tenant=other",
      "https://service.test/other",
      "https://service.test.evil/mcp",
      "http://service.test/mcp",
    ]) {
      expect(connectionPreset(url)).toBeUndefined();
      expect(connectionAuthKind(url)).toBe("none");
    }
  });
  it("treats an entry's deployment-client endpoint as that entry's actual endpoint", () => {
    const canva = MCP_CATALOG_ENTRIES[1];
    expect(connectionPreset("https://mcp.canva.com/mcp")).toBe(canva);
    expect(connectionPreset(CANVA_DEVELOPER_PORTAL_MCP_URL)).toBe(canva);
    // A Server on the Developer Portal endpoint keeps the entry's OAuth default and its consent flow.
    expect(connectionAuthKind(CANVA_DEVELOPER_PORTAL_MCP_URL)).toBe("oauth");
    expect(connectionPreset("https://api.canva.com/connect/v1/mcp/other")).toBeUndefined();
  });
});

describe("Preset method configuration", () => {
  it("uses a uniquely submitted configuration only after the old credential was revoked", () => {
    const preset = installableEntries(MCP_CATALOG_ENTRIES)[0];
    if (!preset) throw new Error("Missing multi-method preset");
    const switched = entry({
      effective: { url: preset.url, authHeader: "authorization", authScheme: "Bearer", extraHeaders: {} },
      authorization: { ...authorization(), kind: "bearer", status: "revoked", hasCredential: false },
    });
    expect(connectionAuthKind(preset.url, switched)).toBe("oauth");
    expect(connectionAuthKind(preset.url, { ...switched, authorization: { ...authorization(), kind: "bearer" } })).toBe(
      "bearer",
    );
  });
  it("uses each method's exact address and preserves an empty key prefix", async () => {
    const { presetAuthConfig, presetAuthKinds } = await import("./mcp-connection-model.js");
    const preset = {
      ...MCP_CATALOG_ENTRIES[0],
      keyAuth: { url: "https://service.test/key", authHeader: "x-api-key", authScheme: "" },
    } as McpInstallableCatalogEntry;
    expect(presetAuthKinds(preset)).toEqual(["oauth", "bearer"]);
    expect(presetAuthConfig(preset, "bearer")).toEqual({
      url: "https://service.test/key",
      authHeader: "x-api-key",
      authScheme: "",
    });
    expect(presetAuthConfig(preset, "oauth").url).toBe("https://service.test/mcp");
  });
});

describe("Details configuration classification", () => {
  it("preserves an existing OAuth installation on a catalog's shared legacy endpoint", async () => {
    const { settingsPreset } = await import("./mcp-connection-model.js");
    const preset = installableEntries(MCP_CATALOG_ENTRIES)[0];
    if (!preset?.keyAuth) throw new Error("Missing multi-method preset");
    const legacy = entry({
      effective: { url: preset.keyAuth.url, authHeader: "authorization", authScheme: "Bearer", extraHeaders: {} },
      authorization: { ...authorization(), kind: "oauth" },
    });
    expect(settingsPreset(legacy, MCP_CATALOG_ENTRIES)).toBe(preset);
  });
  it("keeps a preset while its submitted header rules differ from the revoked method", async () => {
    const { settingsPreset } = await import("./mcp-connection-model.js");
    const preset = {
      ...MCP_CATALOG_ENTRIES[0],
      keyAuth: { url: "https://service.test/key", authHeader: "x-api-key", authScheme: "" },
    } as McpInstallableCatalogEntry;
    const pending = entry({
      effective: { url: preset.url, authHeader: "authorization", authScheme: "Bearer", extraHeaders: {} },
      authorization: { ...authorization(), kind: "bearer", status: "revoked", hasCredential: false },
    });
    expect(settingsPreset(pending, [preset])).toBe(preset);
  });
  it("keeps custom query parameters and headers editable without a database source flag", async () => {
    const { settingsPreset } = await import("./mcp-connection-model.js");
    const preset = installableEntries(MCP_CATALOG_ENTRIES)[0];
    if (!preset) throw new Error("Missing test preset");
    const configured = entry({
      effective: { url: preset.url, authHeader: "authorization", authScheme: "Bearer", extraHeaders: {} },
    });
    expect(settingsPreset(configured, MCP_CATALOG_ENTRIES)).toBe(preset);
    expect(
      settingsPreset(
        { ...configured, effective: { ...configured.effective, url: `${preset.url}?tenant=one` } },
        MCP_CATALOG_ENTRIES,
      ),
    ).toBeUndefined();
    expect(
      settingsPreset(
        { ...configured, effective: { ...configured.effective, extraHeaders: { "x-tenant": "one" } } },
        MCP_CATALOG_ENTRIES,
      ),
    ).toBeUndefined();
    expect(
      settingsPreset(
        { ...configured, effective: { ...configured.effective, authHeader: "x-api-key", authScheme: "" } },
        MCP_CATALOG_ENTRIES,
      ),
    ).toBeUndefined();
  });
});
