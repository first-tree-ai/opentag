import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import { describe, expect, it, vi } from "vitest";
import { connectionAuthKind, connectionPreset } from "./mcp-connection-model.js";
import { authorization, detail, entry } from "./mcp-test-fixtures.js";

vi.mock("@opentag/mcp-presets", () => ({
  MCP_CATALOG_ENTRIES: [
    {
      id: "service",
      name: "service",
      url: "https://service.test/mcp",
      defaultAuthKind: "oauth",
      oauthScopes: ["read"],
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
});
