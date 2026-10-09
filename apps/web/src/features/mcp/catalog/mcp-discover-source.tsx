import type { McpCatalogCategory, McpCatalogEntry } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPServer } from "@opentag/shared/browser";
import { useState } from "react";
import { getLocale } from "../../../i18n/locale.js";
import * as m from "../../../paraglide/messages.js";
import { Button, Field, KumoInputControl } from "../../../ui/design-system.js";
import { McpServiceIcon } from "../mcp-service-icon.js";
import {
  catalogEntryState,
  entriesInCategory,
  localizedText,
  type McpCatalogEntryState,
  matchesCatalogEntry,
} from "./mcp-catalog-model.js";

/**
 * The Discover source of the add flow: the marketplace catalog, grouped under the categories its
 * source declares.
 *
 * The catalog's own copy is data-driven and localized in the catalog sources, so this component only
 * picks the active locale; the surface's chrome (the search label, the method labels, the installed
 * states) is ordinary interface copy from the message catalog.
 */
export function McpDiscoverSource({
  categories,
  entries,
  servers,
  mounted,
  busy,
  onAdd,
}: {
  categories: readonly McpCatalogCategory[];
  entries: readonly McpCatalogEntry[];
  servers: readonly MCPServer[];
  mounted: readonly MCPAgentServer[];
  busy: boolean;
  onAdd: (entry: McpCatalogEntry) => void;
}) {
  const locale = getLocale();
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const visible = searching
    ? entries.filter((entry) => matchesCatalogEntry(entry, query, locale))
    : entriesInCategory(entries, categoryId);
  return (
    <>
      <Field htmlFor="mcp-discover-search" label={m.mcp_discover_search()}>
        <KumoInputControl
          id="mcp-discover-search"
          value={query}
          placeholder={m.mcp_discover_search_placeholder()}
          onChange={(event) => setQuery(event.target.value)}
        />
      </Field>
      <fieldset className="mt-5 flex flex-wrap gap-1 border-0 p-0">
        <legend className="sr-only">{m.mcp_discover_categories()}</legend>
        {categories.map((category) => {
          const active = !searching && category.id === categoryId;
          return (
            <Button
              key={category.id}
              aria-pressed={active}
              size="compact"
              variant={active ? "secondary" : "ghost"}
              onClick={() => {
                setQuery("");
                setCategoryId(category.id);
              }}
            >
              {localizedText(category.label, locale)}
            </Button>
          );
        })}
      </fieldset>
      {visible.length ? (
        <ul className="mt-4 grid max-h-96 gap-3 overflow-y-auto" data-ui="mcp-catalog">
          {visible.map((entry) => (
            <McpCatalogCard
              key={entry.id}
              entry={entry}
              state={catalogEntryState(entry, servers, mounted)}
              busy={busy}
              onAdd={onAdd}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-kumo-subtle">{m.mcp_discover_empty()}</p>
      )}
    </>
  );
}

function McpCatalogCard({
  entry,
  state,
  busy,
  onAdd,
}: {
  entry: McpCatalogEntry;
  state: McpCatalogEntryState;
  busy: boolean;
  onAdd: (entry: McpCatalogEntry) => void;
}) {
  const locale = getLocale();
  const title = localizedText(entry.title, locale);
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-kumo-line p-3">
      <div className="flex min-w-0 items-start gap-3">
        <McpServiceIcon src={entry.iconIsOfficial ? entry.iconUrl : undefined} size={24} />
        <div className="grid min-w-0 gap-1">
          <strong className="text-sm font-medium">{title}</strong>
          <p className="text-xs leading-relaxed text-kumo-subtle">{localizedText(entry.description, locale)}</p>
          <a
            className="justify-self-start text-xs text-kumo-subtle underline underline-offset-4"
            href={entry.website}
            target="_blank"
            rel="noreferrer"
          >
            {m.mcp_discover_website()}
          </a>
        </div>
      </div>
      {state === "available" ? (
        <Button
          aria-label={`${methodLabel(entry)}: ${title}`}
          disabled={busy}
          size="compact"
          onClick={() => onAdd(entry)}
        >
          {methodLabel(entry)}
        </Button>
      ) : (
        <span className="shrink-0 text-xs text-kumo-subtle">
          {state === "authorized" ? m.mcp_authorization_status_active() : m.mcp_authorization_required()}
        </span>
      )}
    </li>
  );
}

/**
 * Names the method the add will use. It never says the Server requires that method: the catalog's
 * `defaultAuthKind` is a prefill for the new authorization, not a statement about the Server.
 */
function methodLabel(entry: McpCatalogEntry): string {
  if (entry.defaultAuthKind === "oauth") return m.mcp_discover_method_oauth();
  if (entry.defaultAuthKind === "bearer") return m.mcp_discover_method_bearer();
  return m.mcp_discover_method_none();
}
