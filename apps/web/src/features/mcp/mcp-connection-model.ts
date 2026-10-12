import { MCP_CATALOG_ENTRIES, type McpCatalogEntry } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPAuthKind, MCPServer } from "@opentag/shared/browser";
import { comparableUrl } from "./catalog/mcp-catalog-model.js";

/** Authentication and consent scopes require the actual endpoint, not its brand or icon match. */
export function connectionPreset(url: string): McpCatalogEntry | undefined {
  return MCP_CATALOG_ENTRIES.find((entry) => comparableUrl(entry.url) === comparableUrl(url));
}

export function connectionAuthKind(url: string, binding?: MCPAgentServer, server?: MCPServer): MCPAuthKind {
  return binding?.authorization?.kind ?? server?.defaultAuthKind ?? connectionPreset(url)?.defaultAuthKind ?? "none";
}

/** Unknown endpoints retain URL Add's anonymous probe followed by explicit-rejection OAuth discovery. */
export function allowsOAuthDiscovery(url: string, kind: MCPAuthKind): boolean {
  return kind === "none" && !connectionPreset(url);
}
