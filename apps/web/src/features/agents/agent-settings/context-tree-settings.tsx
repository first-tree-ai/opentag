import {
  type AgentAdminConfig,
  type ContextTreeConnection,
  ContextTreeConnectionSchema,
  type ContextTreeOperationRequest,
  type ContextTreeOperationResponse,
  ContextTreeRepositorySchema,
  contextTreeIdentity,
  contextTreeName,
  contextTreeSelector,
} from "@opentag/shared/browser";
import { type RefObject, useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  DropdownMenu,
  Field,
  Icon,
  KumoInputControl,
  Text,
} from "../../../ui/design-system.js";
import { AgentSettingsPageHeader } from "./settings-layout.js";

type TreeAction = "connect" | "create";

export function ContextTreeSettings(props: Parameters<typeof ContextTreeSettingsForm>[0]) {
  return <ContextTreeSettingsForm key={props.config.id} {...props} />;
}

function ContextTreeSettingsForm({
  config,
  computerKind = "local",
  online,
  onChanged,
}: {
  config: AgentAdminConfig;
  computerKind?: "local" | "cloud";
  online: boolean;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<TreeAction>();
  const [draft, setDraft] = useState({ owner: "", name: "" });
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [path, setPath] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const ownerInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const repositoryInput = useRef<HTMLInputElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement>(null);
  const [pending, setPending] = useState(false);
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
  const selected = config.runtimeConfig.contextTrees;
  const cloud = computerKind === "cloud";
  const pauseRequired = selected.length > 0 && config.status !== "suspended";
  const activeMode = mode ?? "connect";
  const { source, valid, ownerValid, nameValid, linkedRepository } = parseForm(activeMode, draft, repositoryUrl, path);
  const fieldId = `context-tree-${config.id}`;
  const disabled = pending || !online || pauseRequired;
  const statusMessage = contextTreeStatusMessage(online, pauseRequired);

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
    if (pending) return;
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

  async function run(action: ContextTreeOperationRequest["action"], selectedSource: ContextTreeConnection = source) {
    if (pending || pauseRequired) return;
    if (action !== "disconnect" && (!online || !validateSubmission())) return;
    const input: ContextTreeOperationRequest = {
      ...selectedSource,
      action,
      expectedRevision: config.revision,
      expectedRuntimeConfigRevision: config.runtimeConfig.revision,
    };
    setPending(true);
    setResult(undefined);
    try {
      const response = await executeOperation(config.id, input);
      if (!mounted.current || latestRevision.current !== currentRevision) return;
      setResult(response);
      if (response.status === "completed") setMode(undefined);
      if (response.status === "completed" || response.code === "stale_configuration") onChanged();
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  return (
    <div className="grid gap-6">
      <ContextTreeCollection
        {...{ selected, cloud, pending, pauseRequired, fieldId, addButton, openForm, mode, statusMessage, result }}
        onDisconnect={(entry) => void run("disconnect", entry)}
      />
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
            void run(activeMode);
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
          {statusMessage ? (
            <p role="status" className="text-sm text-kumo-subtle">
              {statusMessage}
            </p>
          ) : null}
          {pending ? <p role="status">{m.agent_settings_context_tree_pending()}</p> : null}
          {result ? <ContextTreeResult result={result} cloud={cloud} /> : null}
          <div className="flex flex-wrap justify-end gap-3 border-t border-kumo-line pt-4">
            <Button variant="secondary" disabled={pending} onClick={closeForm}>
              {m.common_cancel()}
            </Button>
            <Button type="submit" disabled={disabled}>
              {activeMode === "connect"
                ? m.agent_settings_context_tree_connect()
                : m.agent_settings_context_tree_create()}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function ContextTreeCollection({
  selected,
  cloud,
  pending,
  pauseRequired,
  fieldId,
  addButton,
  openForm,
  onDisconnect,
  mode,
  statusMessage,
  result,
}: {
  selected: ContextTreeConnection[];
  cloud: boolean;
  pending: boolean;
  pauseRequired: boolean;
  fieldId: string;
  addButton: RefObject<HTMLButtonElement | null>;
  openForm: (mode: TreeAction, trigger?: HTMLElement | null) => void;
  onDisconnect: (source: ContextTreeConnection) => void;
  mode: TreeAction | undefined;
  statusMessage: string | undefined;
  result: ContextTreeOperationResponse | undefined;
}) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <AgentSettingsPageHeader
          title={m.agent_settings_context_tree_title()}
          description={m.agent_settings_context_tree_description()}
        />
        {selected.length ? (
          <DropdownMenu>
            <DropdownMenu.Trigger render={<Button ref={addButton} disabled={pending || pauseRequired} />}>
              <Icon name="plus" />
              {m.agent_settings_context_tree_add()}
              <Icon name="chevron-down" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item onClick={() => openForm("connect")}>
                <div className="flex items-start gap-3">
                  <Icon name="link" className="mt-1 shrink-0" />
                  <div>
                    <div>{m.agent_settings_context_tree_connect_existing()}</div>
                    <p className="text-sm text-kumo-subtle">{m.agent_settings_context_tree_connect_hint()}</p>
                  </div>
                </div>
              </DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => openForm("create")}>
                <div className="flex items-start gap-3">
                  <Icon name="folder-plus" className="mt-1 shrink-0" />
                  <div>
                    <div>{m.agent_settings_context_tree_create_new()}</div>
                    <p className="text-sm text-kumo-subtle">{m.agent_settings_context_tree_create_hint()}</p>
                  </div>
                </div>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        ) : null}
      </div>
      {selected.length ? (
        <section aria-labelledby={`${fieldId}-connected`} className="grid gap-4">
          <Text as="h2" id={`${fieldId}-connected`} size="lg" variant="heading">
            {m.agent_settings_context_tree_connected_heading()}
          </Text>
          {selected.map((entry, index) => (
            <ContextTreeCard
              key={contextTreeIdentity(entry)}
              source={entry}
              id={`${fieldId}-tree-${index}`}
              disabled={pending || pauseRequired}
              onDisconnect={() => onDisconnect(entry)}
            />
          ))}
        </section>
      ) : (
        <ContextTreeEmptyState pending={pending} onChoose={openForm} />
      )}
      {statusMessage && !mode ? (
        <p role="status" className="text-sm text-kumo-subtle">
          {statusMessage}
        </p>
      ) : null}
      {result && !mode ? (
        result.status === "completed" ? (
          <p role="status" className="sr-only">
            {m.agent_settings_context_tree_completed()}
          </p>
        ) : (
          <ContextTreeResult result={result} cloud={cloud} />
        )
      ) : null}
    </>
  );
}

function ContextTreeEmptyState({
  pending,
  onChoose,
}: {
  pending: boolean;
  onChoose: (mode: TreeAction, trigger: HTMLElement) => void;
}) {
  return (
    <section className="grid justify-items-start gap-3">
      <Text as="h2" size="lg" variant="heading">
        {m.agent_settings_context_tree_empty_title()}
      </Text>
      <div className="grid w-full max-w-lg items-start gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Button disabled={pending} onClick={(event) => onChoose("connect", event.currentTarget)}>
            <Icon name="link" />
            {m.agent_settings_context_tree_connect_existing()}
          </Button>
          <p className="text-sm text-kumo-subtle">{m.agent_settings_context_tree_connect_hint()}</p>
        </div>
        <div className="grid gap-2">
          <Button variant="secondary" disabled={pending} onClick={(event) => onChoose("create", event.currentTarget)}>
            <Icon name="folder-plus" />
            {m.agent_settings_context_tree_create_new()}
          </Button>
          <p className="text-sm text-kumo-subtle">{m.agent_settings_context_tree_create_hint()}</p>
        </div>
      </div>
    </section>
  );
}

function ContextTreeCard({
  source,
  id,
  disabled,
  onDisconnect,
}: {
  source: ContextTreeConnection;
  id: string;
  disabled: boolean;
  onDisconnect: () => void;
}) {
  const name = contextTreeName(source);
  return (
    <article aria-labelledby={id} className="max-w-2xl ui-surface bg-kumo-base p-5">
      <div className="flex items-start gap-4">
        <Icon name="folder" className="mt-1 size-7 shrink-0" />
        <div className="grid min-w-0 flex-1 gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Text as="h3" id={id} size="lg" variant="heading">
              <a
                href={contextTreeSelector(source)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={m.agent_settings_context_tree_open_source({ name })}
                className="inline-flex items-center gap-2 rounded-sm break-all hover:text-kumo-link focus-visible:outline-2 focus-visible:outline-kumo-focus"
              >
                {name}
                <Icon name="external-link" className="size-4 shrink-0" />
              </a>
            </Text>
            <Badge variant="secondary">{m.agent_settings_context_tree_connected_label()}</Badge>
          </div>
          <p className="break-all text-sm text-kumo-subtle">
            {source.repository}
            {source.path === "." ? "" : `/${source.path}`}
          </p>
          <p className="flex min-w-0 items-start gap-2 text-sm text-kumo-subtle">
            <Icon name="branch" className="shrink-0" />
            <span className="sr-only">{m.agent_settings_context_tree_branch()}: </span>
            <span className="break-all">{source.ref}</span>
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <Button variant="ghost" shape="square" aria-label={m.agent_settings_context_tree_actions({ name })} />
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
      </div>
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
      <Field label={m.agent_settings_context_tree_path()} htmlFor={`${fieldId}-path`}>
        <KumoInputControl
          ref={pathInput}
          id={`${fieldId}-path`}
          value={path}
          disabled={pending}
          onChange={(event) => onPathChange(event.target.value)}
          placeholder="docs"
        />
      </Field>
      {submitted && !valid.success && linkedRepository ? (
        <p role="alert">{m.agent_settings_context_tree_source_error()}</p>
      ) : null}
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

function ContextTreeResult({ result, cloud }: { result: ContextTreeOperationResponse; cloud: boolean }) {
  if (result.status === "completed") return <p role="status">{m.agent_settings_context_tree_completed()}</p>;
  return <Banner variant="error" role="alert" description={failureMessage(result.code, cloud)} />;
}

function contextTreeStatusMessage(online: boolean, pauseRequired: boolean): string | undefined {
  if (!online) return m.agent_settings_context_tree_computer_unavailable();
  return pauseRequired ? m.agent_settings_context_tree_pause_required() : undefined;
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
