import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES } from "../index.js";

describe("mcp preset catalog shape", () => {
  it("exposes a non-empty category list in strict order", () => {
    expect(MCP_CATALOG_CATEGORIES.length).toBeGreaterThan(0);
    const ids = MCP_CATALOG_CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    const orders = MCP_CATALOG_CATEGORIES.map((category) => category.order);
    expect([...orders].sort((left, right) => left - right)).toEqual(orders);
  });

  it("keeps every category referenced and every entry categorized", () => {
    const ids = new Set(MCP_CATALOG_CATEGORIES.map((category) => category.id));
    const used = new Set(MCP_CATALOG_ENTRIES.map((entry) => entry.category));
    expect(MCP_CATALOG_ENTRIES.length).toBeGreaterThan(0);
    for (const entry of MCP_CATALOG_ENTRIES) expect(ids.has(entry.category)).toBe(true);
    expect(used).toEqual(ids);
  });

  it("orders entries by category order, then entry order", () => {
    const categoryOrder = new Map(MCP_CATALOG_CATEGORIES.map((category) => [category.id, category.order]));
    const keys = MCP_CATALOG_ENTRIES.map((entry) => (categoryOrder.get(entry.category) ?? 0) * 1_000_000 + entry.order);
    expect([...keys].sort((left, right) => left - right)).toEqual(keys);
  });

  it("gives every entry a unique id and a complete localized card", () => {
    const ids = MCP_CATALOG_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of MCP_CATALOG_ENTRIES) {
      expect(entry.title.en.length).toBeGreaterThan(0);
      expect(entry.title.zh.length).toBeGreaterThan(0);
      expect(entry.description.en.length).toBeGreaterThan(0);
      expect(entry.description.zh.length).toBeGreaterThan(0);
    }
  });

  it("embeds every icon as a self-contained data URL", () => {
    for (const entry of MCP_CATALOG_ENTRIES) {
      expect(entry.iconUrl).toMatch(/^data:image\/(?:svg\+xml|png);base64,/);
    }
  });

  it("carries the providers unblocked by the protected-resource identity work", () => {
    const byId = new Map(MCP_CATALOG_ENTRIES.map((entry) => [entry.id, entry]));
    // Atlassian's tool-selection query parameter is part of the published endpoint, not decoration.
    expect(byId.get("atlassian")).toMatchObject({
      url: "https://mcp.atlassian.com/v2/mcp?tools=all",
      defaultAuthKind: "oauth",
      category: "engineering",
    });
    expect(byId.get("airtable")).toMatchObject({
      url: "https://mcp.airtable.com/mcp",
      defaultAuthKind: "oauth",
      category: "business-data",
    });
    expect(byId.get("amplitude")).toMatchObject({
      url: "https://mcp.amplitude.com/mcp",
      defaultAuthKind: "oauth",
      category: "business-data",
    });
  });

  it("records Amplitude's client-authentication limitation in the catalog source", async () => {
    /*
     * The preset is listed, but the catalog must not read as a claim of end-to-end support: the
     * provider's token endpoint advertises client_secret_post and none, not the basic method the
     * dynamic-registration path presents, so authorization stays unverified until the follow-up.
     */
    const source = await readFile(new URL("../../mcp-catalog.yaml", import.meta.url), "utf8");
    expect(source).toContain("client_secret_post");
    expect(source).toContain("Amplitude's authorization remains unverified");
  });
});
