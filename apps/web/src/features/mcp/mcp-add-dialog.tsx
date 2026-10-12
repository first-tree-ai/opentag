import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPServer } from "@opentag/shared/browser";
import { type RefObject, useEffect, useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Dialog, Field, Icon, KumoInputControl } from "../../ui/design-system.js";
import { findCatalogEntryByUrl, localizedText } from "./catalog/mcp-catalog-model.js";
import { useMcpAddConnection } from "./mcp-add-connection.js";
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
  // Keep the picker stable when an in-progress connection creates a binding or live queries refresh.
  const [mountedIds] = useState(() => new Set(props.mounted.map((entry) => entry.mcpServerId)));
  const servers = state.servers.filter((server) => !mountedIds.has(server.id));
  const size = state.needsKey
    ? "key"
    : servers.length > 2
      ? "multiple"
      : servers.length === 2
        ? "pair"
        : servers.length
          ? "single"
          : "url";
  // The page preloads the pool; explicit steps can resize downward without moving the opening anchor.
  const [anchor] = useState(size);
  const connectLabel =
    state.phase === "tools" ? m.mcp_add_loading_tools() : state.busy ? m.mcp_add_connecting() : m.mcp_connect();
  return (
    <Dialog
      title={m.mcp_create_title()}
      className={`mcp-add-dialog mcp-add-size-${size} mcp-add-anchor-${anchor}`}
      busy={state.busy}
      onClose={props.onClose}
    >
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
            <AddSecondary state={state} servers={servers} keyRef={keyRef} />
          </div>
        </div>
        <footer className="mcp-add-footer">
          <Button variant="ghost" disabled={state.busy} onClick={props.onClose}>
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
}: {
  state: AddState;
  servers: readonly MCPServer[];
  keyRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <>
      {state.needsKey ? <AddKeyField state={state} keyRef={keyRef} /> : null}
      <AddFeedback state={state} />
      {state.needsKey ? null : state.account.isPending ? (
        <div className="mcp-add-skeleton" aria-label={m.mcp_add_loading()} role="status">
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : servers.length ? (
        <ServicePicker state={state} servers={servers} />
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
function ServicePicker({ state, servers }: { state: AddState; servers: readonly MCPServer[] }) {
  const [allOpen, setAllOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const recent = servers.slice(0, 4);
  const selected = servers.find((server) => server.id === state.selectedId);
  const shortcuts =
    selected && !recent.slice(0, 2).includes(selected)
      ? [selected, ...recent.filter((server) => server.id !== selected.id).slice(0, 3)]
      : recent;
  const filtered = servers.filter((server) =>
    `${serverTitle(server)} ${server.url}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const choose = (server: MCPServer) => {
    state.choose(server);
    setAllOpen(false);
    setSearch("");
  };
  return (
    <>
      <div className="mcp-add-servers-heading">
        <span className="text-xs text-kumo-subtle">{m.mcp_add_previous()}</span>
        {servers.length > 2 || allOpen ? (
          <Button
            variant="ghost"
            size="compact"
            className={servers.length <= 4 && !allOpen ? "mcp-add-mobile-all" : undefined}
            disabled={state.busy}
            aria-expanded={allOpen}
            aria-controls="mcp-add-server-choices"
            onClick={() => {
              setAllOpen(!allOpen);
              setSearch("");
              if (!allOpen) requestAnimationFrame(() => searchRef.current?.focus());
            }}
          >
            {allOpen ? m.mcp_add_show_recent() : m.mcp_add_view_all({ count: servers.length })}
          </Button>
        ) : null}
      </div>
      <div id="mcp-add-server-choices" className="mcp-add-choices">
        {allOpen ? (
          <>
            <KumoInputControl
              ref={searchRef}
              className="w-full shrink-0"
              aria-label={m.mcp_account_search()}
              placeholder={m.mcp_account_search()}
              value={search}
              disabled={state.busy}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="mcp-add-results">
              {filtered.map((server) => (
                <ServerChoice
                  key={server.id}
                  server={server}
                  selected={server.id === state.selectedId}
                  busy={state.busy}
                  expanded
                  onChoose={choose}
                />
              ))}
              {!filtered.length ? (
                <p className="text-sm text-kumo-subtle" role="status">
                  {m.mcp_add_no_results()}
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <div className="mcp-add-tags">
            {shortcuts.map((server) => (
              <ServerChoice
                key={server.id}
                server={server}
                selected={server.id === state.selectedId}
                busy={state.busy}
                onChoose={choose}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ServerChoice({
  server,
  selected,
  busy,
  expanded = false,
  onChoose,
}: {
  server: MCPServer;
  selected: boolean;
  busy: boolean;
  expanded?: boolean;
  onChoose: (server: MCPServer) => void;
}) {
  return (
    <Button
      variant="secondary"
      size="compact"
      className={expanded ? "mcp-add-server-row" : "mcp-add-tag"}
      disabled={busy}
      aria-pressed={selected}
      onClick={() => onChoose(server)}
    >
      <span className="mcp-add-server-copy">
        <span className="mcp-add-server-name" title={expanded ? undefined : serverTitle(server)}>
          {serverTitle(server)}
        </span>
        {expanded ? <span className="text-xs text-kumo-subtle">{server.url}</span> : null}
      </span>
    </Button>
  );
}
