import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPServer } from "@opentag/shared/browser";
import { type RefObject, useEffect, useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Dialog, Field, Icon, KumoInputControl } from "../../ui/design-system.js";
import { findCatalogEntryByUrl, localizedText } from "./catalog/mcp-catalog-model.js";
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

export function serverTitle(server: MCPServer): string {
  const preset = findCatalogEntryByUrl(server.url, MCP_CATALOG_ENTRIES);
  return preset && preset.name === server.name ? localizedText(preset.title) : server.name;
}

export function McpAddDialog(props: McpAddProps) {
  const state = useMcpAddConnection(props);
  const keyRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Keep the picker stable when an in-progress connection creates a binding or live queries refresh.
  const [mountedIds] = useState(() => new Set(props.mounted.map((entry) => entry.mcpServerId)));
  const servers = state.servers.filter((server) => !mountedIds.has(server.id));
  const size = state.needsKey ? "key" : pickerOpen && servers.length ? "picker" : servers.length ? "single" : "url";
  // The page preloads the pool; explicit steps can resize downward without moving the opening anchor.
  const [anchor] = useState(size);
  const connectLabel =
    state.phase === "tools" ? m.mcp_add_loading_tools() : state.busy ? m.mcp_add_connecting() : m.mcp_connect();
  return (
    <Dialog
      title={m.mcp_create_title()}
      className={`mcp-add-dialog mcp-add-size-${size} mcp-add-anchor-${anchor}`}
      busy={state.busy}
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
          <Field htmlFor="mcp-add-url" label={m.mcp_add_url_label()}>
            <KumoInputControl
              id="mcp-add-url"
              className="w-full"
              value={state.url}
              disabled={state.busy}
              placeholder="https://mcp.example.com/mcp"
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
            <AddSecondary
              state={state}
              servers={servers}
              keyRef={keyRef}
              pickerOpen={pickerOpen}
              setPickerOpen={setPickerOpen}
            />
          </div>
        </div>
        <footer className="mcp-add-footer">
          <Button variant="ghost" disabled={state.busy} onClick={() => void state.close()}>
            {m.common_cancel()}
          </Button>
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
function AddSecondary({
  state,
  servers,
  keyRef,
  pickerOpen,
  setPickerOpen,
}: {
  state: AddState;
  servers: readonly MCPServer[];
  keyRef: RefObject<HTMLInputElement | null>;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
}) {
  return (
    <>
      {state.needsKey ? <AddKeyField state={state} keyRef={keyRef} /> : null}
      <AddFeedback state={state} />
      {state.needsKey ? null : state.account.isPending ? (
        <div className="mcp-add-skeleton" aria-label={m.mcp_add_loading()} role="status">
          <span />
        </div>
      ) : servers.length ? (
        <ServicePicker state={state} servers={servers} open={pickerOpen} onOpenChange={setPickerOpen} />
      ) : null}
    </>
  );
}
function AddFeedback({ state }: { state: AddState }) {
  const error = state.urlInvalid ? m.mcp_add_url_error() : state.error;
  const loadFailed = state.account.isError && !state.account.data;
  return (
    <div id="mcp-add-feedback" className="mcp-add-feedback" aria-live="polite">
      {loadFailed ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-kumo-subtle">{m.mcp_add_load_failed()}</span>
          <Button variant="ghost" size="compact" disabled={state.busy} onClick={() => void state.account.refetch()}>
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
function ServicePicker({
  state,
  servers,
  open,
  onOpenChange,
}: {
  state: AddState;
  servers: readonly MCPServer[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = servers.find((server) => server.id === state.selectedId);
  const choose = (server: MCPServer) => {
    state.choose(server);
    onOpenChange(false);
    triggerRef.current?.focus();
  };
  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="compact"
        className="mcp-add-picker-trigger"
        disabled={state.busy}
        aria-expanded={open}
        aria-controls={open ? "mcp-add-server-choices" : undefined}
        onClick={() => onOpenChange(!open)}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} className="size-3.5 shrink-0" />
        <span
          className={`mcp-add-picker-label${selected ? " mcp-add-picker-selected" : ""}`}
          title={selected ? m.mcp_add_selected({ name: serverTitle(selected) }) : undefined}
        >
          {selected
            ? m.mcp_add_selected({ name: serverTitle(selected) })
            : m.mcp_add_choose_configured({ count: servers.length })}
        </span>
      </Button>
      {open ? (
        <div id="mcp-add-server-choices" className="mcp-add-results">
          {servers.map((server) => (
            <ServerChoice
              key={server.id}
              server={server}
              selected={server.id === state.selectedId}
              busy={state.busy}
              onChoose={choose}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function ServerChoice({
  server,
  selected,
  busy,
  onChoose,
}: {
  server: MCPServer;
  selected: boolean;
  busy: boolean;
  onChoose: (server: MCPServer) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="compact"
      className="mcp-add-server-row"
      disabled={busy}
      aria-pressed={selected}
      onClick={() => onChoose(server)}
    >
      <span className="mcp-add-server-copy">
        <span className="mcp-add-server-name">{serverTitle(server)}</span>
        <span className="text-xs text-kumo-subtle">{server.url}</span>
      </span>
    </Button>
  );
}
