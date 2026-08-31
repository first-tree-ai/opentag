import {
  type AgentAdminConfig,
  getRuntimeConfigurationOptions,
  type UpdateAgentRuntimeConfig,
} from "@opentag/shared/browser";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import {
  Button,
  Dialog,
  Field,
  KumoInputControl,
  KumoSelectControl,
  SettingsList,
  SettingsRow,
  Text,
} from "../../../ui/design-system.js";
import type { AgentDetailView } from "../agent-model.js";

const CUSTOM_MODEL_OPTION = "__custom_model__";

export function AgentModelSettings({
  agent,
  config: initialConfig,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  config: AgentAdminConfig;
  onAgentChanged: () => void;
}) {
  const [config, setConfig] = useState(initialConfig);
  const [editing, setEditing] = useState(false);
  const [modelDraft, setModelDraft] = useState(initialConfig.runtimeConfig.model ?? "");
  const [modelSelection, setModelSelection] = useState(() => modelSelectionFor(initialConfig));
  const [reasoningDraft, setReasoningDraft] = useState(initialConfig.runtimeConfig.reasoningEffort ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const editingRef = useRef(false);
  const pendingConfigRef = useRef<AgentAdminConfig | undefined>(undefined);
  const runtimeOptions = getRuntimeConfigurationOptions(config.runtimeProvider);
  const hasHistoricalReasoningDraft =
    reasoningDraft !== "" && !runtimeOptions.reasoningEffortAllowedValues.includes(reasoningDraft);
  const normalizedModelDraft = nullableText(modelDraft);
  const customModelInvalid = modelSelection === CUSTOM_MODEL_OPTION && normalizedModelDraft === null;
  const dirty =
    normalizedModelDraft !== config.runtimeConfig.model ||
    reasoningDraft !== (config.runtimeConfig.reasoningEffort ?? "");
  const fieldId = (name: string) => `model-settings-${name}-${config.id}`;

  useEffect(() => {
    if (editingRef.current) {
      pendingConfigRef.current = newerConfig(pendingConfigRef.current, initialConfig);
      return;
    }
    setConfig((current) => newerConfig(current, initialConfig));
  }, [initialConfig]);

  function openEditor() {
    editingRef.current = true;
    pendingConfigRef.current = undefined;
    setModelDraft(config.runtimeConfig.model ?? "");
    setModelSelection(modelSelectionFor(config));
    setReasoningDraft(config.runtimeConfig.reasoningEffort ?? "");
    setError(undefined);
    setMessage(undefined);
    setEditing(true);
  }

  function closeEditor() {
    editingRef.current = false;
    const pendingConfig = pendingConfigRef.current;
    pendingConfigRef.current = undefined;
    if (pendingConfig) setConfig((current) => newerConfig(current, pendingConfig));
    setEditing(false);
    setError(undefined);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving || customModelInvalid) return;
    setSaving(true);
    setError(undefined);
    try {
      const runtimeConfig: UpdateAgentRuntimeConfig = {
        model: normalizedModelDraft,
        reasoningEffort: nullableText(reasoningDraft),
      };
      const updated = await browserApi.updateAgent(config.id, {
        expectedRevision: config.revision,
        runtimeConfig,
      });
      const pendingConfig = pendingConfigRef.current;
      const resolvedConfig = pendingConfig ? newerConfig(updated, pendingConfig) : updated;
      setConfig(resolvedConfig);
      setModelDraft(resolvedConfig.runtimeConfig.model ?? "");
      setModelSelection(modelSelectionFor(resolvedConfig));
      setReasoningDraft(resolvedConfig.runtimeConfig.reasoningEffort ?? "");
      setMessage("Model settings saved.");
      editingRef.current = false;
      pendingConfigRef.current = undefined;
      setEditing(false);
      onAgentChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save model settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={`model-settings-heading-${config.id}`} className="grid gap-4" data-agent-id={agent.id}>
      <Text as="h2" id={`model-settings-heading-${config.id}`} variant="heading">
        Model
      </Text>
      <SettingsList>
        <SettingsRow description="Fixed after creation." label="Runtime">
          <p className="text-sm text-kumo-default">{runtimeProviderName(config.runtimeProvider)}</p>
        </SettingsRow>
        <SettingsRow label="Model">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 break-words text-sm text-kumo-default">
              {config.runtimeConfig.model ?? "Provider default"}
            </p>
            <Button ref={changeButtonRef} size="compact" variant="secondary" onClick={openEditor}>
              Change
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow label="Reasoning">
          <p className="text-sm text-kumo-default">{reasoningLabel(config.runtimeConfig.reasoningEffort)}</p>
        </SettingsRow>
      </SettingsList>
      {message ? <p role="status">{message}</p> : null}
      {editing ? (
        <Dialog
          busy={saving}
          description="Choose the model and reasoning level this Agent uses."
          returnFocusRef={changeButtonRef}
          title="Change model"
          onClose={closeEditor}
        >
          <form className="grid gap-4" onSubmit={save}>
            <Field htmlFor={fieldId("model")} label="Model">
              <KumoSelectControl
                id={fieldId("model")}
                value={modelSelection}
                onChange={(event) => {
                  const selection = event.currentTarget.value;
                  setModelSelection(selection);
                  if (selection === CUSTOM_MODEL_OPTION) {
                    if (modelSelection !== CUSTOM_MODEL_OPTION) setModelDraft("");
                  } else {
                    setModelDraft(selection);
                  }
                  setError(undefined);
                }}
              >
                <option value="">Provider default</option>
                {runtimeOptions.modelSuggestions.map((model) => (
                  <option value={model} key={model}>
                    {model}
                  </option>
                ))}
                <option value={CUSTOM_MODEL_OPTION}>Custom model ID…</option>
              </KumoSelectControl>
            </Field>
            {modelSelection === CUSTOM_MODEL_OPTION ? (
              <Field htmlFor={fieldId("custom-model")} label="Custom model ID">
                <KumoInputControl
                  autoComplete="off"
                  id={fieldId("custom-model")}
                  required
                  value={modelDraft}
                  onChange={(event) => {
                    setModelDraft(event.currentTarget.value);
                    setError(undefined);
                  }}
                />
              </Field>
            ) : null}
            <Field htmlFor={fieldId("reasoning-effort")} label="Reasoning level">
              <KumoSelectControl
                id={fieldId("reasoning-effort")}
                value={reasoningDraft}
                onChange={(event) => {
                  setReasoningDraft(event.currentTarget.value);
                  setError(undefined);
                }}
              >
                <option value="">Provider default</option>
                {hasHistoricalReasoningDraft ? (
                  <option value={reasoningDraft}>{reasoningDraft} (saved value)</option>
                ) : null}
                {runtimeOptions.reasoningEffortAllowedValues.map((effort) => (
                  <option value={effort} key={effort}>
                    {effort}
                  </option>
                ))}
              </KumoSelectControl>
            </Field>
            {error ? (
              <p className="text-sm text-kumo-danger" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2 border-t border-kumo-line pt-4">
              <Button disabled={saving} variant="ghost" onClick={closeEditor}>
                Cancel
              </Button>
              <Button disabled={!dirty || saving || customModelInvalid} type="submit">
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}

function modelSelectionFor(config: AgentAdminConfig): string {
  const model = config.runtimeConfig.model;
  if (model === null) return "";
  const suggestions = getRuntimeConfigurationOptions(config.runtimeProvider).modelSuggestions;
  return suggestions.includes(model) ? model : CUSTOM_MODEL_OPTION;
}

function newerConfig(current: AgentAdminConfig | undefined, candidate: AgentAdminConfig): AgentAdminConfig {
  if (!current || current.id !== candidate.id || candidate.revision >= current.revision) return candidate;
  return current;
}

function runtimeProviderName(provider: AgentAdminConfig["runtimeProvider"]): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

function reasoningLabel(value: string | null): string {
  if (!value) return "Provider default";
  const labels: Record<string, string> = {
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "XHigh",
    max: "Max",
  };
  return labels[value] ?? value;
}

function nullableText(value: string): string | null {
  const text = value.trim();
  return text || null;
}
