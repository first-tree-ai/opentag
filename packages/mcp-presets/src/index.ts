/**
 * The repository's MCP marketplace catalog: the categories and Server entries the Web App's add
 * flow renders as Discover, with the icon bytes embedded in the generated module.
 *
 * `mcp-catalog.gen.ts` is generated from `mcp-categories.yaml`, `mcp-catalog.yaml`, and `icons/*` by
 * `scripts/generate-mcp-catalog.mjs` and committed. Every entry was validated against the same
 * outbound URL policy and create schema the Server enforces, so a card a user meets is a payload the
 * Server would accept.
 */
export {
  MCP_CATALOG_CATEGORIES,
  MCP_CATALOG_ENTRIES,
  type McpCatalogCategory,
  type McpCatalogEntry,
  type McpCatalogLocale,
  type McpCatalogLocalizedText,
} from "./mcp-catalog.gen.js";
