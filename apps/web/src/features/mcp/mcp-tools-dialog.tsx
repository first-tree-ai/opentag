import type { MCPAgentServer } from "@opentag/shared/browser";
import { type RefCallback, type RefObject, useCallback, useId, useRef, useState } from "react";
import { formatDateTime } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { Button, Collapsible, Dialog, Icon, Info, KumoInputControl, MagnifyingGlass } from "../../ui/design-system.js";
import { McpAuthorizeDialog } from "./mcp-authorize-dialog.js";
import { McpDialogTitle } from "./mcp-dialog-title.js";
import { actionError } from "./mcp-form-model.js";
import { useProbeMcpServer } from "./mcp-queries.js";
import { rememberMcpReturn } from "./mcp-return-context.js";

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
function McpPartialTools() {
  return (
    <Collapsible.Root className="min-w-0 text-sm text-kumo-subtle">
      <Collapsible.Trigger
        render={
          <Button
            className="h-auto w-full justify-start whitespace-normal px-0 py-0 text-left"
            size="compact"
            variant="ghost"
          />
        }
      >
        <Info aria-hidden className="size-4 shrink-0 text-kumo-warning" />
        {m.mcp_partial()}
        <Icon
          className="ml-auto size-3.5 shrink-0 transition-transform [[data-panel-open]_&]:rotate-180"
          name="chevron-down"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="pt-2">
        <p className="wrap-anywhere pl-6 text-sm text-kumo-subtle">{m.mcp_partial_help()}</p>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
export function McpToolsDialog({
  agentId,
  agentName,
  entry,
  onClose,
  onBack,
  onRequestAuthentication,
  initialQuery = "",
  initialScrollTop = 0,
  initialAuthentication = false,
  authenticationError,
}: {
  agentId: string;
  agentName: string;
  entry: MCPAgentServer;
  onClose: () => void;
  onBack?: (query: string, scrollTop: number) => void;
  onRequestAuthentication?: (query: string, scrollTop: number) => boolean;
  initialQuery?: string;
  initialScrollTop?: number;
  initialAuthentication?: boolean;
  authenticationError?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [authentication, setAuthentication] = useState(initialAuthentication);
  const [authError, setAuthError] = useState(authenticationError);
  const scrollTop = useRef(initialScrollTop);
  const returning = useRef(initialAuthentication);
  const reconnectTrigger = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string>();
  const list = useRef<HTMLElement>(null);
  const { bodyHeight, sizeBody } = useToolsBodySize(list);
  const search = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const probe = useProbeMcpServer(agentId);
  const attachList = useCallback((node: HTMLElement | null) => {
    list.current = node;
    if (node) node.scrollTop = scrollTop.current;
  }, []);
  const tools = entry.snapshot?.tools ?? [];
  const matches = tools.filter((tool) =>
    `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const pending = probe.isPending || entry.authorization?.probeState === "pending";
  const history = hasHistoricalTools(entry, probe.isPending, error);
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
  if (authentication)
    return (
      <McpAuthorizeDialog
        agentId={agentId}
        agentName={agentName}
        entry={entry}
        initialError={authError}
        onClose={onClose}
        onBack={() => {
          returning.current = true;
          setAuthError(undefined);
          setAuthentication(false);
        }}
        onAuthorized={() => {
          setError(undefined);
          returning.current = true;
          setAuthError(undefined);
          setAuthentication(false);
        }}
        onBeforeOAuth={() =>
          rememberMcpReturn({
            agentId,
            serverId: entry.mcpServerId,
            source: "tools",
            query,
            scrollTop: scrollTop.current,
          })
        }
      />
    );
  const connected = entry.authorization?.status === "active";
  const failure = toolFailure(entry, pending, error);
  return (
    <Dialog
      initialFocusRef={returning.current ? search : undefined}
      className="mcp-tools-dialog"
      title={
        onBack ? (
          m.mcp_settings_tools()
        ) : (
          <McpDialogTitle entry={entry} title={m.mcp_tools_dialog_title({ server: entry.name })} />
        )
      }
      closeLabel={m.common_close_title({ title: m.mcp_tools_dialog_title({ server: entry.name }) })}
      description={m.mcp_settings_context({ server: entry.name, agent: agentName })}
      onClose={onClose}
      onBack={onBack ? () => onBack(query, scrollTop.current) : undefined}
    >
      <div className="mcp-tools-body" ref={sizeBody} style={bodyHeight ? { height: bodyHeight } : undefined}>
        <ToolsToolbar
          entry={entry}
          history={history}
          count={tools.length}
          pending={pending}
          refreshing={pending}
          onRefresh={() => void refresh()}
          failed={Boolean(failure)}
          reconnectRef={reconnectTrigger}
          onReconnect={() => {
            if (!onRequestAuthentication?.(query, scrollTop.current)) setAuthentication(true);
          }}
        />
        <div className="relative mb-4 shrink-0">
          <MagnifyingGlass
            aria-hidden
            className="pointer-events-none absolute left-3 top-3 z-1 size-4 text-kumo-subtle"
          />
          <KumoInputControl
            className="w-full pl-9 pr-10"
            ref={search}
            aria-label={m.mcp_tools_search()}
            placeholder={m.mcp_tools_search()}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              scrollTop.current = 0;
              if (list.current) list.current.scrollTop = 0;
            }}
          />
          {query ? (
            <Button
              aria-label={m.mcp_tools_clear()}
              className="absolute right-1 top-1"
              shape="square"
              size="compact"
              variant="ghost"
              onClick={() => {
                setQuery("");
                scrollTop.current = 0;
                if (list.current) list.current.scrollTop = 0;
                search.current?.focus();
              }}
            >
              <Icon name="close" />
            </Button>
          ) : null}
        </div>
        <ToolsStatus
          entry={entry}
          failure={failure}
          connected={connected}
          history={history}
          hasTools={tools.length > 0}
        />
        <ToolList
          list={attachList}
          matches={matches}
          query={query}
          truncated={entry.authorization?.toolsTruncated ?? false}
          connected={connected}
          loaded={Boolean(entry.snapshot) && entry.authorization?.probeState === "succeeded"}
          pending={pending}
          onScroll={() => {
            scrollTop.current = list.current?.scrollTop ?? 0;
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
  failed,
  reconnectRef,
  onReconnect,
}: {
  entry: MCPAgentServer;
  history: boolean;
  count: number;
  pending: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  failed: boolean;
  reconnectRef: RefObject<HTMLButtonElement | null>;
  onReconnect: () => void;
}) {
  return (
    <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-kumo-subtle">
        {entry.snapshot
          ? history
            ? m.mcp_tools_history()
            : count === 1
              ? m.mcp_tools_count_one()
              : m.mcp_tools_count({ count: count })
          : pending
            ? m.mcp_probe_state_pending()
            : m.mcp_tools_none_loaded()}
        {!history && entry.authorization?.probedAt ? (
          <span> · {m.mcp_tools_updated({ time: formatDateTime(entry.authorization.probedAt) })}</span>
        ) : null}
      </p>
      {entry.authorization?.status === "active" ? (
        <Button
          aria-label={failed ? m.mcp_retry() : m.mcp_probe_action()}
          size="compact"
          variant="ghost"
          disabled={pending}
          loading={refreshing}
          onClick={onRefresh}
        >
          {failed ? m.mcp_retry() : m.mcp_probe_action()}
        </Button>
      ) : (
        <Button ref={reconnectRef} size="compact" variant="secondary" onClick={onReconnect}>
          {m.mcp_reconnect()}
        </Button>
      )}
    </div>
  );
}
function ToolList({
  list,
  matches,
  query,
  truncated,
  loaded,
  connected,
  pending,
  onScroll,
}: {
  list: RefCallback<HTMLElement>;
  matches: Tool[];
  query: string;
  truncated: boolean;
  loaded: boolean;
  connected: boolean;
  pending: boolean;
  onScroll: () => void;
}) {
  return (
    <section
      ref={list}
      onScroll={onScroll}
      className="mcp-tool-list border-t border-kumo-line focus-visible:outline-2 focus-visible:outline-kumo-ring"
      aria-label={m.mcp_tools_title()}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The tool list must support keyboard scrolling inside the dialog.
      tabIndex={0}
    >
      <ul className="divide-y divide-kumo-line">
        {matches.map((tool) => (
          <ToolRow key={tool.name} tool={tool} query={query} />
        ))}
      </ul>
      {!matches.length ? (
        <ToolsEmpty query={query} pending={pending} loaded={loaded} connected={connected} truncated={truncated} />
      ) : null}
    </section>
  );
}

function hasHistoricalTools(entry: MCPAgentServer, refreshing: boolean, error?: string): boolean {
  return (
    entry.authorization?.status !== "active" ||
    entry.authorization.probeState !== "succeeded" ||
    refreshing ||
    Boolean(error)
  );
}

function ToolsEmpty({
  query,
  pending,
  loaded,
  connected,
  truncated,
}: {
  query: string;
  pending: boolean;
  loaded: boolean;
  connected: boolean;
  truncated: boolean;
}) {
  const title = query
    ? m.mcp_tools_no_matches()
    : pending
      ? m.mcp_probe_state_pending()
      : loaded && !truncated
        ? m.mcp_tools_zero()
        : m.mcp_tools_none_loaded();
  const help = toolsEmptyHelp(query, pending, loaded, connected, truncated);
  return (
    <div className="px-5 py-12 text-center text-sm">
      <p className="font-medium">{title}</p>
      {help ? <p className="mt-2 text-kumo-subtle">{help}</p> : null}
    </div>
  );
}
function toolsEmptyHelp(
  query: string,
  pending: boolean,
  loaded: boolean,
  connected: boolean,
  truncated: boolean,
): string {
  if (query) return m.mcp_tools_search_help();
  if (pending) return "";
  if (!connected) return m.mcp_tools_auth_required();
  if (truncated) return m.mcp_tools_partial_empty();
  return loaded ? m.mcp_tools_empty() : m.mcp_tools_not_loaded_help();
}

function toolFailure(entry: MCPAgentServer, pending: boolean, error?: string): string | undefined {
  if (pending) return undefined;
  return error ?? (entry.authorization?.probeState === "failed" ? m.mcp_tools_refresh_error() : undefined);
}

function useToolsBodySize(list: RefObject<HTMLElement | null>) {
  const [bodyHeight, setBodyHeight] = useState<number>();
  const sizeBody = useCallback(
    (body: HTMLDivElement | null) => {
      const tools = list.current;
      if (!body || !tools) return;
      const height = body.getBoundingClientRect().height;
      if (!height) return;
      setBodyHeight(height - tools.clientHeight + Math.max(160, tools.scrollHeight));
    },
    [list],
  );
  return { bodyHeight, sizeBody };
}

function ToolsStatus({
  entry,
  failure,
  connected,
  history,
  hasTools,
}: {
  entry: MCPAgentServer;
  failure?: string;
  connected: boolean;
  history: boolean;
  hasTools: boolean;
}) {
  return (
    <>
      {failure && connected ? (
        <div className="mb-3">
          <p role="alert" className="text-sm text-kumo-danger">
            {failure}
          </p>
        </div>
      ) : null}
      {!connected && hasTools ? <p className="mb-3 text-sm text-kumo-subtle">{m.mcp_tools_auth_required()}</p> : null}
      {history && entry.snapshot ? (
        <p className="mb-3 text-xs text-kumo-subtle">{m.mcp_tools_previous_hint()}</p>
      ) : null}
      {entry.authorization?.toolsTruncated ? (
        <div className="mb-4 shrink-0">
          <McpPartialTools />
        </div>
      ) : null}
    </>
  );
}
