import {
  type AgentAdminConfig,
  type ContextTreeOperationRequest,
  type ContextTreeOperationResponse,
  ContextTreeRepositorySchema,
} from "@opentag/shared/browser";
import { useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { Button, Field, KumoInputControl, SettingsList, SettingsRow } from "../../../ui/design-system.js";
import { AgentSettingsPageHeader } from "./settings-layout.js";

export function ContextTreeSettings({
  config,
  computerName,
  online,
  onChanged,
}: {
  config: AgentAdminConfig;
  computerName: string;
  online: boolean;
  onChanged: () => void;
}) {
  const [repository, setRepository] = useState(config.runtimeConfig.contextTreeRepository ?? "");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ContextTreeOperationResponse>();
  const attempt = useRef<ContextTreeOperationRequest | undefined>(undefined);
  const selected = config.runtimeConfig.contextTreeRepository;
  const pauseRequired = selected !== null && config.status !== "suspended";
  const valid = ContextTreeRepositorySchema.safeParse(repository);
  const disabled = pending || !online || pauseRequired;

  async function run(action: ContextTreeOperationRequest["action"]) {
    if (disabled || (action !== "disconnect" && !valid.success)) return;
    const nextRepository = action === "disconnect" ? null : valid.success ? valid.data : null;
    // Keep the same ID after a lost response. The Computer owns publication deduplication.
    const previous = attempt.current;
    const input: ContextTreeOperationRequest =
      previous &&
      previous.action === action &&
      previous.repository === nextRepository &&
      previous.expectedRevision === config.revision
        ? previous
        : {
            operationId: crypto.randomUUID(),
            expectedRevision: config.revision,
            expectedRuntimeConfigRevision: config.runtimeConfig.revision,
            action,
            repository: nextRepository,
          };
    attempt.current = input;
    setPending(true);
    setResult(undefined);
    try {
      const response = await browserApi.contextTreeOperation(config.id, input);
      setResult(response);
      if (response.status === "completed" || response.code === "stale_configuration") onChanged();
      if (response.status === "failed" && response.code !== "publication_uncertain") attempt.current = undefined;
    } catch {
      setResult({ status: "failed", code: action === "create" ? "publication_uncertain" : "failed" });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6">
      <AgentSettingsPageHeader title={m.context_tree_title()} description={m.context_tree_description()} />
      <SettingsList>
        <SettingsRow label={m.context_tree_repository()} description={selected ?? m.context_tree_disabled()}>
          <Field label={m.context_tree_repository()} htmlFor={`context-tree-${config.id}`}>
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
      {!online ? (
        <p role="status">{m.context_tree_computer_unavailable()}</p>
      ) : pauseRequired ? (
        <p role="status">{m.context_tree_pause_required()}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || !valid.success} onClick={() => void run("connect")}>
          {m.context_tree_connect()}
        </Button>
        <Button
          variant="secondary"
          disabled={
            disabled || !valid.success || (result?.status === "failed" && result.code === "publication_uncertain")
          }
          onClick={() => void run("create")}
        >
          {m.context_tree_create()}
        </Button>
        <Button variant="ghost" disabled={disabled || selected === null} onClick={() => void run("disconnect")}>
          {m.context_tree_disconnect()}
        </Button>
      </div>
      {pending ? <p role="status">{m.context_tree_pending()}</p> : null}
      {result ? (
        <p role={result.status === "failed" ? "alert" : "status"}>
          {result.status === "completed" ? m.context_tree_completed() : failureMessage(result.code, computerName)}
        </p>
      ) : null}
    </div>
  );
}

function failureMessage(
  code: Extract<ContextTreeOperationResponse, { status: "failed" }>["code"],
  computerName: string,
): string {
  switch (code) {
    case "authentication_required":
      return m.context_tree_authentication_required({ computerName });
    case "permission_denied":
      return m.context_tree_permission_denied();
    case "repository_exists":
      return m.context_tree_repository_exists();
    case "invalid_tree":
      return m.context_tree_invalid_tree();
    case "publication_uncertain":
      return m.context_tree_publication_uncertain();
    case "stale_configuration":
      return m.context_tree_stale_configuration();
    case "capability_missing":
      return m.context_tree_capability_missing();
    case "computer_unavailable":
      return m.context_tree_computer_unavailable();
    case "busy":
      return m.context_tree_busy();
    case "pause_required":
      return m.context_tree_pause_required();
    default:
      return m.context_tree_failed();
  }
}
