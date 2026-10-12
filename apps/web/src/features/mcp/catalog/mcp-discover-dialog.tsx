import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES, type McpCatalogEntry } from "@opentag/mcp-presets";
import { useEffect, useRef, useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { Banner, Button, Dialog, Loader } from "../../../ui/design-system.js";
import { actionError } from "../mcp-form-model.js";
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
      onClose={props.onClose}
      onBack={preview ? back : undefined}
      title={preview ? `${localizedText(preview.title)} · ${m.mcp_catalog_limited_access()}` : m.mcp_discover_action()}
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
      <div hidden={Boolean(preview) || state.account.isPending || state.account.isError}>
        {state.error ? (
          <div className="mb-4">
            <Banner variant="error">{state.error}</Banner>
          </div>
        ) : null}
        <McpDiscoverSource
          categories={MCP_CATALOG_CATEGORIES}
          entries={MCP_CATALOG_ENTRIES}
          servers={state.servers}
          mounted={props.mounted}
          busy={state.busy}
          pendingEntryId={state.pendingEntryId}
          searchRef={searchRef}
          onAdd={openEntry}
        />
      </div>
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
