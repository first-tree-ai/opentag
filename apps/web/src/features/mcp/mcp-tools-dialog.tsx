import type { MCPAgentServer } from "@opentag/shared/browser";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { formatDateTime } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog, Icon, KumoInputControl, MagnifyingGlass } from "../../ui/design-system.js";
import { McpDisclosure } from "./mcp-form.js";
import { actionError } from "./mcp-form-model.js";
import { useProbeMcpServer } from "./mcp-queries.js";

/** A snippet around a description hit, so a result does not conceal why it matched. */
export function toolExcerpt(description: string | null, query: string): string {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  const index = text.toLowerCase().indexOf(query.trim().toLowerCase());
  const start = Math.max(0, index - 45);
  return `${start ? "…" : ""}${text.slice(start)}`;
}
export function McpPartialTools() {
  return (
    <details className="mcp-url-help min-w-0 text-xs text-kumo-subtle">
      <summary>
        {m.mcp_partial()}
        <Icon name="chevron-down" className="size-3" />
      </summary>
      <p className="mt-2 max-w-prose leading-relaxed">{m.mcp_partial_help()}</p>
    </details>
  );
}
export function McpToolsDialog({
  agentId,
  agentName,
  entry,
  onClose,
}: {
  agentId: string;
  agentName: string;
  entry: MCPAgentServer;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const position = useRef(0);
  const lastTool = useRef<string>(undefined);
  const inFlight = useRef(false);
  const probe = useProbeMcpServer(agentId);
  const tools = entry.snapshot?.tools ?? [];
  const detail = tools.find((tool) => tool.name === selected);
  const matches = tools.filter((tool) =>
    `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const pending = probe.isPending || entry.authorization?.probeState === "pending";
  const history =
    entry.authorization?.status !== "active" ||
    entry.authorization.probeState !== "succeeded" ||
    probe.isPending ||
    Boolean(error);
  const refresh = async () => {
    if (inFlight.current || pending) return;
    inFlight.current = true;
    setError(undefined);
    try {
      await probe.mutateAsync(entry.mcpServerId);
    } catch (cause) {
      setError(actionError(cause, m.mcp_probe_failed()));
    } finally {
      inFlight.current = false;
    }
  };
  useLayoutEffect(() => {
    if (selected || !list.current) return;
    list.current.scrollTop = position.current;
    if (lastTool.current)
      Array.from(list.current.querySelectorAll<HTMLButtonElement>("button[data-tool]"))
        .find((button) => button.dataset.tool === lastTool.current)
        ?.focus({ preventScroll: true });
  }, [selected]);
  return (
    <Dialog
      className="mcp-tools-dialog"
      title={m.mcp_tools_dialog_title({ server: entry.name })}
      description={m.mcp_tools_use_help({ agent: agentName })}
      onClose={onClose}
    >
      <div className="mcp-tools-body">
        {detail ? (
          <ToolDetail tool={detail} server={entry.name} onBack={() => setSelected(undefined)} />
        ) : (
          <>
            <ToolsToolbar
              entry={entry}
              history={history}
              count={tools.length}
              pending={pending}
              refreshing={probe.isPending}
              onRefresh={() => void refresh()}
            />
            <div className="relative mb-4 shrink-0">
              <MagnifyingGlass
                aria-hidden
                className="pointer-events-none absolute left-3 top-3 z-1 size-4 text-kumo-subtle"
              />
              <KumoInputControl
                className="w-full pl-9"
                ref={search}
                aria-label={m.mcp_tools_search()}
                placeholder={m.mcp_tools_search()}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  position.current = 0;
                }}
              />
            </div>
            {error ? (
              <div className="mb-3">
                <Banner variant="error">{error}</Banner>
              </div>
            ) : null}
            {history ? <p className="mb-3 text-xs text-kumo-subtle">{m.mcp_tools_previous_hint()}</p> : null}
            {entry.authorization?.toolsTruncated ? (
              <div className="mb-4">
                <McpPartialTools />
              </div>
            ) : null}
            <ToolList
              list={list}
              matches={matches}
              query={query}
              truncated={entry.authorization?.toolsTruncated ?? false}
              onSelect={(name) => {
                position.current = list.current?.scrollTop ?? 0;
                lastTool.current = name;
                setSelected(name);
              }}
              onClear={() => {
                setQuery("");
                search.current?.focus();
              }}
            />
            {query ? (
              <p className="shrink-0 pt-3 text-xs text-kumo-subtle" aria-live="polite">
                {m.mcp_tools_search_count({ count: matches.length, total: tools.length })}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

type Tool = NonNullable<NonNullable<MCPAgentServer["snapshot"]>["tools"]>[number];
function ToolDetail({ tool: detail, server, onBack }: { tool: Tool; server: string; onBack: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <>
      <div className="shrink-0 border-b border-kumo-line pb-4">
        <Button className="mb-4 -ml-2" size="compact" variant="ghost" onClick={() => onBack()}>
          <Icon name="arrow-left" />
          {m.mcp_tools_back()}
        </Button>
        <h3 ref={heading} tabIndex={-1} className="wrap-anywhere text-base font-semibold">
          {detail.name}
        </h3>
        <p className="mt-1 text-xs text-kumo-subtle">{m.mcp_tools_source({ server: server })}</p>
      </div>
      <div className="mcp-tool-detail pt-5">
        <p className="mb-6 whitespace-pre-wrap text-sm leading-relaxed text-kumo-subtle">
          {detail.description ?? m.mcp_details_no_description()}
        </p>
        {detail.inputSchema != null ? (
          <McpDisclosure label={m.mcp_tools_column_schema()}>
            <pre className="rounded bg-kumo-recessed p-4 text-xs leading-relaxed">
              {JSON.stringify(detail.inputSchema, null, 2)}
            </pre>
          </McpDisclosure>
        ) : null}
      </div>
    </>
  );
}
function ToolsToolbar({
  entry,
  history,
  count,
  pending,
  refreshing,
  onRefresh,
}: {
  entry: MCPAgentServer;
  history: boolean;
  count: number;
  pending: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-kumo-subtle">
        {history ? m.mcp_tools_history() : m.mcp_tools_count({ count: count })}
        {!history && entry.authorization?.probedAt ? (
          <span> · {m.mcp_tools_updated({ time: formatDateTime(entry.authorization.probedAt) })}</span>
        ) : null}
      </p>
      {entry.enabled && entry.authorization?.status === "active" ? (
        <Button size="compact" variant="ghost" disabled={pending} loading={refreshing} onClick={onRefresh}>
          {m.mcp_probe_action()}
        </Button>
      ) : null}
    </div>
  );
}
function ToolList({
  list,
  matches,
  query,
  truncated,
  onSelect,
  onClear,
}: {
  list: RefObject<HTMLDivElement | null>;
  matches: Tool[];
  query: string;
  truncated: boolean;
  onSelect: (name: string) => void;
  onClear: () => void;
}) {
  return (
    <div ref={list} className="mcp-tool-list border-t border-kumo-line">
      <ul className="divide-y divide-kumo-line">
        {matches.map((tool) => (
          <li key={tool.name}>
            <button
              type="button"
              data-tool={tool.name}
              className="mcp-choice"
              onClick={() => {
                onSelect(tool.name);
              }}
            >
              <span className="grid min-w-0 flex-1 gap-1">
                <strong className="wrap-anywhere text-sm font-medium">{tool.name}</strong>
                {tool.description ? (
                  <span className="truncate text-xs text-kumo-subtle">{toolExcerpt(tool.description, query)}</span>
                ) : null}
              </span>
              <Icon className="size-3.5 shrink-0 text-kumo-subtle" name="chevron-right" />
            </button>
          </li>
        ))}
      </ul>
      {!matches.length ? (
        <div className="px-5 py-12 text-center text-sm">
          <p className="font-medium">{query ? m.mcp_tools_no_matches() : m.mcp_tools_none_loaded()}</p>
          <p className="mt-2 text-kumo-subtle">
            {query ? m.mcp_tools_search_help() : truncated ? m.mcp_tools_partial_empty() : m.mcp_tools_empty()}
          </p>
          {query ? (
            <Button className="mt-3" size="compact" variant="ghost" onClick={onClear}>
              {m.mcp_tools_clear()}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
