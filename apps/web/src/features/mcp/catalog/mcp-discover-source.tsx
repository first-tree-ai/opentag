import type { McpCatalogCategory, McpCatalogEntry } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPServer } from "@opentag/shared/browser";
import { type RefObject, useState } from "react";
import { getLocale } from "../../../i18n/locale.js";
import * as m from "../../../paraglide/messages.js";
import { Button, Field, Icon, KumoInputControl } from "../../../ui/design-system.js";
import { McpServiceIcon } from "../mcp-service-icon.js";
import {
  catalogEntryState,
  entriesInCategory,
  isCatalogPreview,
  localizedText,
  type McpCatalogEntryState,
  matchesCatalogEntry,
} from "./mcp-catalog-model.js";

/** Stays mounted during prerequisite guidance, preserving search, category, and scroll position. */
export function McpDiscoverSource({
  categories,
  entries,
  servers,
  mounted,
  busy,
  pendingEntryId,
  searchRef,
  onAdd,
}: {
  categories: readonly McpCatalogCategory[];
  entries: readonly McpCatalogEntry[];
  servers: readonly MCPServer[];
  mounted: readonly MCPAgentServer[];
  busy: boolean;
  pendingEntryId?: string;
  searchRef?: RefObject<HTMLInputElement | null>;
  onAdd: (entry: McpCatalogEntry) => void;
}) {
  const locale = getLocale();
  const [categoryId, setCategoryId] = useState("");
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const visible = searching
    ? entries.filter((entry) => matchesCatalogEntry(entry, query, locale))
    : categoryId
      ? entriesInCategory(entries, categoryId)
      : entries;
  const chooseCategory = (id: string) => {
    setQuery("");
    setCategoryId(id);
  };
  return (
    <>
      <Field htmlFor="mcp-discover-search" label={m.mcp_discover_search()} hideLabel>
        <KumoInputControl
          ref={searchRef}
          id="mcp-discover-search"
          value={query}
          placeholder={m.mcp_discover_search_placeholder()}
          onChange={(event) => setQuery(event.target.value)}
        />
      </Field>
      <fieldset className="mt-5 flex flex-wrap gap-1 border-0 p-0">
        <legend className="sr-only">{m.mcp_discover_categories()}</legend>
        <Button
          aria-pressed={!searching && !categoryId}
          size="compact"
          variant={!searching && !categoryId ? "secondary" : "ghost"}
          onClick={() => chooseCategory("")}
        >
          {m.mcp_discover_all()}
        </Button>
        {categories.map((category) => {
          const active = !searching && category.id === categoryId;
          return (
            <Button
              key={category.id}
              aria-pressed={active}
              size="compact"
              variant={active ? "secondary" : "ghost"}
              onClick={() => chooseCategory(category.id)}
            >
              {localizedText(category.label, locale)}
            </Button>
          );
        })}
      </fieldset>
      {visible.length ? (
        <ul className="mcp-catalog-grid mt-4" data-ui="mcp-catalog">
          {visible.map((entry) => (
            <McpCatalogCard
              key={entry.id}
              entry={entry}
              state={catalogEntryState(entry, servers, mounted)}
              busy={busy}
              connecting={busy && entry.id === pendingEntryId}
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

export function McpCatalogCard({
  entry,
  state = "available",
  busy,
  onAdd,
  example,
  connecting = false,
}: {
  entry: McpCatalogEntry;
  state?: McpCatalogEntryState;
  busy: boolean;
  onAdd: (entry: McpCatalogEntry) => void;
  example?: string;
  connecting?: boolean;
}) {
  const locale = getLocale();
  const title = localizedText(entry.title, locale);
  const preview = isCatalogPreview(entry);
  const added = state === "added";
  const label = m.mcp_attach_action();
  return (
    <li className="mcp-catalog-card rounded-lg border border-kumo-line bg-kumo-base p-5">
      <div className="mcp-catalog-card-heading flex min-w-0 items-center gap-3">
        <McpServiceIcon src={entry.iconIsOfficial ? entry.iconUrl : undefined} size={32} />
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <strong className="text-sm font-medium">{title}</strong>
          {preview ? (
            <span className="rounded border border-kumo-line px-2 py-0.5 text-xs text-kumo-subtle">
              {m.mcp_catalog_limited_access()}
            </span>
          ) : null}
        </div>
      </div>
      <p className="mcp-catalog-card-description text-sm leading-relaxed text-kumo-subtle">
        {localizedText(entry.description, locale)}
      </p>
      {example ? (
        <p className="mcp-quick-example rounded-md bg-kumo-tint p-3 text-xs leading-relaxed text-kumo-subtle">
          {example}
        </p>
      ) : null}
      <div className="mcp-catalog-card-actions mt-auto flex flex-wrap items-center justify-end gap-3 pt-2">
        {added ? (
          <span className="inline-flex min-h-8 items-center gap-1.5 text-xs text-kumo-subtle">
            <Icon name="check" />
            {m.mcp_catalog_added()}
          </span>
        ) : (
          <Button
            aria-label={`${label}: ${title}`}
            disabled={busy}
            loading={connecting}
            size="compact"
            onClick={() => onAdd(entry)}
          >
            {label}
          </Button>
        )}
      </div>
    </li>
  );
}
