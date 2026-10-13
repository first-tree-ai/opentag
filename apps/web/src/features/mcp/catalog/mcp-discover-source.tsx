import type { McpCatalogCategory, McpCatalogEntry } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPServer } from "@opentag/shared/browser";
import { type RefObject, useState } from "react";
import { getLocale } from "../../../i18n/locale.js";
import * as m from "../../../paraglide/messages.js";
import { Button, Field, KumoInputControl } from "../../../ui/design-system.js";
import { McpServiceIcon } from "../mcp-service-icon.js";
import { McpCatalogActions, McpCatalogDescription, type McpCatalogFeedback } from "./mcp-catalog-feedback.js";
import {
  catalogEntryState,
  entriesInCategory,
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
  pending = {},
  searchRef,
  onAdd,
  connectedIds = [],
  initialView,
  onViewChange,
  feedback,
}: {
  categories: readonly McpCatalogCategory[];
  entries: readonly McpCatalogEntry[];
  servers: readonly MCPServer[];
  mounted: readonly MCPAgentServer[];
  busy: boolean;
  pending?: Record<string, { action: "add" | "connect" }>;
  searchRef?: RefObject<HTMLInputElement | null>;
  onAdd: (entry: McpCatalogEntry) => void;
  connectedIds?: string[];
  initialView?: { query: string; categoryId: string };
  onViewChange?: (view: { query: string; categoryId: string }) => void;
  feedback?: Record<string, McpCatalogFeedback>;
}) {
  const locale = getLocale();
  const [categoryId, setCategoryId] = useState(initialView?.categoryId ?? "");
  const [query, setQuery] = useState(initialView?.query ?? "");
  const searching = query.trim().length > 0;
  const visible = searching
    ? entries.filter((entry) => matchesCatalogEntry(entry, query, locale))
    : categoryId
      ? entriesInCategory(entries, categoryId)
      : entries;
  const chooseCategory = (id: string) => {
    setQuery("");
    setCategoryId(id);
    onViewChange?.({ query: "", categoryId: id });
  };
  return (
    <>
      <Field htmlFor="mcp-discover-search" label={m.mcp_discover_search()} hideLabel>
        <KumoInputControl
          ref={searchRef}
          id="mcp-discover-search"
          value={query}
          disabled={busy}
          placeholder={m.mcp_discover_search_placeholder()}
          onChange={(event) => {
            setQuery(event.target.value);
            onViewChange?.({ query: event.target.value, categoryId });
          }}
        />
      </Field>
      <fieldset className="mt-5 flex flex-wrap gap-1 border-0 p-0">
        <legend className="sr-only">{m.mcp_discover_categories()}</legend>
        <Button
          aria-pressed={!searching && !categoryId}
          disabled={busy}
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
              disabled={busy}
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
              state={connectedIds.includes(entry.id) ? "added" : catalogEntryState(entry, servers, mounted)}
              busy={busy || Boolean(pending[entry.id])}
              connecting={Boolean(pending[entry.id])}
              pendingAction={pending[entry.id]?.action}
              onAdd={onAdd}
              feedback={feedback?.[entry.id]}
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
  connecting = false,
  pendingAction,
  feedback,
}: {
  entry: McpCatalogEntry;
  state?: McpCatalogEntryState;
  busy: boolean;
  onAdd: (entry: McpCatalogEntry) => void;
  connecting?: boolean;
  pendingAction?: "add" | "connect";
  feedback?: McpCatalogFeedback;
}) {
  const locale = getLocale();
  const title = localizedText(entry.title, locale);
  return (
    <li className="mcp-catalog-card rounded-lg border border-kumo-line bg-kumo-base p-5">
      <div className="mcp-catalog-card-heading flex min-w-0 items-center gap-3">
        <McpServiceIcon src={entry.iconIsOfficial ? entry.iconUrl : undefined} size={32} />
        <div className="mcp-catalog-card-copy flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <strong className="mcp-catalog-card-title text-sm font-medium">{title}</strong>
        </div>
      </div>
      <McpCatalogDescription description={localizedText(entry.description, locale)} feedback={feedback} />
      <div className="mcp-catalog-card-actions mt-auto flex flex-wrap items-center justify-end gap-3 pt-2">
        <McpCatalogActions
          title={title}
          state={state}
          busy={busy}
          connecting={connecting}
          pendingAction={pendingAction}
          feedback={feedback}
          onAdd={() => onAdd(entry)}
        />
      </div>
    </li>
  );
}
