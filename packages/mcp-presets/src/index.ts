/**
 * The repository's MCP marketplace catalog: the categories and Server entries the Web App's add
 * flow renders as Discover, with the icon bytes embedded in the generated module.
 *
 * Each source entry is validated against `schema/mcp-catalog-entry.schema.json`, which is also
 * exported here as `MCP_CATALOG_ENTRY_SCHEMA` with the supported locales injected.
 *
 * `mcp-catalog.gen.ts` is generated from `mcp-categories.yaml`, `mcp-catalog.yaml`, and `icons/*` by
 * `scripts/generate-mcp-catalog.mjs` and committed. Every entry was validated against the same
 * outbound URL policy and create schema the Server enforces, so a card a user meets is a payload the
 * Server would accept.
 */
export {
  MCP_CATALOG_CATEGORIES,
  MCP_CATALOG_ENTRIES,
  MCP_CATALOG_ENTRY_SCHEMA,
  type McpCatalogCategory,
  type McpCatalogEntry,
  type McpCatalogEnvironmentVariable,
  type McpCatalogLocale,
  type McpCatalogLocalizedText,
  type McpCatalogPackage,
  type McpCatalogPackageArgument,
  type McpCatalogPlatform,
  type McpCatalogRemote,
  type McpCatalogSideEffect,
  type McpCatalogStatus,
  type McpCatalogTool,
  type McpInstallableCatalogEntry,
} from "./mcp-catalog.gen.js";
export {
  createMcpCatalogSearch,
  findMcpCatalogEntry,
  MCP_CATALOG_SEARCH_DEFAULT_LIMIT,
  MCP_CATALOG_SEARCH_MAX_LIMIT,
  type McpCatalogCategoryCount,
  type McpCatalogSearch,
  type McpCatalogSearchOptions,
  type McpCatalogSearchResult,
  mcpCatalogSearch,
  searchMcpCatalog,
} from "./search.js";
export { type McpCatalogViolation, validateMcpCatalog, validateMcpCatalogEntry } from "./validate.js";
