import type { MCPAgentServer } from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import { Button, Dialog, Field, KumoInputControl } from "../../ui/design-system.js";
import { useMcpAddConnection } from "./mcp-add-connection.js";
import { McpConfigurationFields } from "./mcp-configuration-fields.js";
import { McpAuthFields } from "./mcp-form.js";
import { McpOAuthControls } from "./mcp-oauth-controls.js";
import "./mcp.css";

export type McpAddProps = {
  agentId: string;
  agentName: string;
  mounted: readonly MCPAgentServer[];
  initialServerId?: string;
  initialError?: string;
  onClose: () => void;
  onAdded: (entry: MCPAgentServer) => void;
  onLocate: (id: string) => void;
};

export function McpAddDialog(props: McpAddProps) {
  const state = useMcpAddConnection(props);
  const keyError = state.authentication.kind === "bearer" && state.needsKey ? state.error : undefined;
  const connectionError = !keyError && !state.urlInvalid ? state.error : undefined;
  return (
    <Dialog
      title={m.mcp_create_title()}
      className="mcp-form-dialog mcp-add-dialog"
      busy={state.busy && !state.oauth.phase}
      onClose={() => void state.close()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void state.connect(() => undefined);
        }}
        className="grid gap-5"
      >
        <fieldset disabled={state.busy} className="mcp-fields border-0 p-0">
          <Field htmlFor="mcp-add-url" label={m.mcp_settings_address()}>
            <KumoInputControl
              id="mcp-add-url"
              aria-label={m.mcp_settings_address()}
              value={state.url}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={state.urlInvalid}
              aria-describedby={state.urlInvalid ? "mcp-add-url-error" : undefined}
              onChange={(event) => state.changeUrl(event.target.value)}
              onBlur={state.validateUrl}
            />
            {state.urlInvalid ? (
              <p id="mcp-add-url-error" role="alert" className="text-sm text-kumo-danger">
                {m.mcp_add_url_error()}
              </p>
            ) : null}
          </Field>
          <div className="grid gap-2">
            <McpAuthFields draft={state.authentication} onChange={state.changeAuthentication} disabled={state.busy} />
            {keyError && !state.urlInvalid ? (
              <p role="alert" className="text-sm text-kumo-danger">
                {keyError}
              </p>
            ) : null}
          </div>
          <McpConfigurationFields
            draft={state.configuration}
            kind={state.authentication.kind}
            onChange={state.changeConfiguration}
            address={false}
          />
        </fieldset>
        <McpOAuthControls session={state.oauth} />
        {connectionError ? (
          <p role="alert" className="text-sm text-kumo-danger">
            {connectionError}
          </p>
        ) : null}
        {state.definitions.isError ? (
          <div className="flex items-center gap-3 text-sm text-kumo-danger">
            {m.mcp_add_load_failed()}
            <Button variant="ghost" size="compact" onClick={() => void state.definitions.refetch()}>
              {m.mcp_retry()}
            </Button>
          </div>
        ) : null}
        <ConnectionFooter state={state} />
      </form>
    </Dialog>
  );
}

function ConnectionFooter({ state }: { state: ReturnType<typeof useMcpAddConnection> }) {
  if (state.oauth.phase) return null;
  const label = state.phase === "tools" ? m.mcp_add_loading_tools() : m.mcp_connect();
  return (
    <footer className="flex justify-end">
      <Button aria-label={label} type="submit" disabled={!state.canConnect} loading={state.busy}>
        {label}
      </Button>
    </footer>
  );
}
