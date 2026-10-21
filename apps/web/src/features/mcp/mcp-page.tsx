import type { McpInstallableCatalogEntry } from "@opentag/mcp-presets";
import { MCP_ERROR_CODES, type MCPAgentServer, type MCPServer } from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import { PageHeader } from "../../components/kumo/page-header/page-header.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, Icon, Loader, Text } from "../../ui/design-system.js";
import { useMcpCatalogConnection } from "./catalog/mcp-catalog-connection.js";
import { McpDiscoverDialog } from "./catalog/mcp-discover-dialog.js";
import { useMcpDiscoverState } from "./catalog/mcp-discover-state.js";
import { McpAddDialog } from "./mcp-add-dialog.js";
import { actionError } from "./mcp-form-model.js";
import { readMcpOAuthOutcome } from "./mcp-oauth-outcome.js";
import { type McpOAuthSession, useMcpOAuthSessions } from "./mcp-oauth-session.js";
import { publishMcpOAuthWindowReturn, readMcpOAuthWindowReturn } from "./mcp-oauth-window.js";
import { useAgentMcpServers, useDetachMcpServer, useUpdateMcpBinding } from "./mcp-queries.js";
import { consumeMcpReturn, consumePendingMcpSetupReturn, type McpReturnContext } from "./mcp-return-context.js";
import { McpServerCard, type ServerAction } from "./mcp-server-card.js";
import { McpConfirmDialog } from "./mcp-server-dialogs.js";
import { McpSettingsDialog } from "./mcp-settings-dialog.js";
import { discardMcpSetup } from "./mcp-setup-cleanup.js";
import { mcpTitle } from "./mcp-title.js";

type Panel =
  | { kind: "none" }
  | { kind: "add"; serverId?: string; authenticationError?: string }
  | {
      kind: "discover";
      entry?: McpInstallableCatalogEntry;
      context?: McpReturnContext;
      outcome?: "cancelled" | "failed";
    }
  | {
      kind: ServerAction | "tools";
      entry: MCPAgentServer;
      context?: McpReturnContext;
      authenticationError?: string;
    };
/** One Agent's connections; runtime access remains determined by the server's actual authorization. */
export function McpPage({ agentId }: { agentId: string }) {
  const [returned] = useState(() => readMcpOAuthWindowReturn(agentId));
  useEffect(() => {
    if (returned) publishMcpOAuthWindowReturn(returned);
  }, [returned]);
  if (returned)
    return (
      <p role="status">
        {returned.result.outcome.kind === "success" ? m.mcp_oauth_completed() : m.mcp_oauth_cancelled()}
      </p>
    );
  return <McpManagementPage agentId={agentId} />;
}
function McpManagementPage({ agentId }: { agentId: string }) {
  const identity = useQuery({ queryKey: queryKeys.agents.detail(agentId), queryFn: () => browserApi.agent(agentId) });
  const agentName = identity.data?.displayName ?? agentId;
  const mounted = useAgentMcpServers(agentId);
  const detach = useDetachMcpServer(agentId);
  const servers = mounted.data?.servers ?? [];
  const detailOAuth = useMcpOAuthSessions(agentId);
  const connection = useMcpCatalogConnection(agentId, detailOAuth);
  const [detailFailures, setDetailFailures] = useState<Record<string, string | undefined>>({});
  const addDisabled = mounted.isPending || mounted.isError || Boolean(connection.connectingId);
  const [{ outcome, returnContext }] = useState(() => {
    const outcome = readMcpOAuthOutcome();
    return {
      outcome,
      returnContext: outcome ? consumeMcpReturn(agentId, outcome.mcpServerId) : consumePendingMcpSetupReturn(agentId),
    };
  });
  const restored = useRef(false);
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  useEffect(() => {
    if (panel.kind === "edit" && !servers.some((entry) => entry.mcpServerId === panel.entry.mcpServerId))
      setPanel({ kind: "none" });
  }, [panel, servers]);
  const [highlight, setHighlight] = useState(outcome?.outcome.kind === "success" ? outcome.mcpServerId : undefined);
  const pendingFocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = pendingFocus.current;
    if (panel.kind !== "none" || !id || !servers.some((entry) => entry.mcpServerId === id)) return;
    const row = document.getElementById(`mcp-server-${id}`);
    if (!row) return;
    const frame = requestAnimationFrame(() => {
      if (pendingFocus.current !== id || !row.isConnected) return;
      row.scrollIntoView({ block: "nearest" });
      row.focus({ preventScroll: true });
      pendingFocus.current = undefined;
    });
    return () => cancelAnimationFrame(frame);
  }, [panel, servers]);
  useEffect(() => {
    if (!highlight) return;
    const timer = window.setTimeout(() => setHighlight(undefined), 2500);
    return () => window.clearTimeout(timer);
  }, [highlight]);
  const [returnedFailure, setReturnedFailure] = useState(hasReturnedFailure(outcome, returnContext));
  useEffect(() => {
    if (!returnContext || returnContext.source === "add" || restored.current || mounted.isPending) return;
    if (returnContext.source === "discover") {
      restored.current = true;
      setPanel({ kind: "discover", context: returnContext, outcome: discoverReturnOutcome(outcome) });
      return;
    }
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
    if (outcome?.outcome.kind === "error" || !outcome) {
      const restoreAdd = () =>
        setPanel({ kind: "add", serverId: entry.mcpServerId, authenticationError: m.mcp_oauth_return_failed() });
      if (returnContext.newBinding) {
        void discardMcpSetup(agentId, entry.mcpServerId, (id) => detach.mutateAsync(id), returnContext.oauthState)
          .then(restoreAdd)
          .catch(() => {
            setPanel({ kind: "add", serverId: entry.mcpServerId, authenticationError: m.mcp_setup_cleanup_failed() });
          });
      } else restoreAdd();
    }
  }, [returnContext, outcome, mounted.isPending, servers, agentId, detach]);
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
    setRemoved(m.mcp_removed({ server: mcpTitle(entry) }));
    requestAnimationFrame(() => {
      const next = neighbors.current.map((id) => document.getElementById(`mcp-server-${id}-details`)).find(Boolean);
      (next ?? addTrigger.current)?.focus({ preventScroll: true });
    });
  };
  const locate = (id: string) => {
    pendingFocus.current = id;
    close();
    setHighlight(id);
  };
  const connect = async (entry: MCPAgentServer, token?: string, definition?: MCPServer, reauthorize = false) => {
    if (discover.connections[entry.mcpServerId]?.pending) return;
    discover.clearFailure(entry.mcpServerId);
    setDetailFailures((all) => ({ ...all, [entry.mcpServerId]: undefined }));
    if (entry.mcpServerId === outcome?.mcpServerId) setReturnedFailure(false);
    const result = await connection.connect(entry, token, definition, reauthorize);
    if (result === "key") setPanel({ kind: "authorize", entry });
  };
  const addedFromCatalog = (entry: MCPAgentServer, _catalog: McpInstallableCatalogEntry, _definition?: MCPServer) => {
    setDetailFailures((all) => ({ ...all, [entry.mcpServerId]: undefined }));
    if (connection.failure?.binding.mcpServerId === entry.mcpServerId) connection.clearFailure();
    setHighlight(entry.mcpServerId);
  };
  const discoverProps = {
    open: panel.kind === "discover",
    agentId,
    agentName,
    mounted: servers,
    oauthSessions: Object.fromEntries(servers.map((entry) => [entry.mcpServerId, detailOAuth(entry.mcpServerId)])),
    ...restoredDiscoverProps(returnContext, outcome),
    ...discoverPanelProps(panel),
    onClose: close,
    onAdded: addedFromCatalog,
  };
  const discover = useMcpDiscoverState(discoverProps);
  const sessionFor = (id: string) => {
    const session = discover.connections[id]?.oauth;
    return session?.phase ? session : detailOAuth(id);
  };
  const errorFor = (id: string) =>
    detailFailures[id] ??
    discover.connections[id]?.error ??
    connection.errorFor(id) ??
    returnedConnectionError(outcome, id, returnedFailure);
  useEffect(() => {
    if (!outcome?.mcpServerId || mounted.isPending) return;
    document.getElementById(`mcp-server-${outcome.mcpServerId}`)?.scrollIntoView({ block: "nearest" });
  }, [outcome, mounted.isPending]);
  return (
    <section className="grid gap-6" aria-labelledby="mcp-page-title" data-ui="mcp-page">
      <PageHeader title={m.mcp_heading()} titleId="mcp-page-title" description={m.mcp_intro()}>
        <Button disabled={addDisabled} onClick={() => setPanel({ kind: "discover" })}>
          <Icon name="integrations" />
          {m.mcp_discover_action()}
        </Button>
        <AddServerButton buttonRef={addTrigger} disabled={addDisabled} onClick={() => setPanel({ kind: "add" })} />
      </PageHeader>
      {returnedFailure && mounted.isSuccess && !servers.some((entry) => entry.mcpServerId === outcome?.mcpServerId) ? (
        <Banner variant="error">{m.mcp_authorize_failed()}</Banner>
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
              connecting={
                connection.connectingId === entry.mcpServerId ||
                Boolean(discover.connections[entry.mcpServerId]?.pending) ||
                Boolean(detailOAuth(entry.mcpServerId).phase)
              }
              connectionError={errorFor(entry.mcpServerId)}
              oauthSession={sessionFor(entry.mcpServerId)}
              onAction={(kind) => {
                if (kind === "authorize" && entry.authorization?.kind === "oauth") {
                  void connect(entry, undefined, undefined, true);
                  return;
                }
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
        <div className="flex flex-col items-center gap-5 px-4 py-12 text-center sm:py-16" data-ui="mcp-empty-state">
          <Icon name="integrations" weight="light" className="size-8 text-kumo-inactive" />
          <div className="flex max-w-sm flex-col gap-2">
            <Text as="h2" size="lg" variant="heading">
              {m.mcp_empty_title()}
            </Text>
            <Text as="p" size="sm" variant="secondary">
              {m.mcp_empty()}
            </Text>
          </div>
        </div>
      ) : null}
      {removed ? (
        <p role="status" className="sr-only">
          {removed}
        </p>
      ) : null}
      <McpDiscoverDialog {...discoverProps} state={discover} />
      <McpPanel
        panel={panel}
        agentId={agentId}
        agentName={agentName}
        servers={servers}
        onClose={close}
        onLocate={locate}
        onRemoved={removedServer}
        sessionFor={sessionFor}
        errorFor={errorFor}
        onRetry={(entry) => void connect(entry)}
        onAuthenticationFeedback={(entry, label) => {
          setDetailFailures((all) => ({ ...all, [entry.mcpServerId]: label }));
          connection.clearFailure();
          discover.clearFailure(entry.mcpServerId);
          if (entry.mcpServerId === outcome?.mcpServerId) setReturnedFailure(false);
        }}
        retryingId={connection.connectingId}
        onCompleted={(entry) => locate(entry.mcpServerId)}
      />
    </section>
  );
}
function restoredDiscoverProps(context: McpReturnContext | undefined, outcome: ReturnType<typeof readMcpOAuthOutcome>) {
  return context?.source === "discover"
    ? { initialContext: context, initialOutcome: discoverReturnOutcome(outcome) }
    : {};
}
function discoverPanelProps(panel: Panel) {
  return panel.kind === "discover"
    ? { initialEntry: panel.entry, initialContext: panel.context, initialOutcome: panel.outcome }
    : {};
}
function AddServerButton({
  buttonRef,
  disabled,
  onClick,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      ref={buttonRef}
      variant="secondary"
      aria-label={m.mcp_create_action()}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name="plus" />
      {m.mcp_create_action()}
    </Button>
  );
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
  sessionFor,
  errorFor,
  onRetry,
  onAuthenticationFeedback,
  retryingId,
}: {
  panel: Panel;
  sessionFor: (id: string) => McpOAuthSession;
  errorFor: (id: string) => string | undefined;
  onRetry: (entry: MCPAgentServer) => void;
  onAuthenticationFeedback: (entry: MCPAgentServer, label?: string) => void;
  retryingId?: string;
  agentId: string;
  agentName: string;
  servers: MCPAgentServer[];
  onClose: () => void;
  onLocate: (id: string) => void;
  onCompleted: (entry: MCPAgentServer) => void;
  onRemoved: (entry: MCPAgentServer) => void;
}) {
  if (panel.kind === "none") return null;
  if (panel.kind === "discover") return null;
  if (panel.kind === "add")
    return (
      <McpAddDialog
        agentId={agentId}
        agentName={agentName}
        mounted={servers}
        initialServerId={panel.serverId}
        initialError={panel.authenticationError}
        onClose={onClose}
        onAdded={onCompleted}
        onLocate={onLocate}
      />
    );
  if (!("entry" in panel)) return null;
  // Dialogs follow saved connection updates; Settings rebases its own local drafts.
  const current = servers.find((entry) => entry.mcpServerId === panel.entry.mcpServerId) ?? panel.entry;
  const props = {
    agentId,
    agentName,
    entry: current,
    onClose,
    oauthSession: sessionFor(current.mcpServerId),
    connectionError: errorFor(current.mcpServerId),
    retrying: retryingId === current.mcpServerId,
    onRetry: () => onRetry(current),
    onAuthenticationFeedback: (label?: string) => onAuthenticationFeedback(current, label),
  };
  switch (panel.kind) {
    case "authorize":
      return <McpSettingsDialog {...props} initialAuthentication />;
    case "delete":
      return <McpConfirmDialog {...props} onConfirmed={() => onRemoved(current)} />;
    case "edit":
      return (
        <McpSettingsDialog
          {...props}
          initialAuthentication={Boolean(panel.authenticationError)}
          authenticationError={panel.authenticationError}
        />
      );
    case "tools":
      return (
        <McpSettingsDialog
          {...props}
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
  oauthSession,
}: {
  agentId: string;
  agentName: string;
  entry: MCPAgentServer;
  highlighted: boolean;
  onAction: (action: ServerAction) => void;
  connecting: boolean;
  connectionError?: string;
  oauthSession?: McpOAuthSession;
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
      toggling={update.isPending}
      error={error}
      connectionError={connectionError}
      oauthSession={oauthSession}
    />
  );
}

function hasReturnedFailure(outcome: ReturnType<typeof readMcpOAuthOutcome>, context: McpReturnContext | undefined) {
  return outcome?.outcome.kind === "error" && (context?.source ?? "authorize") === "authorize";
}

function discoverReturnOutcome(outcome: ReturnType<typeof readMcpOAuthOutcome>) {
  if (outcome?.outcome.kind === "success") return undefined;
  if (!outcome || outcome.outcome.code === MCP_ERROR_CODES.OAUTH_DENIED) return "cancelled" as const;
  return "failed" as const;
}

function returnedConnectionError(
  outcome: ReturnType<typeof readMcpOAuthOutcome>,
  id: string,
  returnedFailure: boolean,
): string | undefined {
  if (returnedFailure && outcome?.mcpServerId === id) return m.mcp_oauth_return_failed();
}
