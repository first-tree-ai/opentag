import type { MCPAgentServer } from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import { PageHeader } from "../../components/kumo/page-header/page-header.js";
import { messagingProviderLabel } from "../../im/provider-label.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, Empty, Icon, Loader } from "../../ui/design-system.js";
import { readImBinding } from "../agents/agent-queries.js";
import { agentSettingsSectionLink } from "../agents/agent-routes.js";
import { McpAddDialog } from "./mcp-add-dialog.js";
import { McpAuthorizeDialog } from "./mcp-authorize-dialog.js";
import { actionError } from "./mcp-form-model.js";
import { readMcpOAuthOutcome } from "./mcp-oauth-outcome.js";
import { useAgentMcpServers, useProbeMcpServer, useUpdateMcpBinding } from "./mcp-queries.js";
import { McpServerCard, type ServerAction } from "./mcp-server-card.js";
import { McpConfirmDialog, McpDetailsDialog } from "./mcp-server-dialogs.js";
import { McpSettingsDialog } from "./mcp-settings-dialog.js";
import { McpToolsDialog } from "./mcp-tools-dialog.js";

type Panel = { kind: "none" | "add" } | { kind: ServerAction; entry: MCPAgentServer };
/** One Agent's connections; runtime access remains determined by the server's actual authorization. */
export function McpPage({ agentId }: { agentId: string }) {
  const identity = useQuery({ queryKey: queryKeys.agents.detail(agentId), queryFn: () => browserApi.agent(agentId) });
  const agentName = identity.data?.displayName ?? agentId;
  const mounted = useAgentMcpServers(agentId);
  const servers = mounted.data?.servers ?? [];
  const [outcome] = useState(() => readMcpOAuthOutcome());
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const [highlight, setHighlight] = useState(outcome?.mcpServerId);
  const [completed, setCompleted] = useState<{ id: string; authorized: boolean }>();
  const [dismissed, setDismissed] = useState(false);
  const close = () => setPanel({ kind: "none" });
  const locate = (id: string) => {
    close();
    setHighlight(id);
    requestAnimationFrame(() => {
      const row = document.getElementById(`mcp-server-${id}`);
      row?.scrollIntoView({ block: "nearest" });
      row?.focus({ preventScroll: true });
    });
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
        <Button
          variant="secondary"
          disabled={mounted.isPending || mounted.isError}
          onClick={() => setPanel({ kind: "add" })}
        >
          <Icon name="plus" />
          {m.mcp_create_action()}
        </Button>
      </PageHeader>
      {!dismissed && (completed || outcome) ? (
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
        <ul className="grid gap-3" data-ui="mcp-server-list">
          {servers.map((entry) => (
            <McpRow
              key={entry.mcpServerId}
              entry={entry}
              agentId={agentId}
              agentName={agentName}
              highlighted={highlight === entry.mcpServerId}
              onAction={(kind) => setPanel({ kind, entry })}
            />
          ))}
        </ul>
      ) : !mounted.isError ? (
        <Empty
          title={m.mcp_empty_title()}
          description={m.mcp_empty()}
          icon={<Icon name="integrations" />}
          contents={
            <Button variant="secondary" onClick={() => setPanel({ kind: "add" })}>
              <Icon name="plus" />
              {m.mcp_create_action()}
            </Button>
          }
        />
      ) : null}
      <McpPanel
        panel={panel}
        agentId={agentId}
        agentName={agentName}
        servers={servers}
        onClose={close}
        onLocate={locate}
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
}: {
  panel: Panel;
  agentId: string;
  agentName: string;
  servers: MCPAgentServer[];
  onClose: () => void;
  onLocate: (id: string) => void;
  onCompleted: (entry: MCPAgentServer, authorized: boolean) => void;
}) {
  if (panel.kind === "none") return null;
  if (panel.kind === "add")
    return (
      <McpAddDialog
        agentId={agentId}
        agentName={agentName}
        mounted={servers}
        onClose={onClose}
        onAdded={(entry) => onCompleted(entry, false)}
        onLocate={onLocate}
      />
    );
  if (!("entry" in panel)) return null;
  // A tool browser follows new snapshots after refresh; edit drafts retain their opening baseline.
  const current = servers.find((entry) => entry.mcpServerId === panel.entry.mcpServerId) ?? panel.entry;
  const props = { agentId, agentName, entry: panel.entry, onClose };
  switch (panel.kind) {
    case "authorize":
      return <McpAuthorizeDialog {...props} onAuthorized={() => onCompleted(panel.entry, true)} />;
    case "edit":
      return <McpSettingsDialog {...props} />;
    case "tools":
      return <McpToolsDialog {...props} entry={current} />;
    case "details":
      return <McpDetailsDialog entry={current} onClose={onClose} />;
    case "remove":
    case "revoke":
      return <McpConfirmDialog {...props} kind={panel.kind} />;
  }
}
function McpRow({
  agentId,
  agentName,
  entry,
  highlighted,
  onAction,
}: {
  agentId: string;
  agentName: string;
  entry: MCPAgentServer;
  highlighted: boolean;
  onAction: (action: ServerAction) => void;
}) {
  const update = useUpdateMcpBinding(agentId);
  const probe = useProbeMcpServer(agentId);
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
      onAction={onAction}
      onToggle={() =>
        void run(
          () => update.mutateAsync({ mcpServerId: entry.mcpServerId, enabled: !entry.enabled }),
          m.mcp_edit_failed(),
        )
      }
      onProbe={() => void run(() => probe.mutateAsync(entry.mcpServerId), m.mcp_probe_failed())}
      probing={probe.isPending}
      toggling={update.isPending}
      error={error}
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
