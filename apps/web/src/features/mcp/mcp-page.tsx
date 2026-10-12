import type { McpCatalogEntry } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPServer } from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import { PageHeader } from "../../components/kumo/page-header/page-header.js";
import { messagingProviderLabel } from "../../im/provider-label.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, Icon, Loader } from "../../ui/design-system.js";
import { readImBinding } from "../agents/agent-queries.js";
import { agentSettingsSectionLink } from "../agents/agent-routes.js";
import { useMcpCatalogConnection } from "./catalog/mcp-catalog-connection.js";
import { McpDiscoverDialog } from "./catalog/mcp-discover-dialog.js";
import { McpQuickStart } from "./catalog/mcp-quick-start.js";
import { McpAddDialog } from "./mcp-add-dialog.js";
import { McpConnectDialog } from "./mcp-connect-dialog.js";
import { actionError } from "./mcp-form-model.js";
import { readMcpOAuthOutcome } from "./mcp-oauth-outcome.js";
import { useAgentMcpServers, useUpdateMcpBinding } from "./mcp-queries.js";
import { consumeMcpReturn, type McpReturnContext } from "./mcp-return-context.js";
import { McpServerCard, type ServerAction } from "./mcp-server-card.js";
import { McpSettingsDialog } from "./mcp-settings-dialog.js";

type Panel =
  | { kind: "none" }
  | { kind: "add"; serverId?: string; authenticationError?: string }
  | { kind: "discover"; entry?: McpCatalogEntry }
  | {
      kind: ServerAction | "tools";
      entry: MCPAgentServer;
      context?: McpReturnContext;
      authenticationError?: string;
    };
/** One Agent's connections; runtime access remains determined by the server's actual authorization. */
export function McpPage({ agentId }: { agentId: string }) {
  const identity = useQuery({ queryKey: queryKeys.agents.detail(agentId), queryFn: () => browserApi.agent(agentId) });
  const agentName = identity.data?.displayName ?? agentId;
  const mounted = useAgentMcpServers(agentId);
  const servers = mounted.data?.servers ?? [];
  const connection = useMcpCatalogConnection(agentId);
  const addDisabled = mounted.isPending || mounted.isError || Boolean(connection.connectingId);
  const [{ outcome, returnContext }] = useState(() => {
    const outcome = readMcpOAuthOutcome();
    return { outcome, returnContext: outcome ? consumeMcpReturn(agentId, outcome.mcpServerId) : undefined };
  });
  const restored = useRef(false);
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const [highlight, setHighlight] = useState(outcome?.mcpServerId);
  const [completed, setCompleted] = useState<{ id: string; authorized: boolean }>();
  const [dismissed, setDismissed] = useState(hideReturnedCompletion(returnContext, outcome?.outcome.kind === "error"));
  useEffect(() => {
    if (!returnContext || returnContext.source === "add" || restored.current || mounted.isPending) return;
    const entry = servers.find((server) => server.mcpServerId === returnContext.serverId);
    if (!entry) return;
    restored.current = true;
    if (returnContext.source === "authorize") return;
    setPanel({
      kind: returnContext.source,
      entry,
      context: returnContext,
      authenticationError: outcome?.outcome.kind === "error" ? m.mcp_oauth_return_failed() : undefined,
    });
  }, [returnContext, outcome, mounted.isPending, servers]);
  useEffect(() => {
    if (returnContext?.source !== "add" || restored.current || mounted.isPending) return;
    const entry = servers.find((server) => server.mcpServerId === returnContext.serverId);
    if (!entry) return;
    restored.current = true;
    if (outcome?.outcome.kind === "error")
      setPanel({ kind: "add", serverId: entry.mcpServerId, authenticationError: m.mcp_oauth_return_failed() });
  }, [returnContext, outcome, mounted.isPending, servers]);
  const [removed, setRemoved] = useState<string>();
  const addTrigger = useRef<HTMLButtonElement>(null);
  const neighbors = useRef<string[]>([]);
  useEffect(() => {
    if (!removed) return;
    const timer = window.setTimeout(() => setRemoved(undefined), 5000);
    return () => window.clearTimeout(timer);
  }, [removed]);
  const close = () => setPanel({ kind: "none" });
  const removedServer = (entry: MCPAgentServer) => {
    close();
    setDismissed(true);
    setRemoved(m.mcp_removed({ server: entry.name }));
    requestAnimationFrame(() => {
      const next = neighbors.current.map((id) => document.getElementById(`mcp-server-${id}-details`)).find(Boolean);
      (next ?? addTrigger.current)?.focus({ preventScroll: true });
    });
  };
  const locate = (id: string) => {
    close();
    setHighlight(id);
    requestAnimationFrame(() => {
      const row = document.getElementById(`mcp-server-${id}`);
      row?.scrollIntoView({ block: "nearest" });
      row?.focus({ preventScroll: true });
    });
  };
  const connect = async (entry: MCPAgentServer, token?: string, definition?: MCPServer) => {
    setDismissed(true);
    const result = await connection.connect(entry, token, definition);
    if (result === "key") setPanel({ kind: "authorize", entry });
    else if (result === "connected") locate(entry.mcpServerId);
  };
  const addedFromCatalog = (entry: MCPAgentServer, _catalog: McpCatalogEntry, definition?: MCPServer) => {
    setDismissed(true);
    locate(entry.mcpServerId);
    void connect(entry, undefined, definition);
  };
  useEffect(() => {
    if (!outcome?.mcpServerId || mounted.isPending) return;
    document.getElementById(`mcp-server-${outcome.mcpServerId}`)?.scrollIntoView({ block: "nearest" });
  }, [outcome, mounted.isPending]);
  const resultId = completed?.id ?? outcome?.mcpServerId;
  const result = servers.find((entry) => entry.mcpServerId === resultId);
  return (
    <section className="grid gap-6" aria-labelledby="mcp-page-title" data-ui="mcp-page">
      <PageHeader title={m.mcp_heading()} titleId="mcp-page-title" description={m.mcp_intro()}>
        <Button disabled={addDisabled} onClick={() => setPanel({ kind: "discover" })}>
          <Icon name="integrations" />
          {m.mcp_discover_action()}
        </Button>
        <Button ref={addTrigger} variant="secondary" disabled={addDisabled} onClick={() => setPanel({ kind: "add" })}>
          <Icon name="plus" />
          {m.mcp_create_action()}
        </Button>
      </PageHeader>
      {showCompletion(dismissed, completed, returnContext, outcome) ? (
        <McpCompletion
          result={result}
          outcome={outcome}
          completed={completed}
          agentName={agentName}
          agentId={agentId}
          onDismiss={() => setDismissed(true)}
        />
      ) : null}
      {mounted.isError ? (
        <div className="grid gap-3">
          <Banner variant="error">{actionError(mounted.error, m.common_request_failed())}</Banner>
          <div>
            <Button variant="secondary" onClick={() => void mounted.refetch()}>
              {m.mcp_retry()}
            </Button>
          </div>
        </div>
      ) : null}
      {mounted.isPending ? (
        <Loader />
      ) : servers.length ? (
        <ul
          className="ui-surface grid divide-y divide-kumo-line overflow-hidden bg-kumo-base"
          data-ui="mcp-server-list"
        >
          {servers.map((entry) => (
            <McpRow
              key={entry.mcpServerId}
              entry={entry}
              agentId={agentId}
              agentName={agentName}
              highlighted={highlight === entry.mcpServerId}
              connecting={connection.connectingId === entry.mcpServerId}
              connectionError={
                panel.kind === "authorize"
                  ? undefined
                  : (connection.errorFor(entry.mcpServerId) ??
                    returnedConnectionError(returnContext, outcome, entry.mcpServerId, dismissed))
              }
              onRetry={() => void connect(entry)}
              onAction={(kind) => {
                if (kind === "authorize") {
                  void connect(entry);
                  return;
                }
                connection.clearFailure();
                const index = servers.indexOf(entry);
                neighbors.current = [...servers.slice(index + 1), ...servers.slice(0, index).reverse()].map(
                  (server) => server.mcpServerId,
                );
                setPanel({ kind, entry });
              }}
            />
          ))}
        </ul>
      ) : !mounted.isError ? (
        <McpQuickStart onDiscover={(entry) => setPanel({ kind: "discover", entry })} />
      ) : null}
      {removed ? (
        <p role="status" className="text-sm text-kumo-subtle">
          {removed}
        </p>
      ) : null}
      <McpPanel
        panel={panel}
        agentId={agentId}
        agentName={agentName}
        servers={servers}
        onClose={close}
        onLocate={locate}
        onRemoved={removedServer}
        onCatalogAdded={addedFromCatalog}
        connecting={Boolean(connection.connectingId)}
        connectionError={panel.kind === "authorize" ? connection.errorFor(panel.entry.mcpServerId) : undefined}
        onConnect={(entry, token) => void connect(entry, token)}
        onCredentialChange={connection.clearFailure}
        onCompleted={(entry, auth) => {
          setCompleted({ id: entry.mcpServerId, authorized: auth });
          setDismissed(false);
          setHighlight(entry.mcpServerId);
          close();
        }}
      />
    </section>
  );
}
function McpCompletion({
  result,
  outcome,
  completed,
  agentName,
  agentId,
  onDismiss,
}: {
  result?: MCPAgentServer;
  outcome: ReturnType<typeof readMcpOAuthOutcome>;
  completed?: { id: string; authorized: boolean };
  agentName: string;
  agentId: string;
  onDismiss: () => void;
}) {
  const authorized = completed?.authorized || outcome?.outcome.kind === "success";
  const ready =
    result?.enabled &&
    result.authorization?.status === "active" &&
    result.authorization.probeState === "succeeded" &&
    (result.authorization.toolsCount ?? 0) > 0;
  const message = completionMessage(result, outcome?.outcome.kind === "error", Boolean(authorized), agentName);
  return (
    <div role="status" className="flex items-start justify-between gap-4 border-b border-kumo-line pb-5">
      <div className="grid gap-2 text-sm">
        <p>{message}</p>
        {ready ? <McpUseGuidance agentId={agentId} agentName={agentName} server={result.name} /> : null}
      </div>
      <Button aria-label={m.mcp_completion_dismiss()} variant="ghost" shape="square" size="compact" onClick={onDismiss}>
        <Icon name="close" />
      </Button>
    </div>
  );
}
function completionMessage(result: MCPAgentServer | undefined, failed: boolean, authorized: boolean, agent: string) {
  if (!result) return failed ? m.mcp_authorize_failed() : m.mcp_authorization_status_active();
  if (failed) return m.mcp_completion_oauth_failed({ server: result.name });
  return authorized
    ? m.mcp_completion_authorized({ server: result.name, agent })
    : m.mcp_completion_added({ server: result.name, agent });
}
function McpPanel({
  panel,
  agentId,
  agentName,
  servers,
  onClose,
  onLocate,
  onCompleted,
  onRemoved,
  onCatalogAdded,
  connecting,
  connectionError,
  onConnect,
  onCredentialChange,
}: {
  panel: Panel;
  connecting: boolean;
  connectionError?: string;
  onConnect: (entry: MCPAgentServer, token: string) => void;
  onCredentialChange: () => void;
  agentId: string;
  agentName: string;
  servers: MCPAgentServer[];
  onClose: () => void;
  onLocate: (id: string) => void;
  onCompleted: (entry: MCPAgentServer, authorized: boolean) => void;
  onRemoved: (entry: MCPAgentServer) => void;
  onCatalogAdded: (entry: MCPAgentServer, catalog: McpCatalogEntry, server?: MCPServer) => void;
}) {
  if (panel.kind === "none") return null;
  if (panel.kind === "discover")
    return (
      <McpDiscoverDialog
        agentId={agentId}
        agentName={agentName}
        mounted={servers}
        initialEntry={panel.entry}
        onClose={onClose}
        onAdded={onCatalogAdded}
      />
    );
  if (panel.kind === "add")
    return (
      <McpAddDialog
        agentId={agentId}
        agentName={agentName}
        mounted={servers}
        initialServerId={panel.serverId}
        initialError={panel.authenticationError}
        onClose={onClose}
        onAdded={(entry) => onCompleted(entry, false)}
        onLocate={onLocate}
      />
    );
  if (!("entry" in panel)) return null;
  // A tool browser follows new snapshots after refresh; edit drafts retain their opening baseline.
  const current = servers.find((entry) => entry.mcpServerId === panel.entry.mcpServerId) ?? panel.entry;
  const props = { agentId, agentName, entry: current, onClose };
  switch (panel.kind) {
    case "authorize":
      return (
        <McpConnectDialog
          entry={current}
          busy={connecting}
          error={connectionError}
          onChange={onCredentialChange}
          onClose={() => {
            onCredentialChange();
            onLocate(current.mcpServerId);
          }}
          onConnect={(token) => onConnect(current, token)}
        />
      );
    case "edit":
      return (
        <McpSettingsDialog
          {...props}
          onRemoved={() => onRemoved(current)}
          initialAuthentication={Boolean(panel.authenticationError)}
          authenticationError={panel.authenticationError}
        />
      );
    case "tools":
      return (
        <McpSettingsDialog
          {...props}
          onRemoved={() => onRemoved(current)}
          initialTools
          initialQuery={panel.context?.query}
          initialScrollTop={panel.context?.scrollTop}
          initialAuthentication={Boolean(panel.authenticationError)}
          authenticationError={panel.authenticationError}
        />
      );
  }
}
function McpRow({
  agentId,
  agentName,
  entry,
  highlighted,
  onAction,
  connecting,
  connectionError,
  onRetry,
}: {
  agentId: string;
  agentName: string;
  entry: MCPAgentServer;
  highlighted: boolean;
  onAction: (action: ServerAction) => void;
  connecting: boolean;
  connectionError?: string;
  onRetry: () => void;
}) {
  const update = useUpdateMcpBinding(agentId);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const run = async (operation: () => Promise<unknown>, fallback: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(actionError(cause, fallback));
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <McpServerCard
      entry={entry}
      agentName={agentName}
      highlighted={highlighted}
      connecting={connecting}
      onAction={onAction}
      onToggle={() =>
        void run(
          () => update.mutateAsync({ mcpServerId: entry.mcpServerId, enabled: !entry.enabled }),
          m.mcp_edit_failed(),
        )
      }
      onProbe={onRetry}
      probing={connecting}
      toggling={update.isPending}
      error={error}
      connectionError={connectionError}
    />
  );
}

function McpUseGuidance({ agentId, agentName, server }: { agentId: string; agentName: string; server: string }) {
  const channel = useQuery({ queryKey: queryKeys.agents.imBinding(agentId), queryFn: () => readImBinding(agentId) });
  const binding = channel.data;
  const connected = !channel.isError && binding?.bindingState === "active";
  return (
    <>
      {connected ? (
        <p className="text-kumo-subtle">
          {m.mcp_completion_channel({ agent: agentName, server, channel: messagingProviderLabel(binding.provider) })}
        </p>
      ) : null}
      {!channel.isError && channel.isSuccess && !binding ? (
        <p className="text-kumo-subtle">{m.mcp_completion_connect({ agent: agentName })}</p>
      ) : null}
      <Link {...agentSettingsSectionLink(agentId, "messaging")} className="text-xs underline underline-offset-4">
        {m.mcp_completion_settings()}
      </Link>
    </>
  );
}

function hideReturnedCompletion(context: McpReturnContext | undefined, failed: boolean) {
  return Boolean(
    context && ((context.source !== "add" && context.source !== "authorize") || (context.source === "add" && failed)),
  );
}

function returnedConnectionError(
  context: McpReturnContext | undefined,
  outcome: ReturnType<typeof readMcpOAuthOutcome>,
  id: string,
  dismissed: boolean,
): string | undefined {
  if (!dismissed && context?.source === "authorize" && outcome?.outcome.kind === "error" && outcome.mcpServerId === id)
    return m.mcp_oauth_return_failed();
}
function showReturnedCompletion(
  context: McpReturnContext | undefined,
  outcome: ReturnType<typeof readMcpOAuthOutcome>,
): boolean {
  return Boolean(outcome && context?.source !== "authorize");
}

function showCompletion(
  dismissed: boolean,
  completed: unknown,
  context: McpReturnContext | undefined,
  outcome: ReturnType<typeof readMcpOAuthOutcome>,
): boolean {
  return !dismissed && Boolean(completed || showReturnedCompletion(context, outcome));
}
