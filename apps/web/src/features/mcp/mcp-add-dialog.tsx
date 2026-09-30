import {
  CreateMCPServerRequestSchema,
  type MCPAgentServer,
  type MCPAuthKind,
  type MCPServer,
  MCPServerNameSchema,
  MCPServerUrlSchema,
} from "@opentag/shared/browser";
import { useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog, Field, Icon, KumoInputControl, Loader } from "../../ui/design-system.js";
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES, type McpCatalogEntry } from "./catalog/mcp-catalog.gen.js";
import { comparableUrl, findAccountServer } from "./catalog/mcp-catalog-model.js";
import { McpDiscoverSource } from "./catalog/mcp-discover-source.js";
import { useMcpAuthorization, validAuth } from "./mcp-authorize-dialog.js";
import { McpAuthFields, McpFooter } from "./mcp-form.js";
import {
  type AuthDraft,
  actionError,
  authDraft,
  defaultConnection,
  headersFromRows,
  headersKey,
  suggestServerName,
} from "./mcp-form-model.js";
import type { MCPImportServer } from "./mcp-import-model.js";
import { McpImportPanel, useMcpImport } from "./mcp-import-panel.js";
import { useAttachMcpServer, useCreateMcpServer, useMcpServers } from "./mcp-queries.js";

/** Which source the picker opens on. The empty state lands on the catalog; the header lands on URL. */
export type AddSource = "existing" | "discover" | "import" | "manual";

/**
 * The draft a catalog entry prefills. Its auth header, scheme, and extra headers are configuration
 * the entry declares; the kind stays a prefill for the new authorization.
 */
function catalogDraft(entry: McpCatalogEntry, kind: MCPAuthKind): AuthDraft {
  return authDraft(
    {
      ...defaultConnection,
      authHeader: entry.authHeader ?? defaultConnection.authHeader,
      authScheme: entry.authScheme ?? defaultConnection.authScheme,
      extraHeaders: entry.extraHeaders ?? {},
    },
    kind,
  );
}

/** The create payload a catalog entry produces: the entry is the definition, nothing else invented. */
function catalogCreateInput(entry: McpCatalogEntry) {
  return CreateMCPServerRequestSchema.parse({
    name: entry.name,
    url: entry.url,
    defaultAuthKind: entry.defaultAuthKind,
    ...(entry.authHeader === undefined ? {} : { authHeader: entry.authHeader }),
    ...(entry.authScheme === undefined ? {} : { authScheme: entry.authScheme }),
    ...(entry.extraHeaders === undefined ? {} : { extraHeaders: entry.extraHeaders }),
  });
}

type AddProps = {
  agentId: string;
  agentName: string;
  mounted: MCPAgentServer[];
  initialSource?: AddSource;
  onClose: () => void;
  onAdded: (entry: MCPAgentServer) => void;
  onLocate: (id: string) => void;
};
function useAddServer({ agentId, initialSource, onAdded }: AddProps) {
  const account = useMcpServers();
  const servers = account.data?.servers ?? [];
  const create = useCreateMcpServer(agentId);
  const attach = useAttachMcpServer(agentId);
  const authorize = useMcpAuthorization(agentId);
  const [step, setStep] = useState<"choose" | "configure">("choose");
  const [source, setSource] = useState<AddSource>(initialSource ?? "existing");
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
  /** The entry the current create/mount state belongs to, so another card cannot inherit it. */
  const catalogAttempt = useRef<string>(undefined);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const importState = useMcpImport(servers.map((server) => server.name));
  const urlLike = /^https?:\/\//i.test(query.trim());
  const filtered = servers.filter((server) =>
    urlLike
      ? server.url === query.trim()
      : `${server.name} ${server.url} ${server.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const duplicate = !selected && servers.some((server) => server.name === name.trim() && server.id !== created?.id);
  const validName = MCPServerNameSchema.safeParse(name).success;
  /** Shown on the field itself, so a typed address that cannot be submitted says why. */
  const validUrl = MCPServerUrlSchema.safeParse(url).success;
  const canSubmit = Boolean((selected || (validName && !duplicate && validUrl)) && validAuth(draft, Boolean(selected)));
  const changeUrl = (value: string) => {
    setUrl(value);
    if (!nameEdited.current) setName(suggestServerName(value, servers));
  };
  const choose = (server: MCPServer) => {
    resetAttempt();
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
    resetAttempt();
    setSelected(undefined);
    changeUrl(query.trim());
    setStep("configure");
    setError(undefined);
  };
  /**
   * Carry a detected server into the same draft a manual entry produces, so create, attach, and
   * authorize are unchanged. A credential found in the paste becomes this Agent's bearer key and is
   * never part of the shared definition that `ensureServer` creates.
   */
  const importServer = (detected: MCPImportServer) => {
    if (!detected.url) return;
    // A catalog card that failed earlier may have left a definition or a mount behind; reusing either
    // would authorize the endpoint that card created rather than the one just imported.
    resetAttempt();
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
  /**
   * The mount for one Server, cached only for that Server.
   *
   * A catalog attempt that failed at authorization leaves a mount behind; returning it for the next
   * card would rewrite that first Server's authorization, or probe a newly entered key against an
   * endpoint the user did not choose.
   */
  const ensureBinding = async (server: MCPServer) => {
    if (attachedRef.current?.mcpServerId === server.id) return attachedRef.current;
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
    // An imported draft keeps the picker on the import source, so the search field is not what the user
    // is looking at; filling it with the imported URL would surprise them on a later switch back.
    if (!selected && source !== "import") setQuery(url);
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
  /**
   * Drop the create/mount state of whatever attempt came before.
   *
   * The catalog's cache must not outlive its entry. `ensureServer()` prefers a cached definition, so
   * leaving Discover, choosing another Account Server, or entering a new URL without this would
   * authorize the endpoint a failed catalog card created instead of the one the user just picked.
   */
  const resetAttempt = () => {
    catalogAttempt.current = undefined;
    createdRef.current = undefined;
    attachedRef.current = undefined;
    setCreated(undefined);
    setAttached(undefined);
  };
  /**
   * Switch source, dropping any attempt the previous source left behind.
   *
   * The manual source types a whole new Server from nothing, so it also drops the previous source's
   * selection and draft: reusing an Account Server would show its read-only layout, and carrying its
   * name over would read as already taken. The same-source guard above keeps this from happening
   * while the user is still on manual, so the draft survives repeated clicks on its own source.
   */
  const changeSource = (next: AddSource) => {
    if (next === source) return;
    resetAttempt();
    setSource(next);
    setError(undefined);
    if (next === "manual") {
      setSelected(undefined);
      setUrl("");
      setName("");
      nameEdited.current = false;
      setDraft(authDraft());
    }
  };
  /**
   * Start a catalog attempt for one entry, clearing the state of a previous entry.
   *
   * Retrying the same card keeps its progress; switching cards must not inherit the other entry's
   * definition or mount, or the new authorization would be written against the wrong Server.
   */
  const beginCatalogAttempt = (entry: McpCatalogEntry) => {
    if (catalogAttempt.current === entry.id) return;
    resetAttempt();
    catalogAttempt.current = entry.id;
  };
  /**
   * Open the configure step prefilled with the entry, keeping the Account's definition at the same
   * URL when one exists so the key form submits against it instead of creating a duplicate.
   */
  const prefillCatalogBearer = (entry: McpCatalogEntry) => {
    setSelected(findAccountServer(entry, servers));
    setName(entry.name);
    nameEdited.current = true;
    setUrl(entry.url);
    setDraft(catalogDraft(entry, "bearer"));
    setStep("configure");
  };
  /** The Account definition to add: the one already at this URL, or a new one from the entry. */
  const resolveCatalogServer = async (entry: McpCatalogEntry) => {
    const target = comparableUrl(entry.url);
    const previous = createdRef.current;
    // A definition this session already created for this entry, before the Account read caught up.
    const carried = previous && comparableUrl(previous.url) === target ? previous : undefined;
    if (previous && !carried) createdRef.current = undefined;
    const known = findAccountServer(entry, servers) ?? carried;
    if (known) return known;
    const server = await create.mutateAsync(catalogCreateInput(entry));
    createdRef.current = server;
    setCreated(server);
    return server;
  };
  /**
   * Add a catalog entry to this Agent.
   *
   * Anonymous and OAuth entries skip the configure step — everything is known — so the card is the
   * whole interaction. A bearer entry genuinely needs a secret, so it stops for the key.
   */
  const addFromCatalog = async (entry: McpCatalogEntry) => {
    if (inFlight.current) return;
    beginCatalogAttempt(entry);
    setError(undefined);
    if (entry.defaultAuthKind === "bearer") {
      prefillCatalogBearer(entry);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const binding = await ensureBinding(await resolveCatalogServer(entry));
      await authorize(binding, catalogDraft(entry, entry.defaultAuthKind));
      if (entry.defaultAuthKind !== "oauth") onAdded(binding);
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
    source,
    changeSource,
    addFromCatalog,
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
    import: importState,
    importServer,
    urlLike,
    filtered,
    duplicate,
    validName,
    validUrl,
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
/** The picker's four sources: the marketplace catalog, the Account pool or a pasted URL, a paste, and a manual entry. */
function AddSourceSwitch({ value, onChange }: { value: AddSource; onChange: (source: AddSource) => void }) {
  const choices: { source: AddSource; label: string }[] = [
    { source: "discover", label: m.mcp_source_discover() },
    { source: "existing", label: m.mcp_add_existing() },
    { source: "import", label: m.mcp_source_import() },
    { source: "manual", label: m.mcp_source_manual() },
  ];
  return (
    <fieldset className="mb-4 flex flex-wrap gap-1 border-0 p-0">
      <legend className="sr-only">{m.mcp_source_label()}</legend>
      {choices.map((choice) => (
        <Button
          key={choice.source}
          aria-pressed={value === choice.source}
          size="compact"
          variant={value === choice.source ? "secondary" : "ghost"}
          onClick={() => onChange(choice.source)}
        >
          {choice.label}
        </Button>
      ))}
    </fieldset>
  );
}
function AddPicker(props: AddProps & { state: AddState }) {
  const { state, onClose } = props;
  const { account, source, changeSource } = state;
  const loaded = !account.isPending && !account.isError;
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
      {loaded ? (
        <>
          <AddSourceSwitch value={source} onChange={changeSource} />
          <AddSourcePanel {...props} />
        </>
      ) : null}
      <AddPickerFooter state={state} onClose={onClose} loaded={loaded} />
    </>
  );
}
/** The picker's body: the panel of exactly one source. */
function AddSourcePanel(props: AddProps & { state: AddState }) {
  const { state } = props;
  if (state.source === "discover")
    return (
      <McpDiscoverSource
        categories={MCP_CATALOG_CATEGORIES}
        entries={MCP_CATALOG_ENTRIES}
        servers={state.servers}
        mounted={props.mounted}
        busy={state.busy}
        onAdd={(entry) => void state.addFromCatalog(entry)}
      />
    );
  if (state.source === "import")
    return (
      <McpImportPanel
        state={state.import}
        agentName={props.agentName}
        mounted={props.mounted}
        onChoose={state.importServer}
        onLocate={props.onLocate}
      />
    );
  // The manual source types a new Server from nothing, so the configuration form is its panel.
  if (state.source === "manual") return <AddConfiguration {...props} embedded />;
  return <AddChoices {...props} />;
}
/**
 * The picker's footer: the Account pool's Continue action, and where a picker-wide error is shown.
 *
 * The manual source carries the step's primary action, its own Cancel, and its own error, so this
 * adds none of them there.
 */
function AddPickerFooter({ state, onClose, loaded }: { state: AddState; onClose: () => void; loaded: boolean }) {
  const { error, filtered, urlLike, servers, query, continueUrl, source, busy } = state;
  if (source === "manual") return null;
  const canContinue = loaded && ((!filtered.length && urlLike) || !servers.length);
  return (
    <>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-kumo-danger">
          {error}
        </p>
      ) : null}
      <McpFooter onClose={onClose} busy={busy}>
        {source === "existing" && canContinue ? (
          <Button disabled={!query.trim()} onClick={continueUrl}>
            {m.mcp_continue()}
          </Button>
        ) : null}
      </McpFooter>
    </>
  );
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
/** The message the address field shows while the typed address cannot be submitted. */
function urlFieldError(url: string, validUrl: boolean): string | undefined {
  return url && !validUrl ? m.mcp_url_invalid() : undefined;
}
/** The message the name field shows: a taken name first, then one that breaks the naming rules. */
function nameFieldError(name: string, validName: boolean, duplicate: boolean): string | undefined {
  if (duplicate) return m.mcp_name_conflict();
  return name && !validName ? m.mcp_name_invalid() : undefined;
}
/**
 * The configuration step, and — for the manual source — that source's own panel.
 *
 * The manual source types a new Server from nothing, so it is this form straight away, with no Back
 * button: the source switch above it is the way out, and the form's own footer carries Cancel and
 * the submit action instead of the picker's.
 */
function AddConfiguration({
  state,
  agentName,
  onClose,
  embedded = false,
}: AddProps & { state: AddState; embedded?: boolean }) {
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
    validUrl,
    nameEdited,
    setName,
    draft,
    setDraft,
    canSubmit,
    submitLabel,
  } = state;
  return (
    <>
      {embedded ? null : (
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
      )}
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
              <Field htmlFor="mcp-url" label={m.mcp_url_label()} error={urlFieldError(url, validUrl)}>
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
                error={nameFieldError(name, validName, duplicate)}
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
