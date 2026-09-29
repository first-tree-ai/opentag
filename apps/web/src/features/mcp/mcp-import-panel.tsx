import type { MCPAgentServer } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Field, Icon, KumoInputAreaControl } from "../../ui/design-system.js";
import {
  isImportable,
  type MCPImportOutcome,
  type MCPImportReason,
  type MCPImportServer,
  parseMcpImport,
} from "./mcp-import-model.js";

/**
 * The Add dialog's import method: paste a configuration fragment or a CLI command, read it, and pick
 * one remote Server out of what it holds.
 *
 * The paste is read in the browser and never uploaded. Unsupported entries are listed rather than
 * hidden, and nothing is created here — the dialog decides what a chosen Server becomes and owns the
 * create/attach/authorize sequence.
 */

export type McpImportState = {
  paste: string;
  setPaste: (value: string) => void;
  outcome?: MCPImportOutcome;
  /** True while a paste is being read, so the panel can disable its own controls. */
  parsing: boolean;
  /** Read the current paste. A read-only step: it creates nothing. */
  analyze: () => Promise<void>;
};

/**
 * `takenNames` is read inside `analyze` only, so a caller may pass a freshly derived list each render
 * without re-running anything.
 */
export function useMcpImport(takenNames: readonly string[]): McpImportState {
  const [paste, setPasteState] = useState("");
  const [outcome, setOutcome] = useState<MCPImportOutcome>();
  const [parsing, setParsing] = useState(false);
  const pasteRef = useRef("");
  const parsingRef = useRef(false);
  /** Bumped by every edit, so a read that started against older text cannot land as the current one. */
  const generationRef = useRef(0);
  /**
   * The listed servers describe one exact text. Keeping them across an edit would leave the previous
   * Server — and the previous credential — selectable while the field shows something else, so an
   * edit clears them and invalidates whatever read is still running.
   */
  const setPaste = (value: string) => {
    generationRef.current += 1;
    pasteRef.current = value;
    setPasteState(value);
    setOutcome(undefined);
  };
  const analyze = async () => {
    if (parsingRef.current) return;
    const generation = generationRef.current;
    const text = pasteRef.current;
    if (!text.trim()) return;
    parsingRef.current = true;
    setParsing(true);
    try {
      const result = await parseMcpImport({ text, takenNames });
      if (generation === generationRef.current) setOutcome(result);
    } finally {
      parsingRef.current = false;
      setParsing(false);
    }
  };
  return { paste, setPaste, outcome, parsing, analyze };
}

export function McpImportPanel({
  state,
  agentName,
  mounted,
  onChoose,
  onLocate,
}: {
  state: McpImportState;
  agentName: string;
  mounted: MCPAgentServer[];
  onChoose: (server: MCPImportServer) => void;
  onLocate: (id: string) => void;
}) {
  const { paste, setPaste, outcome, parsing, analyze } = state;
  const detected = outcome?.servers ?? [];
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void analyze();
        }}
      >
        <Field htmlFor="mcp-import-text" label={m.mcp_import_label()} hint={m.mcp_import_help()}>
          <KumoInputAreaControl
            id="mcp-import-text"
            rows={6}
            spellCheck={false}
            value={paste}
            placeholder={m.mcp_import_placeholder()}
            onChange={(event) => setPaste(event.target.value)}
          />
        </Field>
        <div className="mt-3">
          <Button type="submit" variant="secondary" disabled={parsing || !paste.trim()} loading={parsing}>
            {m.mcp_import_parse()}
          </Button>
        </div>
      </form>
      {outcome ? (
        <div className="mt-6">
          <p role="status" className="text-sm text-kumo-subtle">
            {importMessage(outcome)}
          </p>
          {detected.length ? (
            <ul className="mt-2 divide-y divide-kumo-line border-y border-kumo-line">
              {detected.map((entry) => (
                <ImportRow
                  key={`${entry.sourceName} ${entry.name}`}
                  entry={entry}
                  agentName={agentName}
                  mountedId={mounted.find((mount) => mount.effective.url === entry.url)?.mcpServerId}
                  onChoose={() => onChoose(entry)}
                  onLocate={onLocate}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function ImportRow({
  entry,
  agentName,
  mountedId,
  onChoose,
  onLocate,
}: {
  entry: MCPImportServer;
  agentName: string;
  mountedId: string | undefined;
  onChoose: () => void;
  onLocate: (id: string) => void;
}) {
  const copy = <ImportCopy entry={entry} agentName={agentName} added={mountedId !== undefined} />;
  if (!isImportable(entry))
    return (
      <li className="min-w-0 py-4">
        <ImportCopy entry={entry} agentName={agentName} />
        <span className="mt-1 block text-xs text-kumo-subtle">{importReason(entry.reason)}</span>
      </li>
    );
  if (mountedId)
    return (
      <li className="flex items-center gap-3">
        <div className="min-w-0 flex-1 py-4">{copy}</div>
        <Button size="compact" variant="ghost" onClick={() => onLocate(mountedId)}>
          {m.mcp_view_existing()}
        </Button>
      </li>
    );
  return (
    <li className="flex items-center gap-3">
      <Button variant="ghost" type="button" className="mcp-choice" onClick={onChoose}>
        {copy}
        <Icon className="size-3.5 shrink-0 text-kumo-subtle" name="chevron-right" />
      </Button>
    </li>
  );
}

function ImportCopy({
  entry,
  agentName,
  added = false,
}: {
  entry: MCPImportServer;
  agentName: string;
  added?: boolean;
}) {
  return (
    <span className="grid min-w-0 gap-1">
      <strong className="text-sm font-medium">{entry.name}</strong>
      <span className="wrap-anywhere text-xs text-kumo-subtle">{entry.url ?? entry.sourceName}</span>
      {entry.credential ? <span className="text-xs text-kumo-subtle">{m.mcp_import_credential()}</span> : null}
      {entry.refusedHeaders.length ? (
        <span className="text-xs text-kumo-subtle">
          {m.mcp_import_refused_headers({ headers: entry.refusedHeaders.join(", ") })}
        </span>
      ) : null}
      {added ? <span className="text-xs text-kumo-subtle">{m.mcp_added_to({ agent: agentName })}</span> : null}
    </span>
  );
}

function importMessage(outcome: MCPImportOutcome): string {
  switch (outcome.kind) {
    case "parsed": {
      const count = outcome.servers.filter(isImportable).length;
      return count === 1 ? m.mcp_import_found_one() : m.mcp_import_found({ count });
    }
    case "unsupported-only":
      // A paste may mix local entries with ones OpenTag could not classify, or hold only the latter.
      // Announcing "only local MCP servers" would be wrong for those, so the local wording is used
      // only when every listed entry really is local; the rows name their own reason either way.
      return outcome.servers.every((server) => server.reason === "local-transport")
        ? m.mcp_import_unsupported_only()
        : m.mcp_import_no_remote();
    case "invalid-url":
      return m.mcp_import_invalid_url();
    case "no-servers":
      return m.mcp_import_no_servers();
    case "too-large":
      return m.mcp_import_too_large();
    default:
      return m.mcp_import_unparseable();
  }
}

function importReason(reason: MCPImportReason | undefined): string {
  if (reason === "local-transport") return m.mcp_import_local();
  if (reason === "invalid-url") return m.mcp_import_entry_url_invalid();
  return m.mcp_import_unrecognized();
}
