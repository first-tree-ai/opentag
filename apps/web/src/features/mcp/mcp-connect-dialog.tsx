import type { MCPAgentServer } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Dialog, Field, KumoInputControl } from "../../ui/design-system.js";
import { McpDialogTitle } from "./mcp-dialog-title.js";

/** Ordinary bearer connection collects only the Agent credential; method edits belong to Settings. */
export function McpConnectDialog({
  entry,
  busy,
  error,
  onClose,
  onConnect,
  onChange,
}: {
  entry: MCPAgentServer;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onConnect: (token: string) => void;
  onChange: () => void;
}) {
  const [token, setToken] = useState("");
  const keyRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      className="mcp-form-dialog mcp-auth-dialog"
      title={<McpDialogTitle entry={entry} title={m.mcp_authentication_title({ server: entry.name })} />}
      closeLabel={m.common_close_title({ title: m.mcp_authentication_title({ server: entry.name }) })}
      initialFocusRef={keyRef}
      busy={busy}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && token.trim()) onConnect(token);
        }}
      >
        <div className="mcp-settings-body">
          <Field htmlFor="mcp-connect-key" label={m.mcp_authorize_bearer_label()}>
            <KumoInputControl
              id="mcp-connect-key"
              ref={keyRef}
              className="w-full"
              type="password"
              autoComplete="off"
              value={token}
              disabled={busy}
              aria-describedby={error ? "mcp-connect-error" : undefined}
              onChange={(event) => {
                setToken(event.target.value);
                onChange();
              }}
            />
          </Field>
          {error ? (
            <p id="mcp-connect-error" role="alert" className="mt-3 text-sm text-kumo-danger">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="mcp-settings-footer">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button type="submit" disabled={busy || !token.trim()} loading={busy}>
            {m.mcp_connect()}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
