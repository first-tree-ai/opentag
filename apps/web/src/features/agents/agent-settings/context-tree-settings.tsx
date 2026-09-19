import {
  type AgentAdminConfig,
  type ContextTreeOperationRequest,
  type ContextTreeOperationResponse,
  ContextTreeRepositorySchema,
} from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { Button, Field, KumoInputControl, SettingsList, SettingsRow } from "../../../ui/design-system.js";
import { AgentSettingsPageHeader } from "./settings-layout.js";

export function ContextTreeSettings(props: Parameters<typeof ContextTreeSettingsForm>[0]) {
  return <ContextTreeSettingsForm key={props.config.id} {...props} />;
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
  const [repository, setRepository] = useState(config.runtimeConfig.contextTreeRepository ?? "");
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
  const selected = config.runtimeConfig.contextTreeRepository;
  const cloud = computerKind === "cloud";
  const pauseRequired = selected !== null && config.status !== "suspended";
  const valid = ContextTreeRepositorySchema.safeParse(repository);
  const disabled = pending || !online || pauseRequired;
  const statusMessage = contextTreeStatusMessage(online, pauseRequired);

  async function run(action: ContextTreeOperationRequest["action"]) {
    if (pending || pauseRequired) return;
    if (action !== "disconnect" && (!online || !valid.success)) return;
    const nextRepository = action === "disconnect" ? null : repository.trim();
    // Keep the same ID after a lost response. The Computer owns publication deduplication.
    const input = operationAttempt(config, action, nextRepository, attempt.current);
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
      <SettingsList>
        <SettingsRow
          label={m.agent_settings_context_tree_repository()}
          description={selected ?? m.agent_settings_context_tree_disabled()}
        >
          <Field label={m.agent_settings_context_tree_repository()} htmlFor={`context-tree-${config.id}`}>
            <KumoInputControl
              id={`context-tree-${config.id}`}
              value={repository}
              disabled={pending}
              placeholder="OWNER/REPO"
              onChange={(event) => setRepository(event.target.value)}
            />
          </Field>
        </SettingsRow>
      </SettingsList>
      {statusMessage ? <p role="status">{statusMessage}</p> : null}
      {cloud ? <p className="text-sm text-kumo-subtle">{m.agent_settings_context_tree_cloud_guidance()}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || !valid.success} onClick={() => void run("connect")}>
          {m.agent_settings_context_tree_connect()}
        </Button>
        {cloud ? null : (
          <Button variant="secondary" disabled={disabled || !valid.success} onClick={() => void run("create")}>
            {m.agent_settings_context_tree_create()}
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={pending || pauseRequired || selected === null}
          onClick={() => void run("disconnect")}
        >
          {m.agent_settings_context_tree_disconnect()}
        </Button>
      </div>
      {pending ? <p role="status">{m.agent_settings_context_tree_pending()}</p> : null}
      {result ? <ContextTreeResult result={result} computerName={computerName} cloud={cloud} /> : null}
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
      return m.agent_settings_context_tree_permission_denied();
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
      return m.agent_settings_context_tree_failed();
  }
}

function operationAttempt(
  config: AgentAdminConfig,
  action: ContextTreeOperationRequest["action"],
  repository: string | null,
  previous?: ContextTreeOperationRequest,
): ContextTreeOperationRequest {
  if (
    previous?.action === action &&
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
