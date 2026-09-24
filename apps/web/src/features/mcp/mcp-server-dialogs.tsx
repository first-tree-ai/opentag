import type { MCPAgentServer } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import { formatDateTime } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog, Icon } from "../../ui/design-system.js";
import { McpDefaultsDialog } from "./mcp-defaults-dialog.js";
import { McpFooter } from "./mcp-form.js";
import { actionError } from "./mcp-form-model.js";
import { useDetachMcpServer, useRevokeMcpAuthorization } from "./mcp-queries.js";

export function McpConfirmDialog({
  kind,
  agentId,
  agentName,
  entry,
  onClose,
}: {
  kind: "remove" | "revoke";
  agentId: string;
  agentName: string;
  entry: MCPAgentServer;
  onClose: () => void;
}) {
  const detach = useDetachMcpServer(agentId);
  const revoke = useRevokeMcpAuthorization(agentId);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const removing = kind === "remove";
  const busy = detach.isPending || revoke.isPending;
  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(undefined);
    try {
      if (removing) await detach.mutateAsync(entry.mcpServerId);
      else await revoke.mutateAsync(entry.mcpServerId);
      onClose();
    } catch (cause) {
      setError(actionError(cause, removing ? m.mcp_remove_failed() : m.mcp_revoke_failed()));
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Dialog
      className="mcp-confirm-dialog"
      role="alertdialog"
      busy={busy}
      onClose={onClose}
      title={removing ? m.mcp_detach_title({ server: entry.name }) : m.mcp_revoke_title({ server: entry.name })}
    >
      <div className="grid gap-3">
        {error ? <Banner variant="error">{error}</Banner> : null}
        <p className="text-sm leading-relaxed text-kumo-subtle">
          {removing ? m.mcp_remove_description({ server: entry.name, agent: agentName }) : m.mcp_revoke_description()}
        </p>
        {removing ? <p className="text-xs text-kumo-subtle">{m.mcp_remove_kept()}</p> : null}
      </div>
      <McpFooter busy={busy} onClose={onClose}>
        <Button disabled={busy} loading={busy} variant="danger" onClick={() => void submit()}>
          {removing ? m.mcp_remove_action() : m.mcp_revoke_action()}
        </Button>
      </McpFooter>
    </Dialog>
  );
}
export function McpDetailsDialog({ entry, onClose }: { entry: MCPAgentServer; onClose: () => void }) {
  const [shared, setShared] = useState(false);
  if (shared) return <McpDefaultsDialog serverId={entry.mcpServerId} onClose={() => setShared(false)} />;
  const authorization = entry.authorization;
  return (
    <Dialog className="mcp-form-dialog" title={m.mcp_details_title({ server: entry.name })} onClose={onClose}>
      <p className="wrap-anywhere mb-6 whitespace-pre-wrap text-sm leading-relaxed text-kumo-subtle">
        {entry.description ?? entry.discoveredDescription ?? m.mcp_details_no_description()}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
        <dt className="text-kumo-subtle">{m.mcp_auth_label()}</dt>
        <dd>
          {authorization?.kind === "oauth"
            ? m.mcp_auth_oauth()
            : authorization?.kind === "bearer"
              ? m.mcp_auth_token()
              : authorization
                ? m.mcp_auth_none()
                : m.mcp_authorization_required()}
        </dd>
        {authorization?.accessTokenExpiresAt ? (
          <>
            <dt className="text-kumo-subtle">{m.mcp_details_expires()}</dt>
            <dd>{formatDateTime(authorization.accessTokenExpiresAt)}</dd>
          </>
        ) : null}
        {authorization?.probeState === "succeeded" && authorization.probedAt ? (
          <>
            <dt className="text-kumo-subtle">{m.mcp_details_last_loaded()}</dt>
            <dd>{formatDateTime(authorization.probedAt)}</dd>
          </>
        ) : null}
        {entry.snapshot?.protocolVersion ? (
          <>
            <dt className="text-kumo-subtle">{m.mcp_details_protocol()}</dt>
            <dd>{entry.snapshot.protocolVersion}</dd>
          </>
        ) : null}
      </dl>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-4">
        <Button variant="ghost" size="compact" onClick={() => setShared(true)}>
          {m.mcp_defaults_action()}
          <Icon name="arrow-right" />
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {m.common_close()}
        </Button>
      </div>
    </Dialog>
  );
}
