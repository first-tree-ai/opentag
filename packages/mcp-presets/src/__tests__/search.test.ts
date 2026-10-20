import { describe, expect, it } from "vitest";
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES, type McpCatalogEntry } from "../mcp-catalog.gen.js";
import {
  createMcpCatalogSearch,
  findMcpCatalogEntry,
  MCP_CATALOG_SEARCH_DEFAULT_LIMIT,
  MCP_CATALOG_SEARCH_MAX_LIMIT,
  searchMcpCatalog,
} from "../search.js";

const ids = (entries: readonly McpCatalogEntry[]) => entries.map((entry) => entry.id);

describe("searchMcpCatalog against the shipped catalog", () => {
  it("finds an entry by its English name", () => {
    expect(ids(searchMcpCatalog({ query: "notion" }).entries)).toContain("notion");
  });

  it("finds an entry by Chinese copy", () => {
    expect(ids(searchMcpCatalog({ query: "文档" }).entries)).toContain("notion");
  });

  /*
   * Chinese users name a product in Latin and describe the task in Chinese in one string. A word that
   * takes the CJK path as a whole never yields the Latin token, so the product name goes missing.
   */
  it("finds an entry by a query that mixes Latin and Chinese", () => {
    expect(ids(searchMcpCatalog({ query: "notion笔记", limit: 50 }).entries)).toContain("notion");
    expect(ids(searchMcpCatalog({ query: "notion笔记", limit: 50 }).entries)[0]).toBe("notion");
  });

  /* The registry identity is the exact name, so `mcp/linear` must not fall back to the token tier. */
  it("ranks a registry id above a mere token match", () => {
    expect(searchMcpCatalog({ query: "mcp/linear" }).entries[0]?.id).toBe("linear");
    expect(searchMcpCatalog({ query: "mcp/notion" }).entries[0]?.id).toBe("notion");
  });

  it("finds an entry by a hyphenated capability's segment", () => {
    /* `search-docs` is a capability of Notion; the segment alone must reach it. */
    expect(ids(searchMcpCatalog({ query: "search", limit: 50 }).entries).length).toBeGreaterThan(1);
  });

  it("matches a name by prefix", () => {
    /* Catalog order, not alphabetical: `google-sheets` is filed under Data, so it comes last. */
    expect(ids(searchMcpCatalog({ query: "goog", limit: 50 }).entries)).toEqual([
      "google-drive",
      "google-docs",
      "google-slides",
      "google-chat",
      "google-calendar",
      "google-people",
      "google-sheets",
    ]);
  });

  it("resolves an entry by its registry id as well as its name", () => {
    expect(findMcpCatalogEntry("notion")?.id).toBe("notion");
    expect(findMcpCatalogEntry("mcp/notion")?.id).toBe("notion");
    expect(findMcpCatalogEntry("  MCP/Notion  ")?.id).toBe("notion");
    expect(findMcpCatalogEntry("not-a-server")).toBeUndefined();
  });

  it("lists the whole catalog in catalog order when the query is empty", () => {
    const all = searchMcpCatalog({ limit: 50 });
    expect(all.total).toBe(MCP_CATALOG_ENTRIES.length);
    const categoryOrder = new Map(MCP_CATALOG_CATEGORIES.map((category) => [category.id, category.order]));
    const key = (entry: McpCatalogEntry) => (categoryOrder.get(entry.category) ?? 0) * 1000 + entry.order;
    expect(ids(all.entries)).toEqual(
      ids([...MCP_CATALOG_ENTRIES].sort((left, right) => key(left) - key(right) || left.id.localeCompare(right.id))),
    );
  });

  it("filters by category", () => {
    const result = searchMcpCatalog({ category: "docs", limit: 50 });
    expect(result.total).toBeGreaterThan(0);
    for (const entry of result.entries) expect(entry.category).toBe("docs");
  });

  it("clamps the limit into the documented range", () => {
    expect(searchMcpCatalog({}).entries).toHaveLength(
      Math.min(MCP_CATALOG_SEARCH_DEFAULT_LIMIT, MCP_CATALOG_ENTRIES.length),
    );
    expect(searchMcpCatalog({ limit: 0 }).entries).toHaveLength(1);
    expect(searchMcpCatalog({ limit: 999 }).entries.length).toBeLessThanOrEqual(MCP_CATALOG_SEARCH_MAX_LIMIT);
    expect(searchMcpCatalog({ limit: Number.NaN }).entries).toHaveLength(MCP_CATALOG_SEARCH_DEFAULT_LIMIT);
  });

  it("returns the same order for the same query twice", () => {
    const first = ids(searchMcpCatalog({ query: "search web", limit: 50 }).entries);
    const second = ids(searchMcpCatalog({ query: "search web", limit: 50 }).entries);
    expect(first).toEqual(second);
  });

  it("counts categories from the active catalog", () => {
    const counts = createMcpCatalogSearch().categories;
    expect(counts.map((count) => count.id)).toEqual(MCP_CATALOG_CATEGORIES.map((category) => category.id));
    for (const count of counts) {
      expect(count.activeCount).toBe(
        MCP_CATALOG_ENTRIES.filter((entry) => entry.category === count.id && entry.status === "active").length,
      );
      expect(count.installableCount).toBeLessThanOrEqual(count.activeCount);
    }
  });

  it("never returns a retired entry, whichever way it is reached", () => {
    const result = searchMcpCatalog({ query: "", limit: 50 });
    for (const entry of result.entries) expect(entry.status).toBe("active");
    for (const query of ["notion", "goog", "文档", "search-docs"]) {
      for (const entry of searchMcpCatalog({ query, limit: 50 }).entries) expect(entry.status).toBe("active");
    }
  });
});

/* The shipped catalog has no alias, retired, or package-only entry, so the invariants that need one use a fixture. */
const FIXTURE_CATEGORIES = [
  { id: "docs", label: { en: "Docs", zh: "文档" }, order: 10 },
  { id: "data", label: { en: "Data", zh: "数据" }, order: 20 },
];

function fixtureEntry(overrides: Partial<McpCatalogEntry> & Pick<McpCatalogEntry, "id" | "order">): McpCatalogEntry {
  const { id, order, ...rest } = overrides;
  return {
    id,
    registryId: `mcp/${id}`,
    name: id,
    title: { en: id, zh: id },
    description: { en: "", zh: "" },
    whenToUse: { en: "", zh: "" },
    installable: true,
    url: `https://${id}.example/mcp`,
    defaultAuthKind: "oauth",
    category: "docs",
    website: `https://${id}.example`,
    iconUrl: "",
    order,
    status: "active",
    capabilities: ["read-things"],
    auth: { methods: ["oauth"], defaultKind: "oauth" },
    risk: { sideEffects: "none", dataAccess: "public" },
    ...rest,
  };
}

const FIXTURE = createMcpCatalogSearch(
  [
    fixtureEntry({ id: "alpha", order: 10, aliases: ["first"] }),
    fixtureEntry({ id: "beta", order: 20, category: "data", status: "deprecated" }),
    fixtureEntry({ id: "gamma", order: 30, category: "data", installable: false, url: undefined }),
    /* A token match on alpha's alias without being alpha itself. */
    fixtureEntry({ id: "delta", order: 40, keywords: ["first"] }),
    /* Indexed copy that mixes scripts reaches the Latin half of the term. */
    fixtureEntry({ id: "epsilon", order: 50, keywords: ["notion笔记"] }),
  ],
  FIXTURE_CATEGORIES,
);

describe("search index invariants", () => {
  it("hits an entry by its alias", () => {
    expect(ids(FIXTURE.search({ query: "first" }).entries)).toEqual(["alpha", "delta"]);
    expect(FIXTURE.find("first")?.id).toBe("alpha");
  });

  it("indexes mixed-script copy into its Latin half", () => {
    expect(ids(FIXTURE.search({ query: "notion" }).entries)).toEqual(["epsilon"]);
  });

  it("ranks an exact alias above a mere token hit", () => {
    const result = FIXTURE.search({ query: "first" });
    expect(result.entries[0]?.id).toBe("alpha");
  });

  it("excludes a non-active entry from search, by-name lookup, and the listing", () => {
    expect(ids(FIXTURE.search({ limit: 50 }).entries)).toEqual(["alpha", "delta", "epsilon", "gamma"]);
    expect(FIXTURE.find("beta")).toBeUndefined();
    expect(ids(FIXTURE.search({ query: "beta" }).entries)).not.toContain("beta");
  });

  it("keeps a package-only entry searchable and reports it as not installable", () => {
    expect(FIXTURE.find("gamma")?.installable).toBe(false);
    expect(FIXTURE.find("gamma")?.url).toBeUndefined();
  });

  it("reports per-category counts over active entries only", () => {
    expect(FIXTURE.categories.map((count) => [count.id, count.activeCount, count.installableCount])).toEqual([
      ["docs", 3, 3],
      ["data", 1, 0],
    ]);
  });
});
