import type { MCPAgentServer } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Dialog } from "../../ui/design-system.js";
import { useDetachMcpServer } from "./mcp-queries.js";
import { deleteMcpInstallation } from "./mcp-setup-cleanup.js";
import { mcpTitle } from "./mcp-title.js";

export function McpConfirmDialog({
  agentId,
  entry,
  onClose,
  onConfirmed,
}: {
  agentId: string;
  entry: MCPAgentServer;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const detach = useDetachMcpServer(agentId);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await deleteMcpInstallation(agentId, entry.mcpServerId, detach.mutateAsync);
      onConfirmed();
    } catch {
      setError(m.mcp_remove_retry({ server: mcpTitle(entry) }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      className="mcp-confirm-dialog"
      role="alertdialog"
      showCloseButton={false}
      busy={busy}
      description={m.mcp_remove_description({ server: mcpTitle(entry) })}
      initialFocusRef={cancelRef}
      onClose={onClose}
      title={m.mcp_detach_title({ server: mcpTitle(entry) })}
    >
      {error ? (
        <p role="alert" className="mt-4 text-sm text-kumo-danger">
          {error}
        </p>
      ) : null}
      <footer className="mcp-confirm-actions">
        <Button ref={cancelRef} disabled={busy} variant="secondary" onClick={onClose}>
          {m.common_cancel()}
        </Button>
        <Button
          aria-label={m.mcp_remove_action()}
          disabled={busy}
          loading={busy}
          variant="danger"
          onClick={() => void submit()}
        >
          {m.mcp_remove_action()}
        </Button>
      </footer>
    </Dialog>
  );
}
