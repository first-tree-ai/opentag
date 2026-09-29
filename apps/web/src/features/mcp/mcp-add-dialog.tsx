import {
  CreateMCPServerRequestSchema,
  type MCPAgentServer,
  type MCPServer,
  MCPServerNameSchema,
  MCPServerUrlSchema,
} from "@opentag/shared/browser";
import { useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import {
  Banner,
  Button,
  Dialog,
  Field,
  Icon,
  KumoInputAreaControl,
  KumoInputControl,
  Loader,
} from "../../ui/design-system.js";
import { useMcpAuthorization, validAuth } from "./mcp-authorize-dialog.js";
import { McpAuthFields, McpFooter } from "./mcp-form.js";
import {
  actionError,
  authDraft,
  defaultConnection,
  headersFromRows,
  headersKey,
  suggestServerName,
} from "./mcp-form-model.js";
import {
  isImportable,
  type MCPImportOutcome,
  type MCPImportReason,
  type MCPImportServer,
  parseMcpImport,
} from "./mcp-import-model.js";
import { useAttachMcpServer, useCreateMcpServer, useMcpServers } from "./mcp-queries.js";

type AddProps = {
  agentId: string;
  agentName: string;
  mounted: MCPAgentServer[];
  onClose: () => void;
  onAdded: (entry: MCPAgentServer) => void;
  onLocate: (id: string) => void;
};
function useAddServer({ agentId, onAdded }: AddProps) {
  const account = useMcpServers();
  const servers = account.data?.servers ?? [];
  const create = useCreateMcpServer(agentId);
  const attach = useAttachMcpServer(agentId);
  const authorize = useMcpAuthorization(agentId);
  const [step, setStep] = useState<"choose" | "configure">("choose");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MCPServer>();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const nameEdited = useRef(false);
  const [draft, setDraft] = useState(() => authDraft());
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<MCPServer>();
  const [attached, setAttached] = useState<MCPAgentServer>();
  const createdRef = useRef<MCPServer>(undefined);
  const attachedRef = useRef<MCPAgentServer>(undefined);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [intake, setIntake] = useState<"search" | "import">("search");
  const [paste, setPaste] = useState("");
  const [outcome, setOutcome] = useState<MCPImportOutcome>();
  const [parsing, setParsing] = useState(false);
  const parsingRef = useRef(false);
  /** Set while the draft came from a paste, so returning to the first step restores that paste. */
  const imported = useRef(false);
  const urlLike = /^https?:\/\//i.test(query.trim());
  const filtered = servers.filter((server) =>
    urlLike
      ? server.url === query.trim()
      : `${server.name} ${server.url} ${server.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const duplicate = !selected && servers.some((server) => server.name === name.trim() && server.id !== created?.id);
  const validName = MCPServerNameSchema.safeParse(name).success;
  const canSubmit = Boolean(
    (selected || (validName && !duplicate && MCPServerUrlSchema.safeParse(url).success)) &&
      validAuth(draft, Boolean(selected)),
  );
  const changeUrl = (value: string) => {
    setUrl(value);
    if (!nameEdited.current) setName(suggestServerName(value, servers));
  };
  const choose = (server: MCPServer) => {
    imported.current = false;
    setSelected(server);
    if (selected?.id !== server.id) setDraft(authDraft(server, server.defaultAuthKind));
    setStep("configure");
    setError(undefined);
  };
  const continueUrl = () => {
    if (!MCPServerUrlSchema.safeParse(query).success) {
      setError(m.mcp_url_invalid());
      return;
    }
    imported.current = false;
    setSelected(undefined);
    changeUrl(query.trim());
    setStep("configure");
    setError(undefined);
  };
  /**
   * Read the pasted configuration and list what it holds. Parsing is a read-only step: nothing is
   * created until the user picks a server and confirms on the next step.
   */
  const analyze = async () => {
    if (parsingRef.current) return;
    parsingRef.current = true;
    setParsing(true);
    setError(undefined);
    try {
      setOutcome(await parseMcpImport({ text: paste, takenNames: servers.map((server) => server.name) }));
    } finally {
      parsingRef.current = false;
      setParsing(false);
    }
  };
  /**
   * Carry a detected server into the same draft a manual entry produces, so create, attach, and
   * authorize are unchanged. A credential found in the paste becomes this Agent's bearer key and is
   * never part of the shared definition that `ensureServer` creates.
   */
  const importServer = (detected: MCPImportServer) => {
    if (!detected.url) return;
    imported.current = true;
    setSelected(undefined);
    setUrl(detected.url);
    nameEdited.current = true;
    setName(detected.name);
    setDraft({
      ...authDraft(
        {
          url: detected.url,
          authHeader: detected.credential?.header ?? defaultConnection.authHeader,
          authScheme: detected.credential?.scheme ?? defaultConnection.authScheme,
          extraHeaders: detected.extraHeaders,
        },
        detected.credential ? "bearer" : "oauth",
      ),
      token: detected.credential?.token ?? "",
    });
    setStep("configure");
    setError(undefined);
  };
  const ensureServer = async () => {
    const known = createdRef.current ?? selected;
    if (known) return known;
    const input = CreateMCPServerRequestSchema.parse({
      name,
      url,
      defaultAuthKind: draft.kind,
      ...(draft.kind === "bearer" ? { authHeader: draft.authHeader, authScheme: draft.authScheme } : {}),
      extraHeaders: headersFromRows(draft.headers),
    });
    const server = await create.mutateAsync(input);
    createdRef.current = server;
    setCreated(server);
    return server;
  };
  const ensureBinding = async (server: MCPServer) => {
    if (attachedRef.current) return attachedRef.current;
    const binding = await attach.mutateAsync(server.id);
    attachedRef.current = binding;
    setAttached(binding);
    return binding;
  };
  const failureMessage = () => {
    if (attachedRef.current) return m.mcp_authorize_failed();
    return createdRef.current ? m.mcp_attach_failed() : m.mcp_create_failed();
  };
  const back = () => {
    if (!selected && !imported.current) setQuery(url);
    setStep("choose");
    setError(undefined);
  };
  const submit = async () => {
    if (inFlight.current || !canSubmit) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const server = await ensureServer();
      const binding = await ensureBinding(server);
      const changedHeaders = headersKey(headersFromRows(draft.headers)) !== headersKey(server.extraHeaders);
      await authorize(binding, selected ? draft : { ...draft, headerMode: changedHeaders ? "custom" : "inherit" });
      if (draft.kind !== "oauth") onAdded(binding);
    } catch (cause) {
      setError(actionError(cause, failureMessage()));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const submitLabel = attached
    ? draft.kind === "oauth"
      ? m.mcp_authorize_submit()
      : m.mcp_auth_save()
    : draft.kind === "oauth"
      ? m.mcp_add_authorize()
      : m.mcp_create_submit();
  return {
    account,
    servers,
    step,
    back,
    query,
    setQuery,
    selected,
    url,
    name,
    setName,
    nameEdited,
    draft,
    setDraft,
    error,
    setError,
    created,
    attached,
    busy,
    intake,
    setIntake,
    paste,
    setPaste,
    outcome,
    parsing,
    analyze,
    importServer,
    urlLike,
    filtered,
    duplicate,
    validName,
    canSubmit,
    changeUrl,
    choose,
    continueUrl,
    submit,
    submitLabel,
  };
}
type AddState = ReturnType<typeof useAddServer>;
export function McpAddDialog(props: AddProps) {
  const state = useAddServer(props);
  return (
    <Dialog
      busy={state.busy}
      onClose={props.onClose}
      title={
        state.step === "configure" && state.selected
          ? m.mcp_add_named({ server: state.selected.name })
          : m.mcp_create_title()
      }
      description={m.mcp_for_agent({ agent: props.agentName })}
      className="mcp-form-dialog"
    >
      {state.step === "choose" ? <AddPicker {...props} state={state} /> : <AddConfiguration {...props} state={state} />}
    </Dialog>
  );
}
function AddPicker(props: AddProps & { state: AddState }) {
  return props.state.intake === "import" ? <AddImport {...props} /> : <AddSearch {...props} />;
}
function AddSearch(props: AddProps & { state: AddState }) {
  const { state, onClose } = props;
  const { account, filtered, urlLike, servers, query, continueUrl, error } = state;
  const loaded = !account.isPending && !account.isError;
  const canContinue = loaded && ((!filtered.length && urlLike) || !servers.length);
  return (
    <>
      {account.isPending ? <Loader /> : null}
      {account.isError ? (
        <div className="grid gap-3">
          <Banner variant="error">{actionError(account.error, m.common_request_failed())}</Banner>
          <Button onClick={() => void account.refetch()} variant="secondary">
            {m.mcp_retry()}
          </Button>
        </div>
      ) : null}
      {loaded ? <AddChoices {...props} /> : null}
      {loaded ? (
        <Button className="mt-4 -ml-2" variant="ghost" size="compact" onClick={() => state.setIntake("import")}>
          <Icon name="upload" />
          {m.mcp_import_open()}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-kumo-danger">
          {error}
        </p>
      ) : null}
      <McpFooter onClose={onClose}>
        {canContinue ? (
          <Button disabled={!query.trim()} onClick={continueUrl}>
            {m.mcp_continue()}
          </Button>
        ) : null}
      </McpFooter>
    </>
  );
}
/**
 * The import method: paste a configuration fragment or a CLI command, read it, and pick one remote
 * server out of what it holds. Unsupported entries are listed rather than hidden, and nothing is
 * created until a listed server is chosen and confirmed on the next step.
 */
function AddImport(props: AddProps & { state: AddState }) {
  const { state, agentName, mounted, onLocate } = props;
  const { paste, setPaste, outcome, analyze, parsing, setIntake, error, importServer } = state;
  const detected = outcome?.servers ?? [];
  return (
    <>
      <Button
        className="mb-4 -ml-2"
        disabled={parsing}
        variant="ghost"
        size="compact"
        onClick={() => setIntake("search")}
      >
        <Icon name="arrow-left" />
        {m.mcp_import_back()}
      </Button>
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
                  onChoose={() => importServer(entry)}
                  onLocate={onLocate}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-kumo-danger">
          {error}
        </p>
      ) : null}
      <McpFooter onClose={props.onClose} busy={parsing} />
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
      return m.mcp_import_unsupported_only();
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
function AddChoices({ state, agentName, mounted, onLocate }: AddProps & { state: AddState }) {
  const { servers, query, setQuery, filtered, urlLike, continueUrl, choose, setError } = state;
  const choices = useRef<HTMLUListElement>(null);
  const submitSearch = () => {
    if (filtered.length) choices.current?.querySelector("button")?.focus();
    else if (urlLike || !servers.length) continueUrl();
    else setError(m.mcp_add_no_matches());
  };
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitSearch();
        }}
      >
        {!servers.length ? <p className="mb-5 text-sm text-kumo-subtle">{m.mcp_url_intro()}</p> : null}
        <Field htmlFor="mcp-choose-server" label={servers.length ? m.mcp_add_search() : m.mcp_url_label()}>
          <KumoInputControl
            id="mcp-choose-server"
            value={query}
            placeholder={servers.length ? m.mcp_add_placeholder() : "https://mcp.example.com/mcp"}
            onChange={(event) => {
              setQuery(event.target.value);
              setError(undefined);
            }}
          />
        </Field>
      </form>
      {servers.length ? (
        <div className="mt-6">
          <p className="mb-2 text-xs text-kumo-subtle">
            {urlLike && filtered.length ? m.mcp_account_matches() : m.mcp_account_servers()}
          </p>
          <ul ref={choices} className="divide-y divide-kumo-line border-y border-kumo-line">
            {filtered.map((server) => (
              <ServerChoice
                key={server.id}
                server={server}
                added={mounted.some((entry) => entry.mcpServerId === server.id)}
                agentName={agentName}
                onChoose={() => choose(server)}
                onLocate={() => onLocate(server.id)}
              />
            ))}
          </ul>
          {!filtered.length && !urlLike ? (
            <p className="mt-3 text-sm text-kumo-subtle">{m.mcp_add_no_matches()}</p>
          ) : null}
        </div>
      ) : null}
      {urlLike && filtered.length ? (
        <Button className="mt-3 -ml-2 text-kumo-subtle" variant="ghost" size="compact" onClick={continueUrl}>
          {m.mcp_add_separately()}
        </Button>
      ) : null}
    </>
  );
}
function AddConfiguration({ state, agentName, onClose }: AddProps & { state: AddState }) {
  const {
    busy,
    created,
    attached,
    back,
    submit,
    error,
    selected,
    url,
    name,
    changeUrl,
    duplicate,
    validName,
    nameEdited,
    setName,
    draft,
    setDraft,
    canSubmit,
    submitLabel,
  } = state;
  return (
    <>
      <Button
        className="mb-4 -ml-2"
        disabled={busy || Boolean(created || attached)}
        variant="ghost"
        size="compact"
        onClick={back}
      >
        <Icon name="arrow-left" />
        {m.mcp_back()}
      </Button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy} className="mcp-fields border-0 p-0">
          {error ? <Banner variant="error">{error}</Banner> : null}
          {attached ? (
            <p className="text-sm text-kumo-subtle">{m.mcp_add_incomplete({ server: attached.name })}</p>
          ) : created ? (
            <p className="text-sm text-kumo-subtle">{m.mcp_create_incomplete()}</p>
          ) : null}
          {selected ? (
            <div className="border-b border-kumo-line pb-5">
              <p className="wrap-anywhere text-sm">{selected.url}</p>
              <p className="mt-2 text-xs leading-relaxed text-kumo-subtle">{m.mcp_reuse_help({ agent: agentName })}</p>
            </div>
          ) : (
            <>
              <Field htmlFor="mcp-url" label={m.mcp_url_label()}>
                <KumoInputControl
                  id="mcp-url"
                  type="url"
                  disabled={Boolean(created)}
                  value={url}
                  onChange={(event) => changeUrl(event.target.value)}
                />
              </Field>
              <Field
                htmlFor="mcp-name"
                label={m.mcp_name_label()}
                hint={m.mcp_name_help()}
                error={duplicate ? m.mcp_name_conflict() : name && !validName ? m.mcp_name_invalid() : undefined}
              >
                <KumoInputControl
                  id="mcp-name"
                  disabled={Boolean(created)}
                  value={name}
                  onChange={(event) => {
                    nameEdited.current = true;
                    setName(event.target.value);
                  }}
                />
              </Field>
            </>
          )}
          <McpAuthFields draft={draft} onChange={setDraft} existing={Boolean(selected)} />
        </fieldset>
        <McpFooter onClose={onClose} busy={busy}>
          <Button type="submit" disabled={busy || !canSubmit} loading={busy}>
            {submitLabel}
          </Button>
        </McpFooter>
      </form>
    </>
  );
}
function ServerChoice({
  server,
  added,
  agentName,
  onChoose,
  onLocate,
}: {
  server: MCPServer;
  added: boolean;
  agentName: string;
  onChoose: () => void;
  onLocate: () => void;
}) {
  const copy = (
    <span className="grid min-w-0 gap-1">
      <strong className="text-sm font-medium">{server.name}</strong>
      <span className="wrap-anywhere text-xs text-kumo-subtle">{server.url}</span>
      {added ? <span className="text-xs text-kumo-subtle">{m.mcp_added_to({ agent: agentName })}</span> : null}
    </span>
  );
  return (
    <li className="flex items-center gap-3">
      {added ? (
        <>
          <div className="min-w-0 flex-1 py-4">{copy}</div>
          <Button size="compact" variant="ghost" onClick={onLocate}>
            {m.mcp_view_existing()}
          </Button>
        </>
      ) : (
        <Button variant="ghost" type="button" className="mcp-choice" onClick={onChoose}>
          {copy}
          <Icon className="size-3.5 shrink-0 text-kumo-subtle" name="chevron-right" />
        </Button>
      )}
    </li>
  );
}
