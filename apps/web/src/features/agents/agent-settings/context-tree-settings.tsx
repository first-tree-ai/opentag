import {
  type AgentAdminConfig,
  ContextTreeAliasSchema,
  type ContextTreeOperationRequest,
  type ContextTreeOperationResponse,
  ContextTreeRepositorySchema,
} from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { Button, Field, KumoInputControl, SettingsList } from "../../../ui/design-system.js";
import { AgentSettingsPageHeader } from "./settings-layout.js";

export function ContextTreeSettings(props: Parameters<typeof ContextTreeSettingsForm>[0]) {
  return <ContextTreeSettingsForm key={props.config.id} {...props} />;
}

function repositoryDrafts(repository: string | null) {
  const [owner = "", name = ""] = (repository ?? "").split("/");
  return { connect: { owner, name }, create: { owner: "", name: "" } };
}

function ContextTreeSettingsForm({
  config,
  computerName,
  computerKind = "local",
  online,
  onChanged,
}: {
  config: AgentAdminConfig;
  computerName: string;
  computerKind?: "local" | "cloud";
  online: boolean;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"connect" | "create">("connect");
  const [drafts, setDrafts] = useState(() => repositoryDrafts(null));
  const [alias, setAlias] = useState("");
  const aliasInput = useRef<HTMLInputElement>(null);
  const aliasValid = ContextTreeAliasSchema.safeParse(alias).success;
  const [submitted, setSubmitted] = useState(false);
  const ownerInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ContextTreeOperationResponse>();
  const attempt = useRef<ContextTreeOperationRequest | undefined>(undefined);
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
  const activeMode = cloud ? "connect" : mode;
  const draft = drafts[activeMode];
  const owner = draft.owner.trim();
  const name = draft.name.trim();
  const repository = `${owner}/${name}`;
  // Validate each part through the shared schema, keeping its rules authoritative.
  const ownerValid = ContextTreeRepositorySchema.safeParse(`${owner}/memory`).success;
  const nameValid = ContextTreeRepositorySchema.safeParse(`acme/${name}`).success;
  const valid = ContextTreeRepositorySchema.safeParse(repository);
  const fieldId = `context-tree-${config.id}`;

  function switchMode(next: "connect" | "create") {
    setMode(next);
    setSubmitted(false);
    setResult(undefined);
  }

  function updateDraft(field: "owner" | "name", value: string) {
    setDrafts((previous) => ({ ...previous, [activeMode]: { ...previous[activeMode], [field]: value } }));
    setResult(undefined);
  }
  const disabled = pending || !online || pauseRequired;
  const statusMessage = contextTreeStatusMessage(online, pauseRequired);

  function validateSubmission() {
    setSubmitted(true);
    if (!aliasValid) {
      aliasInput.current?.focus();
      return false;
    }
    if (valid.success) return true;
    (ownerValid ? nameInput : ownerInput).current?.focus();
    return false;
  }

  async function run(action: ContextTreeOperationRequest["action"], selectedAlias = alias) {
    if (pending || pauseRequired) return;
    if (action !== "disconnect" && (!online || !validateSubmission())) return;
    const nextRepository = action === "disconnect" ? null : repository.trim();
    // Keep the same ID after a lost response. The Computer owns publication deduplication.
    const input = operationAttempt(config, action, selectedAlias, nextRepository, attempt.current);
    attempt.current = input;
    setPending(true);
    setResult(undefined);
    try {
      const response = await executeOperation(config.id, input);
      if (!mounted.current || latestRevision.current !== currentRevision) return;
      setResult(response);
      if (response.status === "completed" || response.code === "stale_configuration") onChanged();
      if (response.status === "failed" && response.code !== "publication_uncertain") attempt.current = undefined;
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  return (
    <div className="grid gap-6">
      <AgentSettingsPageHeader
        title={m.agent_settings_context_tree_title()}
        description={m.agent_settings_context_tree_description()}
      />
      {selected.length ? (
        selected.map((entry) => (
          <div key={entry.alias} className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" className="min-w-0 break-all">
              {m.agent_settings_context_tree_connected_alias({ alias: entry.alias, repository: entry.repository })}
            </p>
            <Button
              variant="ghost"
              disabled={pending || pauseRequired}
              onClick={() => void run("disconnect", entry.alias)}
            >
              {m.agent_settings_context_tree_disconnect()}
            </Button>
          </div>
        ))
      ) : (
        <p role="status">{m.agent_settings_context_tree_disabled()}</p>
      )}
      <SettingsList>
        <form
          className="grid gap-4 p-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void run(activeMode);
          }}
        >
          <RepositoryMode {...{ activeMode, cloud, pending, switchMode }} />
          <p className="text-sm text-kumo-subtle">
            {activeMode === "connect"
              ? m.agent_settings_context_tree_connect_guidance()
              : m.agent_settings_context_tree_create_guidance()}
          </p>
          <AliasField
            fieldId={fieldId}
            alias={alias}
            inputRef={aliasInput}
            pending={pending}
            invalid={submitted && !aliasValid}
            onChange={(value) => {
              setAlias(value);
              setResult(undefined);
            }}
          />
          <RepositoryFields
            {...{ fieldId, draft, pending, submitted, ownerValid, nameValid, ownerInput, nameInput, updateDraft }}
          />
          {owner && name ? <p className="break-all text-sm text-kumo-subtle">github.com/{repository}</p> : null}
          {statusMessage ? <p role="status">{statusMessage}</p> : null}
          {cloud ? <p className="text-sm text-kumo-subtle">{m.agent_settings_context_tree_cloud_guidance()}</p> : null}
          <div>
            <Button type="submit" disabled={disabled}>
              {activeMode === "connect"
                ? m.agent_settings_context_tree_connect()
                : m.agent_settings_context_tree_create()}
            </Button>
          </div>
        </form>
      </SettingsList>
      {pending ? <p role="status">{m.agent_settings_context_tree_pending()}</p> : null}
      {result ? <ContextTreeResult result={result} computerName={computerName} cloud={cloud} /> : null}
    </div>
  );
}

function AliasField({
  fieldId,
  alias,
  inputRef,
  pending,
  invalid,
  onChange,
}: {
  fieldId: string;
  alias: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  pending: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      label={m.agent_settings_context_tree_alias()}
      htmlFor={`${fieldId}-alias`}
      error={invalid ? m.agent_settings_context_tree_alias_error() : undefined}
      errorId={`${fieldId}-alias-error`}
    >
      <KumoInputControl
        ref={inputRef}
        id={`${fieldId}-alias`}
        value={alias}
        disabled={pending}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${fieldId}-alias-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function RepositoryMode({
  activeMode,
  cloud,
  pending,
  switchMode,
}: {
  activeMode: "connect" | "create";
  cloud: boolean;
  pending: boolean;
  switchMode: (mode: "connect" | "create") => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant={activeMode === "connect" ? "primary" : "secondary"}
        aria-pressed={activeMode === "connect"}
        disabled={pending}
        onClick={() => switchMode("connect")}
      >
        {m.agent_settings_context_tree_connect_existing()}
      </Button>
      {cloud ? null : (
        <Button
          type="button"
          variant={activeMode === "create" ? "primary" : "secondary"}
          aria-pressed={activeMode === "create"}
          disabled={pending}
          onClick={() => switchMode("create")}
        >
          {m.agent_settings_context_tree_create_new()}
        </Button>
      )}
    </div>
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
    <div className="grid items-start gap-4 sm:grid-cols-2">
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

function ContextTreeResult({
  result,
  computerName,
  cloud,
}: {
  result: ContextTreeOperationResponse;
  computerName: string;
  cloud: boolean;
}) {
  if (result.status === "completed") return <p role="status">{m.agent_settings_context_tree_completed()}</p>;
  return <p role="alert">{failureMessage(result.code, computerName, cloud)}</p>;
}

function contextTreeStatusMessage(online: boolean, pauseRequired: boolean): string | undefined {
  if (!online) return m.agent_settings_context_tree_computer_unavailable();
  return pauseRequired ? m.agent_settings_context_tree_pause_required() : undefined;
}

function failureMessage(
  code: Extract<ContextTreeOperationResponse, { status: "failed" }>["code"],
  computerName: string,
  cloud: boolean,
): string {
  switch (code) {
    case "authentication_required":
      return cloud
        ? m.agent_settings_context_tree_cloud_authentication_required()
        : m.agent_settings_context_tree_authentication_required({ computerName });
    case "permission_denied":
      return cloud
        ? m.agent_settings_context_tree_cloud_permission_denied()
        : m.agent_settings_context_tree_permission_denied();
    case "alias_conflict":
      return m.agent_settings_context_tree_alias_conflict();
    case "repository_conflict":
      return m.agent_settings_context_tree_repository_conflict();
    case "repository_exists":
      return m.agent_settings_context_tree_repository_exists();
    case "invalid_tree":
      return m.agent_settings_context_tree_invalid_tree();
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

function operationAttempt(
  config: AgentAdminConfig,
  action: ContextTreeOperationRequest["action"],
  alias: string,
  repository: string | null,
  previous?: ContextTreeOperationRequest,
): ContextTreeOperationRequest {
  if (
    previous?.action === action &&
    previous.alias === alias &&
    previous.repository?.toLowerCase() === repository?.toLowerCase() &&
    previous.expectedRevision === config.revision &&
    previous.expectedRuntimeConfigRevision === config.runtimeConfig.revision
  )
    return previous;
  return {
    operationId: crypto.randomUUID(),
    expectedRevision: config.revision,
    expectedRuntimeConfigRevision: config.runtimeConfig.revision,
    action,
    alias,
    repository,
  };
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
