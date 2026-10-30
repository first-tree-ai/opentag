import {
  type AgentAdminConfig,
  CONTEXT_TREES_MAX,
  type ContextTreeConnection,
  ContextTreeConnectionSchema,
  type ContextTreeOperationRequest,
  type ContextTreeOperationResponse,
  ContextTreeRepositorySchema,
  contextTreeIdentity,
  contextTreeName,
  contextTreeSelector,
} from "@opentag/shared/browser";
import { Link } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import { PageHeader } from "../../../components/kumo/page-header/page-header.js";
import * as m from "../../../paraglide/messages.js";
import {
  Banner,
  Button,
  Collapsible,
  Dialog,
  DropdownMenu,
  Field,
  Icon,
  KumoInputControl,
  Text,
} from "../../../ui/design-system.js";
import { agentSettingsSectionLink } from "../agent-routes.js";

type TreeAction = "connect" | "create";

export function ContextTreeSettings(props: Parameters<typeof ContextTreeSettingsForm>[0]) {
  return <ContextTreeSettingsForm key={props.config.id} {...props} />;
}

function ContextTreeSettingsForm({
  config,
  computerKind = "local",
  online,
  onChanged,
  unconfirmed = false,
  refreshNotice,
}: {
  config: AgentAdminConfig;
  computerKind?: "local" | "cloud";
  online: boolean;
  onChanged: () => void;
  unconfirmed?: boolean;
  refreshNotice?: ReactNode;
}) {
  const [mode, setMode] = useState<TreeAction>();
  const [draft, setDraft] = useState({ owner: "", name: "" });
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [path, setPath] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<ContextTreeConnection>();
  const [uncertainCreations, setUncertainCreations] = useState<ContextTreeConnection[]>([]);
  const [resultSource, setResultSource] = useState<ContextTreeConnection>();
  const ownerInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const repositoryInput = useRef<HTMLInputElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const disconnectReturnFocus = useRef<HTMLElement | null>(null);
  const treeButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusCollectionActionAfterCount = useRef<number | undefined>(undefined);
  const focusRepositoryAfterRecovery = useRef(false);
  const inFlight = useRef(false);
  const [pendingAction, setPendingAction] = useState<ContextTreeOperationRequest["action"]>();
  const [result, setResult] = useState<ContextTreeOperationResponse>();
  const mounted = useRef(true);
  const currentRevision = `${config.revision}:${config.runtimeConfig.revision}`;
  const latestRevision = useRef(currentRevision);
  latestRevision.current = currentRevision;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { selected, cloud, pauseRequired, pending, disabled } = treePermissions({
    config,
    computerKind,
    online,
    unconfirmed,
    pendingAction,
  });
  const activeMode = mode ?? "connect";
  const { source, valid, ownerValid, nameValid, linkedRepository } = parseForm(activeMode, draft, repositoryUrl, path);
  const fieldId = `context-tree-${config.id}`;
  const uncertainCreation =
    activeMode === "create"
      ? uncertainCreations.find(
          (entry) => repositoryIdentity(entry.repository) === repositoryIdentity(source.repository),
        )
      : undefined;
  const formResult = currentFormResult(result, uncertainCreation !== undefined);
  const recoverySource = currentRecoverySource(result, resultSource, uncertainCreation);

  useEffect(() => {
    if (focusCollectionActionAfterCount.current !== selected.length || !addButton.current) return;
    focusCollectionActionAfterCount.current = undefined;
    addButton.current.focus();
  }, [selected.length]);
  useEffect(() => {
    if (mode !== "connect" || !focusRepositoryAfterRecovery.current) return;
    focusRepositoryAfterRecovery.current = false;
    repositoryInput.current?.focus();
  }, [mode]);

  function openForm(next: TreeAction, trigger?: HTMLElement | null) {
    returnFocus.current = trigger ?? addButton.current;
    setMode(next);
    setSubmitted(false);
    setResult(undefined);
  }
  function updateDraft(field: "owner" | "name", value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setResult(undefined);
  }
  function closeForm() {
    if (inFlight.current) return;
    setMode(undefined);
    setResult(undefined);
  }
  function validateSubmission() {
    setSubmitted(true);
    if (valid.success) return true;
    const field =
      activeMode === "connect" ? (linkedRepository ? pathInput : repositoryInput) : ownerValid ? nameInput : ownerInput;
    field.current?.focus();
    return false;
  }
  function completeOperation(action: ContextTreeOperationRequest["action"], entry: ContextTreeConnection) {
    if (action !== "disconnect") {
      if (selected.length === 0) focusCollectionActionAfterCount.current = 1;
      const survivingRowButton =
        selected.length + 1 >= CONTEXT_TREES_MAX
          ? [...selected]
              .reverse()
              .map((item) => treeButtons.current.get(contextTreeIdentity(item)))
              .find((button) => button?.isConnected && !button.disabled)
          : undefined;
      returnFocus.current = survivingRowButton ?? addButton.current;
      setMode(undefined);
      return;
    }
    const index = selected.findIndex((item) => contextTreeIdentity(item) === contextTreeIdentity(entry));
    const neighbours = [...selected.slice(index + 1), ...selected.slice(0, index).reverse()];
    const neighbour = neighbours
      .map((item) => treeButtons.current.get(contextTreeIdentity(item)))
      .find((button) => button?.isConnected && !button.disabled);
    disconnectReturnFocus.current = neighbour ?? addButton.current;
    if (!neighbour) focusCollectionActionAfterCount.current = Math.max(0, selected.length - 1);
    setDisconnectTarget(undefined);
  }
  function applyOperationResponse(
    action: ContextTreeOperationRequest["action"],
    entry: ContextTreeConnection,
    response: ContextTreeOperationResponse,
  ) {
    setResult(response);
    if (response.status === "completed") {
      if (action === "connect")
        setUncertainCreations((previous) => removeUncertainCreation(previous, entry.repository));
      completeOperation(action, entry);
    }
  }
  async function run(action: ContextTreeOperationRequest["action"], entry: ContextTreeConnection) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPendingAction(action);
    setResult(undefined);
    setResultSource(entry);
    try {
      const response = await executeOperation(config.id, {
        ...entry,
        action,
        expectedRevision: config.revision,
        expectedRuntimeConfigRevision: config.runtimeConfig.revision,
      });
      if (!mounted.current) return;
      if (response.status === "failed" && response.code === "publication_uncertain" && action === "create")
        setUncertainCreations((previous) => addUncertainCreation(previous, entry));
      if (latestRevision.current !== currentRevision) return;
      applyOperationResponse(action, entry, response);
      if (operationRefreshesConfig(response)) onChanged();
    } finally {
      inFlight.current = false;
      if (mounted.current) setPendingAction(undefined);
    }
  }
  function submit() {
    if (disabled || uncertainCreation || !validateSubmission()) return;
    void run(activeMode, source);
  }
  function recoverConnection() {
    const entry = recoverySource;
    if (!entry) return;
    setRepositoryUrl(`https://github.com/${entry.repository}`);
    setPath(entry.path === "." ? "" : entry.path);
    focusRepositoryAfterRecovery.current = true;
    setMode("connect");
    setSubmitted(false);
    setResult(undefined);
  }
  return (
    <div className="grid gap-6">
      <PageHeader
        title={m.agent_settings_context_tree_title()}
        description={m.agent_settings_context_tree_description()}
      />
      {refreshNotice}
      <ContextTreeCollection
        agentId={config.id}
        online={online}
        selected={selected}
        pending={pending}
        pauseRequired={pauseRequired}
        unconfirmed={unconfirmed}
        fieldId={fieldId}
        addButton={addButton}
        openForm={openForm}
        onDisconnect={(entry) => {
          disconnectReturnFocus.current = treeButtons.current.get(contextTreeIdentity(entry)) ?? addButton.current;
          setResult(undefined);
          setDisconnectTarget(entry);
        }}
        onButton={(entry, button) => {
          const key = contextTreeIdentity(entry);
          if (button) treeButtons.current.set(key, button);
          else treeButtons.current.delete(key);
        }}
      />
      <div className="min-h-6 text-sm" aria-live="polite">
        {result && !mode && !disconnectTarget ? (
          <ContextTreeResult result={result} cloud={cloud} repository={resultSource?.repository} />
        ) : null}
      </div>
      <Dialog
        open={mode !== undefined}
        busy={pending}
        title={
          activeMode === "connect"
            ? m.agent_settings_context_tree_connect_existing()
            : m.agent_settings_context_tree_create_new()
        }
        description={
          activeMode === "connect"
            ? m.agent_settings_context_tree_connect_guidance()
            : m.agent_settings_context_tree_create_guidance()
        }
        onClose={closeForm}
        initialFocusRef={activeMode === "connect" ? repositoryInput : ownerInput}
        returnFocusRef={returnFocus}
      >
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {activeMode === "connect" ? (
            <ConnectTreeFields
              {...{
                fieldId,
                repositoryUrl,
                path,
                pending,
                submitted,
                linkedRepository,
                valid,
                repositoryInput,
                pathInput,
              }}
              onRepositoryChange={(value) => {
                setRepositoryUrl(value);
                setResult(undefined);
              }}
              onPathChange={setPath}
            />
          ) : (
            <RepositoryFields
              {...{ fieldId, draft, pending, submitted, ownerValid, nameValid, ownerInput, nameInput, updateDraft }}
            />
          )}
          {cloud ? <p className="text-sm text-kumo-subtle">{m.agent_settings_context_tree_cloud_guidance()}</p> : null}
          <ContextTreeRestrictions agentId={config.id} online={online} pauseRequired={pauseRequired} />
          {pending ? <p role="status">{m.agent_settings_context_tree_pending()}</p> : null}
          {formResult ? (
            <ContextTreeResult
              result={formResult}
              cloud={cloud}
              repository={recoverySource?.repository}
              onConnect={recoverConnection}
            />
          ) : null}
          <div className="flex flex-wrap justify-end gap-3 border-t border-kumo-line pt-4">
            <Button variant="secondary" disabled={pending} onClick={closeForm}>
              {m.common_cancel()}
            </Button>
            <Button type="submit" disabled={disabled || uncertainCreation !== undefined} loading={pending}>
              {activeMode === "connect"
                ? m.agent_settings_context_tree_connect()
                : m.agent_settings_context_tree_create()}
            </Button>
          </div>
        </form>
      </Dialog>
      <DisconnectTreeDialog
        target={disconnectTarget}
        pending={pending}
        disabled={pauseRequired || unconfirmed}
        result={result}
        cloud={cloud}
        returnFocusRef={disconnectReturnFocus}
        onClose={() => {
          if (!inFlight.current) {
            setDisconnectTarget(undefined);
            setResult(undefined);
          }
        }}
        onConfirm={() => {
          if (disconnectTarget && !pauseRequired && !unconfirmed) void run("disconnect", disconnectTarget);
        }}
      />
    </div>
  );
}

function treePermissions({
  config,
  computerKind,
  online,
  unconfirmed,
  pendingAction,
}: {
  config: AgentAdminConfig;
  computerKind: "local" | "cloud";
  online: boolean;
  unconfirmed: boolean;
  pendingAction?: ContextTreeOperationRequest["action"];
}) {
  const selected = config.runtimeConfig.contextTrees;
  const pauseRequired = selected.length > 0 && config.status !== "suspended";
  const pending = pendingAction !== undefined;
  return {
    selected,
    pauseRequired,
    pending,
    cloud: computerKind === "cloud",
    disabled: pending || !online || pauseRequired || unconfirmed,
  };
}
function currentFormResult(
  result: ContextTreeOperationResponse | undefined,
  uncertain: boolean,
): ContextTreeOperationResponse | undefined {
  if (result) return result;
  if (uncertain) return { status: "failed", code: "publication_uncertain" };
}
function currentRecoverySource(
  result: ContextTreeOperationResponse | undefined,
  attempted: ContextTreeConnection | undefined,
  uncertain: ContextTreeConnection | undefined,
) {
  return result ? attempted : uncertain;
}
function operationRefreshesConfig(response: ContextTreeOperationResponse) {
  return response.status === "completed" || response.code === "stale_configuration";
}
function repositoryIdentity(repository: string) {
  return repository.toLowerCase();
}
function addUncertainCreation(previous: ContextTreeConnection[], entry: ContextTreeConnection) {
  const identity = repositoryIdentity(entry.repository);
  return previous.some((attempt) => repositoryIdentity(attempt.repository) === identity)
    ? previous
    : [...previous, entry];
}
function removeUncertainCreation(previous: ContextTreeConnection[], repository: string) {
  const identity = repositoryIdentity(repository);
  return previous.filter((attempt) => repositoryIdentity(attempt.repository) !== identity);
}
function DisconnectTreeDialog({
  target,
  pending,
  disabled,
  result,
  cloud,
  returnFocusRef,
  onClose,
  onConfirm,
}: {
  target?: ContextTreeConnection;
  pending: boolean;
  disabled: boolean;
  result?: ContextTreeOperationResponse;
  cloud: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={target !== undefined}
      busy={pending}
      role="alertdialog"
      title={m.agent_settings_context_tree_disconnect_title()}
      description={m.agent_settings_context_tree_disconnect_description()}
      onClose={onClose}
      initialFocusRef={cancelRef}
      returnFocusRef={returnFocusRef}
    >
      {target ? (
        <p className="mb-4 wrap-anywhere text-sm font-medium">
          {target.repository}
          {target.path === "." ? "" : `/${target.path}`}
        </p>
      ) : null}
      {result ? <ContextTreeResult result={result} cloud={cloud} repository={target?.repository} /> : null}
      {pending ? (
        <p role="status" className="my-3 text-sm">
          {m.agent_settings_context_tree_disconnecting()}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-3">
        <Button ref={cancelRef} variant="secondary" disabled={pending} onClick={onClose}>
          {m.common_cancel()}
        </Button>
        <Button variant="danger" disabled={pending || disabled} loading={pending} onClick={onConfirm}>
          {m.agent_settings_context_tree_disconnect()}
        </Button>
      </div>
    </Dialog>
  );
}

function ContextTreeRestrictions({
  agentId,
  online,
  pauseRequired,
}: {
  agentId: string;
  online: boolean;
  pauseRequired: boolean;
}) {
  if (online && !pauseRequired) return null;
  return (
    <div className="grid gap-2 text-sm text-kumo-subtle" role="status">
      {pauseRequired ? (
        <p>
          {m.agent_settings_context_tree_pause_required()}{" "}
          <Link
            {...agentSettingsSectionLink(agentId, "manage")}
            target="_blank"
            rel="noopener noreferrer"
            title={m.agent_settings_context_tree_settings_link_hint()}
            className="text-kumo-link underline underline-offset-4"
          >
            {m.agent_settings_context_tree_manage_agent()}
          </Link>
        </p>
      ) : null}
      {!online ? (
        <p>
          {m.agent_settings_context_tree_computer_unavailable()}{" "}
          <Link
            {...agentSettingsSectionLink(agentId, "computer")}
            target="_blank"
            rel="noopener noreferrer"
            title={m.agent_settings_context_tree_settings_link_hint()}
            className="text-kumo-link underline underline-offset-4"
          >
            {m.agent_settings_context_tree_computer_settings()}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function ContextTreeCollection({
  agentId,
  online,
  selected,
  pending,
  pauseRequired,
  unconfirmed,
  fieldId,
  addButton,
  openForm,
  onDisconnect,
  onButton,
}: {
  agentId: string;
  online: boolean;
  selected: ContextTreeConnection[];
  pending: boolean;
  pauseRequired: boolean;
  unconfirmed: boolean;
  fieldId: string;
  addButton: RefObject<HTMLButtonElement | null>;
  openForm: (mode: TreeAction, trigger?: HTMLElement | null) => void;
  onDisconnect: (source: ContextTreeConnection) => void;
  onButton: (source: ContextTreeConnection, button: HTMLButtonElement | null) => void;
}) {
  return (
    <>
      <ContextTreeRestrictions agentId={agentId} online={online} pauseRequired={pauseRequired} />
      {selected.length ? (
        <section
          aria-label={m.agent_settings_context_tree_connected_heading()}
          className="min-w-0 ui-surface divide-y divide-kumo-line bg-kumo-base"
        >
          {selected.map((entry, index) => (
            <ContextTreeCard
              key={contextTreeIdentity(entry)}
              source={entry}
              id={`${fieldId}-tree-${index}`}
              disabled={pending || pauseRequired || unconfirmed}
              onDisconnect={() => onDisconnect(entry)}
              buttonRef={(button) => onButton(entry, button)}
            />
          ))}
          {selected.length < CONTEXT_TREES_MAX ? (
            <div className="p-3">
              <DropdownMenu>
                <DropdownMenu.Trigger
                  render={
                    <Button
                      ref={addButton}
                      className="max-w-full min-w-0 shrink whitespace-normal text-left"
                      variant="ghost"
                      disabled={pending || pauseRequired || unconfirmed}
                    />
                  }
                >
                  <Icon name="plus" className="shrink-0" />
                  <span className="min-w-0 wrap-anywhere">{m.agent_settings_context_tree_connect_another()}</span>
                  <Icon name="chevron-down" className="shrink-0" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="start">
                  <DropdownMenu.Item onClick={() => openForm("connect")}>
                    {m.agent_settings_context_tree_connect_existing()}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onClick={() => openForm("create")}>
                    {m.agent_settings_context_tree_create_new()}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu>
            </div>
          ) : null}
        </section>
      ) : (
        <ContextTreeEmptyState pending={pending || unconfirmed} addButton={addButton} onChoose={openForm} />
      )}
    </>
  );
}

function ContextTreeEmptyState({
  pending,
  addButton,
  onChoose,
}: {
  pending: boolean;
  addButton: RefObject<HTMLButtonElement | null>;
  onChoose: (mode: TreeAction, trigger: HTMLElement) => void;
}) {
  const description = m.agent_settings_context_tree_empty_description({
    connect: "\uFFFC",
    create: "\uFFFD",
  });
  const parts = description.split(/(\uFFFC|\uFFFD)/u);
  return (
    <section className="flex flex-col items-center gap-5 px-4 py-12 text-center sm:py-16">
      <Icon name="memory" weight="light" className="size-8 text-kumo-inactive" />
      <div className="flex max-w-sm flex-col gap-2">
        <Text as="h2" size="lg" variant="heading">
          {m.agent_settings_context_tree_empty_title()}
        </Text>
        <Text as="p" size="sm" variant="secondary">
          {parts.map((part) =>
            part === "\uFFFC" || part === "\uFFFD" ? (
              <Button
                ref={part === "\uFFFC" ? addButton : undefined}
                key={part}
                variant="inline"
                disabled={pending}
                className="inline! h-auto! min-h-0! rounded-sm! p-0! align-baseline font-normal! text-kumo-brand hover:bg-transparent! hover:underline underline-offset-4"
                onClick={(event) => onChoose(part === "\uFFFC" ? "connect" : "create", event.currentTarget)}
              >
                {part === "\uFFFC"
                  ? m.agent_settings_context_tree_connect_existing()
                  : m.agent_settings_context_tree_create_new()}
              </Button>
            ) : (
              part
            ),
          )}
        </Text>
      </div>
    </section>
  );
}

function ContextTreeCard({
  source,
  id,
  disabled,
  onDisconnect,
  buttonRef,
}: {
  source: ContextTreeConnection;
  id: string;
  disabled: boolean;
  onDisconnect: () => void;
  buttonRef: (button: HTMLButtonElement | null) => void;
}) {
  const name = contextTreeName(source);
  return (
    <article aria-labelledby={id} className="flex items-start gap-4 p-5">
      <Icon name="folder" className="mt-1 size-5 shrink-0 text-kumo-subtle" />
      <div className="grid min-w-0 flex-1 gap-1.5">
        <Text as="h2" id={id} size="lg" headingSize="body" variant="heading">
          <a
            href={contextTreeSelector(source)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={m.agent_settings_context_tree_open_source({ name })}
            className="inline-flex max-w-full items-start gap-2 rounded-sm wrap-anywhere hover:text-kumo-link focus-visible:outline-2 focus-visible:outline-kumo-focus"
          >
            {name}
            <Icon name="external-link" className="mt-0.5 size-4 shrink-0" />
          </a>
        </Text>
        <p className="wrap-anywhere text-sm text-kumo-subtle">
          {source.repository}
          {source.path === "." ? "" : `/${source.path}`}
        </p>
        <p className="flex min-w-0 items-start gap-2 text-sm text-kumo-subtle">
          <Icon name="branch" className="shrink-0" />
          <span className="sr-only">{m.agent_settings_context_tree_branch()}: </span>
          <span className="wrap-anywhere">{source.ref}</span>
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button
              ref={buttonRef}
              variant="ghost"
              shape="square"
              aria-label={m.agent_settings_context_tree_actions({ name })}
            />
          }
        >
          <Icon name="more-vertical" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Item disabled={disabled} onClick={onDisconnect}>
            {m.agent_settings_context_tree_disconnect()}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </article>
  );
}

function ConnectTreeFields({
  fieldId,
  repositoryUrl,
  path,
  pending,
  submitted,
  linkedRepository,
  valid,
  repositoryInput,
  pathInput,
  onRepositoryChange,
  onPathChange,
}: {
  fieldId: string;
  repositoryUrl: string;
  path: string;
  pending: boolean;
  submitted: boolean;
  linkedRepository: string | undefined;
  valid: ReturnType<typeof ContextTreeConnectionSchema.safeParse>;
  repositoryInput: RefObject<HTMLInputElement | null>;
  pathInput: RefObject<HTMLInputElement | null>;
  onRepositoryChange: (value: string) => void;
  onPathChange: (value: string) => void;
}) {
  return (
    <>
      <Field
        label={m.agent_settings_context_tree_repository_link()}
        htmlFor={`${fieldId}-repository`}
        error={submitted && !linkedRepository ? m.agent_settings_context_tree_link_error() : undefined}
      >
        <KumoInputControl
          ref={repositoryInput}
          id={`${fieldId}-repository`}
          value={repositoryUrl}
          disabled={pending}
          placeholder="https://github.com/owner/repository"
          aria-invalid={submitted && !linkedRepository}
          onChange={(event) => onRepositoryChange(event.target.value)}
        />
      </Field>
      <Field
        label={m.agent_settings_context_tree_path()}
        htmlFor={`${fieldId}-path`}
        hint={<span className="wrap-anywhere">{m.agent_settings_context_tree_path_hint()}</span>}
        hintId={`${fieldId}-path-hint`}
        error={
          submitted && !valid.success && linkedRepository ? m.agent_settings_context_tree_source_error() : undefined
        }
        errorId={`${fieldId}-path-error`}
      >
        <KumoInputControl
          ref={pathInput}
          id={`${fieldId}-path`}
          value={path}
          disabled={pending}
          onChange={(event) => onPathChange(event.target.value)}
          placeholder="docs"
          aria-invalid={Boolean(submitted && !valid.success && linkedRepository)}
          aria-describedby={`${fieldId}-path-hint${submitted && !valid.success && linkedRepository ? ` ${fieldId}-path-error` : ""}`}
        />
      </Field>
    </>
  );
}

function RepositoryFields({
  fieldId,
  draft,
  pending,
  submitted,
  ownerValid,
  nameValid,
  ownerInput,
  nameInput,
  updateDraft,
}: {
  fieldId: string;
  draft: { owner: string; name: string };
  pending: boolean;
  submitted: boolean;
  ownerValid: boolean;
  nameValid: boolean;
  ownerInput: React.RefObject<HTMLInputElement | null>;
  nameInput: React.RefObject<HTMLInputElement | null>;
  updateDraft: (field: "owner" | "name", value: string) => void;
}) {
  return (
    <div className="grid gap-4">
      <Field
        label={m.agent_settings_context_tree_owner()}
        htmlFor={`${fieldId}-owner`}
        hint={m.agent_settings_context_tree_owner_hint()}
        hintId={`${fieldId}-owner-hint`}
        error={submitted && !ownerValid ? m.agent_settings_context_tree_owner_error() : undefined}
        errorId={`${fieldId}-owner-error`}
      >
        <KumoInputControl
          ref={ownerInput}
          id={`${fieldId}-owner`}
          value={draft.owner}
          disabled={pending}
          placeholder="acme"
          aria-invalid={submitted && !ownerValid}
          aria-describedby={`${fieldId}-owner-hint${submitted && !ownerValid ? ` ${fieldId}-owner-error` : ""}`}
          onChange={(event) => updateDraft("owner", event.target.value)}
        />
      </Field>
      <Field
        label={m.agent_settings_context_tree_repository_name()}
        htmlFor={`${fieldId}-name`}
        error={submitted && !nameValid ? m.agent_settings_context_tree_name_error() : undefined}
        errorId={`${fieldId}-name-error`}
      >
        <KumoInputControl
          ref={nameInput}
          id={`${fieldId}-name`}
          value={draft.name}
          disabled={pending}
          placeholder="agent-memory"
          aria-invalid={submitted && !nameValid}
          aria-describedby={submitted && !nameValid ? `${fieldId}-name-error` : undefined}
          onChange={(event) => updateDraft("name", event.target.value)}
        />
      </Field>
    </div>
  );
}

function parseForm(
  activeMode: TreeAction,
  draft: { owner: string; name: string },
  repositoryUrl: string,
  path: string,
) {
  const owner = draft.owner.trim();
  const name = draft.name.trim();
  const linkedRepository = repositoryFromUrl(repositoryUrl);
  const repository = activeMode === "connect" ? (linkedRepository ?? "") : `${owner}/${name}`;
  const ownerValid = ContextTreeRepositorySchema.safeParse(`${owner}/memory`).success;
  const nameValid = ContextTreeRepositorySchema.safeParse(`acme/${name}`).success;
  const source = {
    kind: "git" as const,
    repository,
    path: activeMode === "create" ? "." : path.trim() || ".",
    ref: "HEAD",
  };
  const valid = ContextTreeConnectionSchema.safeParse(source);
  return { source, valid, ownerValid, nameValid, linkedRepository };
}

function repositoryFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) return;
    const repository = url.pathname
      .replace(/^\//u, "")
      .replace(/\/$/u, "")
      .replace(/\.git$/u, "");
    const parsed = ContextTreeRepositorySchema.safeParse(repository);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function ContextTreeResult({
  result,
  cloud,
  repository,
  onConnect,
}: {
  result: ContextTreeOperationResponse;
  cloud: boolean;
  repository?: string;
  onConnect?: () => void;
}) {
  if (result.status === "completed") return <p role="status">{m.agent_settings_context_tree_completed()}</p>;
  return (
    <div className="grid gap-3">
      <Banner variant="error" role="alert" description={failureMessage(result.code, cloud)} />
      {result.code === "publication_uncertain" ? (
        <Collapsible.Root>
          <Collapsible.Trigger render={<Button variant="ghost" size="compact" />}>
            {m.agent_settings_context_tree_recovery_help()}
          </Collapsible.Trigger>
          <Collapsible.Panel className="pt-2 text-sm text-kumo-subtle">
            <p>{m.agent_settings_context_tree_publication_help()}</p>
          </Collapsible.Panel>
        </Collapsible.Root>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {result.code === "authentication_required" ? (
          <Link
            to="/account"
            target="_blank"
            rel="noopener noreferrer"
            title={m.agent_settings_context_tree_settings_link_hint()}
            className="text-kumo-link underline underline-offset-4"
          >
            {m.agent_settings_context_tree_account_settings()}
          </Link>
        ) : null}
        {repository ? (
          <a
            href={`https://github.com/${repository}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-kumo-link underline underline-offset-4"
          >
            {m.agent_settings_context_tree_open_repository()}
          </a>
        ) : null}
        {result.code === "publication_uncertain" && onConnect ? (
          <Button variant="secondary" size="compact" onClick={onConnect}>
            {m.agent_settings_context_tree_recover_connect()}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function failureMessage(
  code: Extract<ContextTreeOperationResponse, { status: "failed" }>["code"],
  cloud: boolean,
): string {
  switch (code) {
    case "authentication_required":
      return m.agent_settings_context_tree_authentication_required();
    case "github_not_configured":
      return m.agent_settings_context_tree_github_not_configured();
    case "permission_denied":
      return cloud
        ? m.agent_settings_context_tree_cloud_permission_denied()
        : m.agent_settings_context_tree_permission_denied();
    case "tree_limit_reached":
      return m.agent_settings_context_tree_limit_reached();
    case "invalid_tree":
      return m.agent_settings_context_tree_invalid_tree();
    case "repository_rejected":
      return m.agent_settings_context_tree_repository_rejected();
    case "publication_uncertain":
      return m.agent_settings_context_tree_publication_uncertain();
    case "stale_configuration":
      return m.agent_settings_context_tree_stale_configuration();
    case "capability_missing":
      return cloud
        ? m.agent_settings_context_tree_cloud_capability_missing()
        : m.agent_settings_context_tree_capability_missing();
    case "computer_unavailable":
      return m.agent_settings_context_tree_computer_unavailable();
    case "busy":
      return m.agent_settings_context_tree_busy();
    case "pause_required":
      return m.agent_settings_context_tree_pause_required();
    default:
      return cloud ? m.agent_settings_context_tree_cloud_failed() : m.agent_settings_context_tree_failed();
  }
}

async function executeOperation(
  agentId: string,
  input: ContextTreeOperationRequest,
): Promise<ContextTreeOperationResponse> {
  try {
    return await browserApi.contextTreeOperation(agentId, input);
  } catch {
    return { status: "failed", code: input.action === "create" ? "publication_uncertain" : "failed" };
  }
}
