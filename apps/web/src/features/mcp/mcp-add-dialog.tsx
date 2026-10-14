import type { MCPAgentServer } from "@opentag/shared/browser";
import { type RefObject, useEffect, useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Dialog, Field, Icon, KumoInputControl } from "../../ui/design-system.js";
import { useMcpAddConnection } from "./mcp-add-connection.js";
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
  const urlRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const size = state.needsKey ? "key" : "url";
  const connectLabel =
    state.phase === "tools" ? m.mcp_add_loading_tools() : state.busy ? m.mcp_add_connecting() : m.mcp_connect();
  return (
    <Dialog
      title={m.mcp_create_title()}
      className={`mcp-add-dialog mcp-add-size-${size} mcp-add-anchor-url`}
      busy={state.busy}
      initialFocusRef={urlRef}
      onClose={() => void state.close()}
    >
      <McpOAuthControls session={state.oauth} className="mb-4" />
      <form
        className="mcp-add-layout"
        onSubmit={(event) => {
          event.preventDefault();
          void state.connect(() => keyRef.current?.focus());
        }}
      >
        <div className="mcp-add-body">
          <Field htmlFor="mcp-add-url" label={m.mcp_add_url_label()} hideLabel>
            <KumoInputControl
              ref={urlRef}
              id="mcp-add-url"
              className="w-full"
              value={state.url}
              disabled={state.busy}
              placeholder={m.mcp_add_url_placeholder()}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={state.urlInvalid}
              aria-describedby={state.needsKey ? undefined : "mcp-add-feedback"}
              onChange={(event) => state.changeUrl(event.target.value)}
              onBlur={state.validateUrl}
            />
          </Field>
          <div className="mcp-add-secondary">
            {state.needsKey ? <AddKeyField state={state} keyRef={keyRef} /> : null}
            <AddFeedback state={state} />
          </div>
        </div>
        <footer className="mcp-add-footer">
          <Button
            className="mcp-add-connect"
            type="submit"
            disabled={!state.canConnect}
            loading={state.busy}
            aria-label={connectLabel}
          >
            {connectLabel}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}

type AddState = ReturnType<typeof useMcpAddConnection>;
function AddFeedback({ state }: { state: AddState }) {
  const error = state.urlInvalid ? m.mcp_add_url_error() : state.error;
  return (
    <div id="mcp-add-feedback" className="mcp-add-feedback" aria-live="polite">
      {state.definitions.isError ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-kumo-subtle">{m.mcp_add_load_failed()}</span>
          <Button variant="ghost" size="compact" disabled={state.busy} onClick={() => void state.definitions.refetch()}>
            {m.mcp_retry()}
          </Button>
        </div>
      ) : error ? (
        <p role="alert" className="text-sm text-kumo-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
function AddKeyField({ state, keyRef }: { state: AddState; keyRef: RefObject<HTMLInputElement | null> }) {
  const [keyVisible, setKeyVisible] = useState(false);
  useEffect(() => {
    keyRef.current?.focus();
  }, [keyRef]);
  return (
    <Field htmlFor="mcp-add-key" label={m.mcp_add_key_label()}>
      <div className="relative">
        <KumoInputControl
          ref={keyRef}
          id="mcp-add-key"
          className="w-full pr-10"
          type={keyVisible ? "text" : "password"}
          value={state.key}
          disabled={state.busy}
          autoComplete="off"
          aria-describedby="mcp-add-feedback"
          onChange={(event) => state.changeKey(event.target.value)}
        />
        <Button
          shape="square"
          size="compact"
          variant="ghost"
          className="absolute right-1 top-1"
          disabled={state.busy}
          aria-label={keyVisible ? m.mcp_hide_key() : m.mcp_show_key()}
          aria-pressed={keyVisible}
          onClick={() => setKeyVisible(!keyVisible)}
        >
          <Icon name={keyVisible ? "eye-slash" : "eye"} />
        </Button>
      </div>
    </Field>
  );
}
