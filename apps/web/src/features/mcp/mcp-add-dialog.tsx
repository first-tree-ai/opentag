import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPServer } from "@opentag/shared/browser";
import { type RefObject, useEffect, useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Dialog, Field, Icon, KumoInputControl } from "../../ui/design-system.js";
import { findCatalogEntryByUrl, localizedText } from "./catalog/mcp-catalog-model.js";
import { useMcpAddConnection } from "./mcp-add-connection.js";
import { McpServiceIcon } from "./mcp-service-icon.js";
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
  const connectLabel =
    state.phase === "tools" ? m.mcp_add_loading_tools() : state.busy ? m.mcp_add_connecting() : m.mcp_connect();
  return (
    <Dialog title={m.mcp_create_title()} className="mcp-add-dialog" busy={state.busy} onClose={props.onClose}>
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
              aria-describedby="mcp-add-url-error"
              onChange={(event) => state.changeUrl(event.target.value)}
              onBlur={state.validateUrl}
            />
          </Field>
          <p id="mcp-add-url-error" className="mcp-add-field-error text-sm text-kumo-danger" aria-live="polite">
            {state.urlInvalid ? m.mcp_add_url_error() : ""}
          </p>
          <div className="mcp-add-secondary">
            <AddSecondary state={state} keyRef={keyRef} />
          </div>
        </div>
        <div className="mcp-add-feedback" aria-live="polite">
          {state.error ? (
            <p role="alert" className="text-sm text-kumo-danger">
              {state.error}
            </p>
          ) : null}
          {state.account.isError && !state.account.data ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-kumo-subtle">{m.mcp_add_load_failed()}</span>
              <Button variant="ghost" size="compact" disabled={state.busy} onClick={() => void state.account.refetch()}>
                {m.mcp_retry()}
              </Button>
            </div>
          ) : null}
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
function AddSecondary({ state, keyRef }: { state: AddState; keyRef: RefObject<HTMLInputElement | null> }) {
  if (state.needsKey) return <AddKeyField state={state} keyRef={keyRef} />;
  if (state.account.isPending)
    return (
      <div className="mcp-add-skeleton" aria-label={m.mcp_add_loading()} role="status">
        <span />
        <span />
        <span />
      </div>
    );
  return state.servers.length ? <ServicePicker state={state} /> : null;
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
function ServicePicker({ state }: { state: AddState }) {
  const [allOpen, setAllOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const recent = state.servers.slice(0, 4);
  const selected = state.servers.find((server) => server.id === state.selectedId);
  const shortcuts =
    selected && !recent.some((server) => server.id === selected.id) ? [selected, ...recent.slice(0, 3)] : recent;
  const filtered = state.servers.filter((server) =>
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
        <span className="text-sm text-kumo-subtle">{m.mcp_add_previous()}</span>
        {state.servers.length > 4 || allOpen ? (
          <Button
            variant="ghost"
            size="compact"
            disabled={state.busy}
            aria-expanded={allOpen}
            aria-controls="mcp-add-server-choices"
            onClick={() => {
              setAllOpen(!allOpen);
              setSearch("");
              if (!allOpen) requestAnimationFrame(() => searchRef.current?.focus());
            }}
          >
            {allOpen ? m.mcp_add_show_recent() : m.mcp_add_view_all({ count: state.servers.length })}
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
                  added={state.isAdded(server.id)}
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
                added={state.isAdded(server.id)}
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
  added,
  busy,
  expanded = false,
  onChoose,
}: {
  server: MCPServer;
  selected: boolean;
  added: boolean;
  busy: boolean;
  expanded?: boolean;
  onChoose: (server: MCPServer) => void;
}) {
  const preset = findCatalogEntryByUrl(server.url, MCP_CATALOG_ENTRIES);
  return (
    <Button
      variant="secondary"
      size="compact"
      className={expanded ? "mcp-add-server-row" : "mcp-add-tag"}
      disabled={busy || added}
      aria-pressed={selected}
      onClick={() => onChoose(server)}
    >
      <McpServiceIcon src={preset?.iconIsOfficial ? preset.iconUrl : undefined} size={24} />
      <span className="mcp-add-server-copy">
        <span>{serverTitle(server)}</span>
        {expanded ? <span className="text-xs text-kumo-subtle">{server.url}</span> : null}
      </span>
      {added ? (
        <span className="text-xs text-kumo-subtle">{m.mcp_add_already_added()}</span>
      ) : (
        <span className="inline-flex size-3.5 shrink-0" aria-hidden="true">
          <Icon name="check" className={selected ? "size-3.5" : "size-3.5 invisible"} />
        </span>
      )}
    </Button>
  );
}
