import type { MCPAgentServer } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import { formatDateTime } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { Button, Dialog } from "../../ui/design-system.js";
import { McpFooter } from "./mcp-form.js";
import { actionError } from "./mcp-form-model.js";
import { useDetachMcpServer, useRevokeMcpAuthorization } from "./mcp-queries.js";

export function McpConfirmDialog({
  kind,
  agentId,
  agentName,
  entry,
  onClose,
  onConfirmed,
}: {
  kind: "remove" | "revoke";
  agentId: string;
  agentName: string;
  entry: MCPAgentServer;
  onClose: () => void;
  onConfirmed?: () => void;
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
      (onConfirmed ?? onClose)();
    } catch (cause) {
      setError(removing ? m.mcp_remove_retry({ server: entry.name }) : actionError(cause, m.mcp_revoke_failed()));
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
      title={
        removing ? m.mcp_detach_title({ server: entry.name }) : m.mcp_clear_credentials_title({ server: entry.name })
      }
    >
      <div className="grid gap-3">
        <p className="text-sm leading-relaxed text-kumo-subtle">
          {removing
            ? m.mcp_remove_description({ server: entry.name, agent: agentName })
            : m.mcp_clear_credentials_help({ agent: agentName })}
        </p>
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-kumo-danger">
          {error}
        </p>
      ) : null}
      <McpFooter busy={busy} onClose={onClose}>
        <Button
          aria-label={removing ? m.mcp_remove_action() : m.mcp_clear_credentials_submit()}
          disabled={busy}
          loading={busy}
          variant="danger"
          onClick={() => void submit()}
        >
          {removing ? m.mcp_remove_action() : m.mcp_clear_credentials_submit()}
        </Button>
      </McpFooter>
    </Dialog>
  );
}
export function McpServerInformation({ entry }: { entry: MCPAgentServer }) {
  const authorization = entry.authorization;
  return (
    <div className="grid gap-4 text-sm">
      <p className="whitespace-pre-wrap leading-relaxed text-kumo-subtle">
        {entry.description ?? entry.discoveredDescription ?? m.mcp_details_no_description()}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3">
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
    </div>
  );
}
