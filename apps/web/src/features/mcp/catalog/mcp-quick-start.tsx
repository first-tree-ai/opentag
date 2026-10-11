import { MCP_CATALOG_ENTRIES, type McpCatalogEntry } from "@opentag/mcp-presets";
import * as m from "../../../paraglide/messages.js";
import { Button, Icon, Text } from "../../../ui/design-system.js";
import { McpCatalogCard } from "./mcp-discover-source.js";

/** A small, task-oriented starting point; the catalog remains the source of connection details. */
export function McpQuickStart({
  onDiscover,
  onAdd,
}: {
  onDiscover: (entry?: McpCatalogEntry) => void;
  onAdd: () => void;
}) {
  const examples = [
    { id: "exa", example: m.mcp_quick_example_exa() },
    { id: "notion", example: m.mcp_quick_example_notion() },
    { id: "linear", example: m.mcp_quick_example_linear() },
    { id: "airtable", example: m.mcp_quick_example_airtable() },
  ];
  return (
    <div className="grid gap-7" data-ui="mcp-quick-start">
      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <Text as="h2" variant="heading">
            {m.mcp_quick_title()}
          </Text>
          <p className="text-xs text-kumo-subtle">{m.mcp_quick_hint()}</p>
        </div>
        <ul className="mcp-quick-grid">
          {examples.map(({ id, example }) => {
            const entry = MCP_CATALOG_ENTRIES.find((entry) => entry.id === id);
            return entry ? (
              <McpCatalogCard key={id} entry={entry} busy={false} example={example} onAdd={onDiscover} />
            ) : null;
          })}
        </ul>
        <Button variant="ghost" className="mt-4" onClick={() => onDiscover()}>
          {m.mcp_quick_browse()}
          <Icon name="arrow-right" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-kumo-line pt-4 text-xs text-kumo-subtle">
        <span>{m.mcp_quick_custom()}</span>
        <Button variant="ghost" size="compact" onClick={onAdd}>
          {m.mcp_create_action()}
        </Button>
      </div>
    </div>
  );
}
