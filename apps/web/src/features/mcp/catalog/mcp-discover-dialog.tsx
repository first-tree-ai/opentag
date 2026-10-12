import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES, type McpCatalogEntry } from "@opentag/mcp-presets";
import { useEffect, useRef, useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { Banner, Button, Dialog, Field, KumoInputControl, Loader } from "../../../ui/design-system.js";
import { actionError } from "../mcp-form-model.js";
import { McpOAuthControls } from "../mcp-oauth-controls.js";
import { isCatalogPreview, localizedText } from "./mcp-catalog-model.js";
import { McpDiscoverSource } from "./mcp-discover-source.js";
import { type DiscoverProps, useMcpDiscoverState } from "./mcp-discover-state.js";

export function McpDiscoverDialog(props: DiscoverProps & { initialEntry?: McpCatalogEntry }) {
  const searchRef = useRef<HTMLInputElement>(null);
  const requirementsRef = useRef<HTMLParagraphElement>(null);
  const [preview, setPreview] = useState<McpCatalogEntry>();
  const state = useMcpDiscoverState(props);
  useEffect(() => {
    if (!preview && !state.account.isPending && !state.account.isError) searchRef.current?.focus();
  }, [preview, state.account.isPending, state.account.isError]);
  const openEntry = (entry: McpCatalogEntry) => {
    if (state.busy) return;
    if (isCatalogPreview(entry)) setPreview(entry);
    else void state.addFromCatalog(entry);
  };
  const started = useRef(false);
  useEffect(() => {
    if (!props.initialEntry || state.account.isPending || state.account.isError || started.current) return;
    started.current = true;
    openEntry(props.initialEntry);
  });
  const back = () => setPreview(undefined);
  return (
    <Dialog
      initialFocusRef={preview ? requirementsRef : searchRef}
      busy={state.busy}
      onClose={state.keySetup ? () => void state.cancelKey() : props.onClose}
      onBack={preview ? back : state.keySetup ? () => void state.cancelKey() : undefined}
      title={discoverTitle(preview, state)}
      className={preview ? "mcp-form-dialog" : "mcp-discover-dialog"}
    >
      {state.account.isPending ? <Loader /> : null}
      {state.account.isError ? (
        <div className="grid gap-3">
          <Banner variant="error">{actionError(state.account.error, m.common_request_failed())}</Banner>
          <Button variant="secondary" onClick={() => void state.account.refetch()}>
            {m.mcp_retry()}
          </Button>
        </div>
      ) : null}
      <DiscoverCatalog state={state} props={props} preview={preview} openEntry={openEntry} searchRef={searchRef} />
      <DiscoverKeyForm state={state} />
      {preview ? (
        <div className="grid gap-5">
          <p ref={requirementsRef} tabIndex={-1} className="text-sm leading-relaxed text-kumo-subtle outline-none">
            {m.mcp_preview_description()}
          </p>
          <a
            className="text-sm underline underline-offset-4"
            href="https://developers.google.com/workspace/drive/api/guides/configure-mcp-server"
            target="_blank"
            rel="noreferrer"
          >
            {m.mcp_preview_guide()}
          </a>
          <Button
            onClick={() => {
              setPreview(undefined);
              void state.addFromCatalog(preview);
            }}
          >
            {m.mcp_preview_continue()}
          </Button>
        </div>
      ) : null}
    </Dialog>
  );
}

type DiscoverState = ReturnType<typeof useMcpDiscoverState>;
function discoverTitle(preview: McpCatalogEntry | undefined, state: DiscoverState) {
  if (preview) return `${localizedText(preview.title)} · ${m.mcp_catalog_limited_access()}`;
  if (state.keySetup) return m.mcp_authentication_title({ server: state.keySetup.binding.name });
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
          disabled={state.busy}
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>
      {state.error ? <Banner variant="error">{state.error}</Banner> : null}
      <Button type="submit" disabled={state.busy || !token.trim()} loading={state.busy}>
        {m.mcp_connect()}
      </Button>
      <Button variant="ghost" disabled={state.busy} onClick={() => void state.cancelKey()}>
        {m.common_cancel()}
      </Button>
    </form>
  );
}
function DiscoverCatalog({
  state,
  props,
  preview,
  openEntry,
  searchRef,
}: {
  state: DiscoverState;
  props: DiscoverProps;
  preview?: McpCatalogEntry;
  openEntry: (entry: McpCatalogEntry) => void;
  searchRef: import("react").RefObject<HTMLInputElement | null>;
}) {
  const catalogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = catalogRef.current?.closest<HTMLElement>(".ui-dialog");
    if (!scroller) return;
    if (!state.account.isPending && props.initialContext?.scrollTop)
      scroller.scrollTop = props.initialContext.scrollTop;
    const save = () => {
      state.view.current.scrollTop = scroller.scrollTop;
    };
    scroller.addEventListener("scroll", save);
    return () => scroller.removeEventListener("scroll", save);
  }, [props.initialContext, state.account.isPending, state.view]);
  return (
    <div
      ref={catalogRef}
      onScroll={(event) => {
        state.view.current.scrollTop = event.currentTarget.scrollTop;
      }}
      hidden={Boolean(preview) || Boolean(state.keySetup) || state.account.isPending || state.account.isError}
    >
      {state.error && !state.keySetup ? (
        <div role="alert" className="mb-4">
          <Banner variant="error">{state.error}</Banner>
        </div>
      ) : null}
      <McpOAuthControls session={state.oauth} className="mb-4" />
      {state.notice ? (
        <p role="status" className="mb-4 text-sm text-kumo-subtle">
          {state.notice}
        </p>
      ) : null}
      {state.busy && !state.oauth.phase && !state.checking ? <p role="status">{m.mcp_connecting()}</p> : null}
      {state.checking ? <p role="status">{m.mcp_oauth_checking()}</p> : null}
      <McpDiscoverSource
        categories={MCP_CATALOG_CATEGORIES}
        entries={MCP_CATALOG_ENTRIES}
        servers={state.servers}
        mounted={props.mounted}
        busy={state.busy}
        pendingEntryId={state.pendingEntryId}
        pendingAction={state.pendingAction}
        searchRef={searchRef}
        onAdd={openEntry}
        connectedIds={state.connectedIds}
        initialView={state.view.current}
        onViewChange={(view) => {
          state.view.current = { ...state.view.current, ...view };
        }}
      />
    </div>
  );
}
