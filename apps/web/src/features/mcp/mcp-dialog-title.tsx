import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import type { MCPAgentServer } from "@opentag/shared/browser";
import { findCatalogEntryByUrl } from "./catalog/mcp-catalog-model.js";
import { McpServiceIcon } from "./mcp-service-icon.js";

export function McpDialogTitle({ entry, title }: { entry: MCPAgentServer; title: string }) {
  const service = findCatalogEntryByUrl(entry.effective.url, MCP_CATALOG_ENTRIES);
  return (
    <span className="flex items-center gap-2.5">
      <McpServiceIcon size={24} src={service?.iconIsOfficial ? service.iconUrl : undefined} />
      <span>{title}</span>
    </span>
  );
}
