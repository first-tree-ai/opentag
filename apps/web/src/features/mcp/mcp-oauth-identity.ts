import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import { findCatalogEntryByUrl, localizedText } from "./catalog/mcp-catalog-model.js";

export type McpOAuthIdentity = { name: string; iconUrl?: string };

export function mcpOAuthIdentity(url: string, name?: string): McpOAuthIdentity {
  const service = findCatalogEntryByUrl(url, MCP_CATALOG_ENTRIES);
  return {
    name: service ? localizedText(service.title) : (name ?? new URL(url).hostname),
    iconUrl: service?.iconIsOfficial ? service.iconUrl : undefined,
  };
}
