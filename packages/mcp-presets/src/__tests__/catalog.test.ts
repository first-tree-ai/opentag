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
      expect(entry.iconUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);
    }
  });
});
