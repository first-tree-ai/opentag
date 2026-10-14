import { MCP_CATALOG_CATEGORIES, type McpCatalogEntry } from "@opentag/mcp-presets";
import { useEffect, useRef, useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { Banner, Button, Dialog, Field, KumoInputControl, Loader } from "../../../ui/design-system.js";
import { actionError } from "../mcp-form-model.js";
import { mcpTitle } from "../mcp-title.js";
import { McpDiscoverSource } from "./mcp-discover-source.js";
import { type DiscoverProps, useMcpDiscoverState } from "./mcp-discover-state.js";

export function McpDiscoverDialog(props: DiscoverProps & { initialEntry?: McpCatalogEntry }) {
  const state = useMcpDiscoverState(props);
  const openEntry = (entry: McpCatalogEntry) => {
    if (state.catalogBusy) return;
    void state.addFromCatalog(entry);
  };
  const started = useRef(false);
  useEffect(() => {
    if (!props.initialEntry || state.loading || state.definitions.isError || started.current) return;
    started.current = true;
    // The entry as this deployment serves it, so a replaced endpoint applies here too.
    const initialId = props.initialEntry.id;
    openEntry(state.catalog.entries.find((entry) => entry.id === initialId) ?? props.initialEntry);
  });
  return (
    <Dialog
      busy={state.keySetup ? state.keyBusy : state.busy}
      onClose={state.keySetup ? () => void state.cancelKey() : props.onClose}
      onBack={state.keySetup ? () => void state.cancelKey() : undefined}
      title={discoverTitle(state)}
      className="mcp-discover-dialog"
    >
      {state.loading ? <Loader /> : null}
      {state.definitions.isError ? (
        <div className="grid gap-3">
          <Banner variant="error">{actionError(state.definitions.error, m.common_request_failed())}</Banner>
          <Button variant="secondary" onClick={() => void state.definitions.refetch()}>
            {m.mcp_retry()}
          </Button>
        </div>
      ) : null}
      <DiscoverCatalog state={state} props={props} openEntry={openEntry} />
      <DiscoverKeyForm state={state} />
    </Dialog>
  );
}

type DiscoverState = ReturnType<typeof useMcpDiscoverState>;
function discoverTitle(state: DiscoverState) {
  if (state.keySetup) return m.mcp_authentication_title({ server: mcpTitle(state.keySetup.binding) });
  return m.mcp_discover_action();
}
function DiscoverKeyForm({ state }: { state: DiscoverState }) {
  const keyRef = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState("");
  useEffect(() => {
    setToken("");
    if (state.keySetup) keyRef.current?.focus();
  }, [state.keySetup]);
  const setup = state.keySetup;
  if (!setup) return null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void state.addFromCatalog(setup.catalog, token);
      }}
      className="grid gap-3"
    >
      <Field htmlFor="mcp-discover-key" label={m.mcp_authorize_bearer_label()}>
        <KumoInputControl
          ref={keyRef}
          id="mcp-discover-key"
          type="password"
          autoComplete="off"
          value={token}
          disabled={state.keyBusy}
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>
      {state.error ? <Banner variant="error">{state.error}</Banner> : null}
      <Button type="submit" disabled={state.keyBusy || !token.trim()} loading={state.keyBusy}>
        {m.mcp_connect()}
      </Button>
      <Button variant="ghost" disabled={state.keyBusy} onClick={() => void state.cancelKey()}>
        {m.common_cancel()}
      </Button>
    </form>
  );
}
function DiscoverCatalog({
  state,
  props,
  openEntry,
}: {
  state: DiscoverState;
  props: DiscoverProps;
  openEntry: (entry: McpCatalogEntry) => void;
}) {
  const catalogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = catalogRef.current?.closest<HTMLElement>(".ui-dialog");
    if (!scroller) return;
    if (!state.loading && props.initialContext?.scrollTop) scroller.scrollTop = props.initialContext.scrollTop;
    const save = () => {
      state.view.current.scrollTop = scroller.scrollTop;
    };
    scroller.addEventListener("scroll", save);
    return () => scroller.removeEventListener("scroll", save);
  }, [props.initialContext, state.loading, state.view]);
  return (
    <div
      ref={catalogRef}
      onScroll={(event) => {
        state.view.current.scrollTop = event.currentTarget.scrollTop;
      }}
      hidden={Boolean(state.keySetup) || state.loading || state.definitions.isError}
    >
      {state.error && !state.keySetup ? (
        <div role="alert" className="mb-4">
          <Banner variant="error">{state.error}</Banner>
        </div>
      ) : null}
      <McpDiscoverSource
        categories={MCP_CATALOG_CATEGORIES}
        entries={state.catalog.entries}
        servers={state.servers}
        mounted={props.mounted}
        busy={state.catalogBusy}
        pending={state.pending}
        onAdd={openEntry}
        connectedIds={state.connectedIds}
        feedback={state.feedback}
        initialView={state.view.current}
        onViewChange={(view) => {
          state.view.current = { ...state.view.current, ...view };
        }}
      />
    </div>
  );
}
