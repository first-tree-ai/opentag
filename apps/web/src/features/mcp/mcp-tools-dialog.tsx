import type { MCPAgentServer } from "@opentag/shared/browser";
import { type RefObject, useId, useRef, useState } from "react";
import { formatDateTime } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog, KumoInputControl, MagnifyingGlass } from "../../ui/design-system.js";
import { McpHelp } from "./mcp-form.js";
import { actionError } from "./mcp-form-model.js";
import { useProbeMcpServer } from "./mcp-queries.js";

const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });

/** Preview complete source sentences, without rewriting provider text or clipping a search hit. */
export function toolExcerpt(description: string | null, query: string): string {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  const needle = query.trim().toLowerCase();
  const index = needle ? text.toLowerCase().indexOf(needle) : -1;
  const start = Math.max(0, index);
  const end = index < 0 ? 0 : index + needle.length;
  let excerpt = "";
  for (const sentence of sentences.segment(text)) {
    const boundary = sentence.index + sentence.segment.length;
    if (boundary <= start) continue;
    excerpt += sentence.segment;
    if (boundary >= end) break;
  }
  return excerpt.trim();
}
export function McpPartialTools() {
  return (
    <McpHelp label={m.mcp_partial()}>
      <p>{m.mcp_partial_help()}</p>
    </McpHelp>
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
  const [error, setError] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const probe = useProbeMcpServer(agentId);
  const tools = entry.snapshot?.tools ?? [];
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
  return (
    <Dialog
      className="mcp-tools-dialog"
      title={m.mcp_tools_dialog_title({ server: entry.name })}
      description={m.mcp_tools_use_help({ agent: agentName })}
      onClose={onClose}
    >
      <div className="mcp-tools-body">
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
              if (list.current) list.current.scrollTop = 0;
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
      </div>
    </Dialog>
  );
}

type Tool = NonNullable<NonNullable<MCPAgentServer["snapshot"]>["tools"]>[number];
function ToolRow({ tool, query }: { tool: Tool; query: string }) {
  const nameId = useId();
  return (
    <li className="min-w-0 px-1 py-4 wrap-anywhere" aria-labelledby={nameId}>
      <strong id={nameId} className="text-sm font-medium">
        {tool.name}
      </strong>
      {tool.description ? (
        <p className="mt-1 text-xs leading-relaxed text-kumo-subtle">{toolExcerpt(tool.description, query)}</p>
      ) : null}
    </li>
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
  onClear,
}: {
  list: RefObject<HTMLDivElement | null>;
  matches: Tool[];
  query: string;
  truncated: boolean;
  onClear: () => void;
}) {
  return (
    <div ref={list} className="mcp-tool-list border-t border-kumo-line">
      <ul className="divide-y divide-kumo-line">
        {matches.map((tool) => (
          <ToolRow key={tool.name} tool={tool} query={query} />
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
