import { MCP_CATALOG_CATEGORIES, type McpInstallableCatalogEntry } from "@opentag/mcp-presets";
import { useEffect, useRef, useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { Banner, Button, Dialog, Field, KumoInputControl, Loader } from "../../../ui/design-system.js";
import { actionError } from "../mcp-form-model.js";
import { mcpTitle } from "../mcp-title.js";
import { McpDiscoverSource } from "./mcp-discover-source.js";
import type { DiscoverProps, useMcpDiscoverState } from "./mcp-discover-state.js";

export function McpDiscoverDialog(
  props: DiscoverProps & { state: DiscoverState; initialEntry?: McpInstallableCatalogEntry },
) {
  const { state } = props;
  const openEntry = (entry: McpInstallableCatalogEntry) => {
    if (state.catalogBusy) return;
    void state.addFromCatalog(entry);
  };
  const started = useRef(false);
  useEffect(() => {
    if (props.open === false || !props.initialEntry || state.loading || state.definitions.isError || started.current)
      return;
    started.current = true;
    // The entry as this deployment serves it, so a replaced endpoint applies here too.
    const initialId = props.initialEntry.id;
    openEntry(state.catalog.entries.find((entry) => entry.id === initialId) ?? props.initialEntry);
  });
  if (props.open === false) return null;
  return (
    <Dialog
      busy={state.keySetup ? state.keyBusy : false}
      onClose={state.keySetup ? () => void state.cancelKey() : props.onClose}
      showCloseButton={!state.keySetup}
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
          aria-describedby={state.error ? "mcp-discover-key-error" : undefined}
          value={token}
          disabled={state.keyBusy}
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>
      {state.error ? (
        <p id="mcp-discover-key-error" role="alert" className="text-sm text-kumo-danger">
          {state.error}
        </p>
      ) : null}
      <footer className="flex justify-end gap-2">
        <Button variant="ghost" disabled={state.keyBusy} onClick={() => void state.cancelKey()}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" disabled={state.keyBusy || !token.trim()} loading={state.keyBusy}>
          {m.mcp_auth_save()}
        </Button>
      </footer>
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
  openEntry: (entry: McpInstallableCatalogEntry) => void;
}) {
  const catalogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.keySetup) return;
    const root = catalogRef.current;
    const scroller = window.matchMedia("(max-width: 600px)").matches
      ? root?.closest<HTMLElement>(".ui-dialog")
      : root?.querySelector<HTMLElement>('[data-ui="mcp-catalog"]');
    if (!scroller) return;
    if (!state.loading) scroller.scrollTop = state.view.current.scrollTop;
    const save = () => {
      state.view.current.scrollTop = scroller.scrollTop;
    };
    scroller.addEventListener("scroll", save);
    return () => scroller.removeEventListener("scroll", save);
  }, [state.loading, state.view, state.keySetup]);
  return (
    <div
      ref={catalogRef}
      onScrollCapture={(event) => {
        if (!state.keySetup && event.target instanceof HTMLElement && event.target.matches('[data-ui="mcp-catalog"]'))
          state.view.current.scrollTop = event.target.scrollTop;
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
        feedback={state.feedback}
        initialView={state.view.current}
        onViewChange={(view) => {
          state.view.current = { ...view, scrollTop: 0 };
        }}
      />
    </div>
  );
}
