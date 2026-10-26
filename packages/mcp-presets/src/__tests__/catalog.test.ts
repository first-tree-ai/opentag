import { readFile } from "node:fs/promises";
import { checkOutboundUrl } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES, MCP_CATALOG_ENTRY_SCHEMA, validateMcpCatalog } from "../index.js";

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

  it("derives the slug id from the registry id and lists only offered entries", () => {
    for (const entry of MCP_CATALOG_ENTRIES) {
      expect(entry.registryId).toBe(`mcp/${entry.id}`);
      expect(entry.name).toBe(entry.id);
      expect(["active", "deprecated", "archived"]).toContain(entry.status);
    }
  });

  it("carries the registry fields every entry needs", () => {
    for (const entry of MCP_CATALOG_ENTRIES) {
      expect(entry.whenToUse.en.length).toBeGreaterThan(0);
      expect(entry.whenToUse.zh.length).toBeGreaterThan(0);
      expect(entry.capabilities.length).toBeGreaterThan(0);
      expect(entry.auth.methods).toContain(entry.auth.defaultKind);
      expect(entry.auth.defaultKind).toBe(entry.defaultAuthKind);
      expect(entry.auth.oauth !== undefined).toBe(entry.auth.methods.includes("oauth"));
    }
  });

  it("gives every installable entry its connection fields and no other entry any", () => {
    for (const entry of MCP_CATALOG_ENTRIES) {
      if (entry.installable) {
        expect(entry.url).toMatch(/^https:\/\//);
        expect(entry.defaultAuthKind).toBe(entry.auth.defaultKind);
      } else {
        expect(entry.url).toBeUndefined();
        expect(entry.defaultAuthKind).toBeUndefined();
      }
    }
  });

  it("exports the entry schema with the supported locales injected", () => {
    const text = MCP_CATALOG_ENTRY_SCHEMA.$defs.localizedText;
    expect(Object.keys(text.properties).sort()).toEqual(["en", "zh"]);
    expect(MCP_CATALOG_ENTRY_SCHEMA.required).not.toContain("remotes");
    expect(MCP_CATALOG_ENTRY_SCHEMA.anyOf).toEqual([{ required: ["packages"] }, { required: ["remotes"] }]);
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
      category: "projects",
    });
    expect(byId.get("airtable")).toMatchObject({
      url: "https://mcp.airtable.com/mcp",
      defaultAuthKind: "oauth",
      category: "data",
    });
    expect(byId.get("amplitude")).toMatchObject({
      url: "https://mcp.amplitude.com/mcp",
      defaultAuthKind: "oauth",
      category: "data",
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

  it("validates every entry against the Server create schema and card rules", () => {
    expect(validateMcpCatalog(MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES)).toEqual([]);
  });

  it("limits GitHub OAuth scopes and advertises the code, issue, and pull request toolsets", () => {
    const github = MCP_CATALOG_ENTRIES.find((entry) => entry.id === "github");
    expect(github).toMatchObject({
      installable: true,
      url: "https://api.githubcopilot.com/mcp/",
      defaultAuthKind: "oauth",
      oauthScopes: ["repo", "offline_access"],
      extraHeaders: { "X-MCP-Toolsets": "context,repos,issues,pull_requests,users" },
    });
  });

  it("points every entry at an endpoint the outbound gate would dial", () => {
    for (const entry of MCP_CATALOG_ENTRIES) {
      if (!entry.installable || entry.url === undefined) continue;
      const verdict = checkOutboundUrl(entry.url, { allowLoopback: false });
      expect(verdict, entry.id).not.toHaveProperty("failure");
    }
  });

  it("reports violations for a malformed entry", () => {
    const base = MCP_CATALOG_ENTRIES.find((entry) => entry.installable);
    if (!base) throw new Error("catalog has no installable entry");
    const bad = { ...base, name: "Bad Name", category: "missing", website: "ftp://x", oauthScopes: [] };
    const fields = validateMcpCatalog(MCP_CATALOG_CATEGORIES, [bad]).map((v) => v.field);
    expect(fields).toEqual(expect.arrayContaining(["name", "category", "website", "oauthScopes"]));
  });

  describe("card and cross-entry rules", () => {
    const base = MCP_CATALOG_ENTRIES.find((entry) => entry.installable);
    if (!base) throw new Error("catalog has no installable entry");
    const violationsOf = (entries: (typeof base)[], categories = MCP_CATALOG_CATEGORIES) =>
      validateMcpCatalog(categories, entries).map((violation) => `${violation.subject}:${violation.field}`);

    it("rejects a malformed id, icon, order, and blank localized copy", () => {
      const bad = {
        ...base,
        id: "Bad_ID",
        iconUrl: "https://example.com/icon.png",
        order: -1,
        title: { en: " ", zh: "" },
        description: { en: "", zh: " " },
      };
      expect(violationsOf([bad])).toEqual(
        expect.arrayContaining([
          "Bad_ID:id",
          "Bad_ID:iconUrl",
          "Bad_ID:order",
          "Bad_ID:title.en",
          "Bad_ID:title.zh",
          "Bad_ID:description.en",
          "Bad_ID:description.zh",
        ]),
      );
    });

    it("rejects duplicate ids, names, and order slots", () => {
      const fields = violationsOf([base, { ...base }]);
      expect(fields).toEqual(expect.arrayContaining([`${base.id}:id`, `${base.id}:name`, `${base.id}:order`]));
    });

    it("rejects a duplicate category id and a blank category label", () => {
      const category = MCP_CATALOG_CATEGORIES[0];
      if (!category) throw new Error("catalog has no category");
      const fields = violationsOf([], [category, { ...category, label: { en: "", zh: category.label.zh } }]);
      expect(fields).toEqual(expect.arrayContaining([`${category.id}:id`, `${category.id}:label.en`]));
    });

    it("rejects out-of-bounds OAuth scopes", () => {
      expect(violationsOf([{ ...base, oauthScopes: [" ", "x".repeat(256)] }])).toEqual(
        expect.arrayContaining([`${base.id}:oauthScopes[0]`, `${base.id}:oauthScopes[1]`]),
      );
      const tooMany = Array.from({ length: 65 }, (_, index) => `scope-${index}`);
      expect(violationsOf([{ ...base, oauthScopes: tooMany }])).toContain(`${base.id}:oauthScopes`);
    });
  });

  describe("optional create-request headers", () => {
    const base = MCP_CATALOG_ENTRIES.find((entry) => entry.installable);
    if (!base) throw new Error("catalog has no installable entry");
    const fieldsOf = (entry: typeof base) =>
      validateMcpCatalog(MCP_CATALOG_CATEGORIES, [entry]).map((violation) => violation.field);

    it("rejects an invalid HTTP header name", () => {
      expect(fieldsOf({ ...base, authHeader: "bad header" })).toContain("authHeader");
      expect(fieldsOf({ ...base, extraHeaders: { "bad header": "v" } }).length).toBeGreaterThan(0);
    });

    it("rejects an extra header that repeats the authorization header", () => {
      const entry = { ...base, authHeader: "x-api-key", extraHeaders: { "x-api-key": "v" } };
      expect(fieldsOf(entry).length).toBeGreaterThan(0);
    });

    it("rejects connection fields on a non-installable entry", () => {
      const entry = { ...base, installable: false };
      expect(fieldsOf(entry)).toEqual(expect.arrayContaining(["url", "defaultAuthKind"]));
    });
  });
});
