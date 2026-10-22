import type { McpCatalogCategory, McpInstallableCatalogEntry } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPServer } from "@opentag/shared/browser";
import { useState } from "react";
import { OverflowFilter } from "../../../components/kumo/overflow-filter/overflow-filter.js";
import { getLocale } from "../../../i18n/locale.js";
import * as m from "../../../paraglide/messages.js";
import { Field, KumoInputControl, Select } from "../../../ui/design-system.js";
import { authorizationAction, connectorFeedback } from "../mcp-feedback.js";
import { McpServiceIcon } from "../mcp-service-icon.js";
import { hasMcpToolSnapshot } from "../mcp-tool-snapshot.js";
import { McpCatalogActions, McpCatalogDescription, type McpCatalogFeedback } from "./mcp-catalog-feedback.js";
import {
  catalogEntryState,
  entriesInCategory,
  findCatalogBinding,
  localizedText,
  type McpCatalogEntryState,
  matchesCatalogEntry,
  offeredEntries,
} from "./mcp-catalog-model.js";

/** Stays mounted during prerequisite guidance, preserving search, category, and scroll position. */
export function McpDiscoverSource({
  categories,
  entries: catalogEntries,
  servers,
  mounted,
  busy,
  pending = {},
  onAdd,
  connectedIds = [],
  initialView,
  onViewChange,
  feedback,
}: {
  categories: readonly McpCatalogCategory[];
  entries: readonly McpInstallableCatalogEntry[];
  servers: readonly MCPServer[];
  mounted: readonly MCPAgentServer[];
  busy: boolean;
  pending?: Record<string, { action: "add" | "connect" }>;
  onAdd: (entry: McpInstallableCatalogEntry) => void;
  connectedIds?: string[];
  initialView?: { query: string; categoryId: string };
  onViewChange?: (view: { query: string; categoryId: string }) => void;
  feedback?: Record<string, McpCatalogFeedback>;
}) {
  const locale = getLocale();
  const entries = offeredEntries(catalogEntries);
  // Navigation depends on the full directory, never on search results or connection status.
  const shownCategories = categories.filter((category) => entriesInCategory(entries, category.id).length >= 2);
  const [categoryId, setCategoryId] = useState(
    () => shownCategories.find((category) => category.id === initialView?.categoryId)?.id ?? "",
  );
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
      <div className="mcp-discover-category-select mt-5">
        <Select<string>
          aria-label={m.mcp_discover_categories()}
          className="w-full"
          disabled={busy}
          value={searching ? "" : categoryId}
          itemToStringLabel={(id) => {
            const category = shownCategories.find((category) => category.id === id);
            return category ? localizedText(category.label, locale) : m.mcp_discover_all();
          }}
          onValueChange={(id) => chooseCategory(id ?? "")}
        >
          <Select.Option value="">{m.mcp_discover_all()}</Select.Option>
          {shownCategories.map((category) => (
            <Select.Option key={category.id} value={category.id}>
              {localizedText(category.label, locale)}
            </Select.Option>
          ))}
        </Select>
      </div>
      <OverflowFilter
        className="mcp-discover-category-tabs mt-5"
        disabled={busy}
        items={[
          { value: "", label: m.mcp_discover_all() },
          ...shownCategories.map((category) => ({ value: category.id, label: localizedText(category.label, locale) })),
        ]}
        label={m.mcp_discover_categories()}
        moreLabel={m.mcp_discover_more()}
        value={searching ? null : categoryId}
        onValueChange={chooseCategory}
      />
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
              feedback={catalogFeedback(entry, servers, mounted, feedback?.[entry.id])}
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
  entry: McpInstallableCatalogEntry;
  state?: McpCatalogEntryState;
  busy: boolean;
  onAdd: (entry: McpInstallableCatalogEntry) => void;
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

function catalogFeedback(
  entry: McpInstallableCatalogEntry,
  servers: readonly MCPServer[],
  mounted: readonly MCPAgentServer[],
  local?: McpCatalogFeedback,
): McpCatalogFeedback | undefined {
  const binding = findCatalogBinding(entry, servers, mounted);
  if (local)
    return {
      ...local,
      actionLabel: local.action === "authorize" && binding ? authorizationAction(binding) : local.actionLabel,
    };
  if (!binding?.enabled) return;
  const feedback = connectorFeedback(binding);
  if (!feedback.label) return;
  return {
    entryId: entry.id,
    phase: feedback.neutral
      ? binding.authorization?.probeState === "pending" && !hasMcpToolSnapshot(binding)
        ? "checking"
        : "notice"
      : "error",
    label: feedback.label,
    action: feedback.action,
    actionLabel: feedback.action === "authorize" ? authorizationAction(binding) : undefined,
  };
}
