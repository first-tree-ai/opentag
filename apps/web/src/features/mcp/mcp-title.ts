import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import type { MCPAgentServer } from "@opentag/shared/browser";
import { findCatalogEntryByUrl, localizedText } from "./catalog/mcp-catalog-model.js";

/** Catalog names stay readable when the Account's unique-name constraint adds an installation suffix. */
export function mcpTitle(entry: Pick<MCPAgentServer, "name" | "effective">): string {
  const preset = findCatalogEntryByUrl(entry.effective.url, MCP_CATALOG_ENTRIES);
  if (!preset?.name) return entry.name;
  const suffix = entry.name.slice(preset.name.length + 1);
  const generated = entry.name.startsWith(`${preset.name}-`) && /^[1-9]\d*$/.test(suffix) && Number(suffix) >= 2;
  return entry.name === preset.name || generated ? localizedText(preset.title) : entry.name;
}
