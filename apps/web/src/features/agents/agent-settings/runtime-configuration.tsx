import {
  type AgentAdminConfig,
  getRuntimeConfigurationOptions,
  type UpdateAgentRequest,
  type UpdateAgentRuntimeConfig,
} from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import * as m from "../../../paraglide/messages.js";
import {
  Banner,
  Button,
  InputArea,
  KumoInputControl,
  Select,
  SettingsList,
  SettingsRow,
  Text,
} from "../../../ui/design-system.js";
import { RuntimeTestAction } from "./runtime-test-action.js";

const CUSTOM_MODEL_OPTION = "__custom_model__";
const PROVIDER_DEFAULT_OPTION = "__provider_default__";

export interface RuntimeConfigurationFormProps {
  readonly computerOnline?: boolean;
  readonly initialConfig: AgentAdminConfig;
  readonly save: (input: UpdateAgentRequest) => Promise<AgentAdminConfig>;
  readonly section?: "all" | "execution" | "instructions";
}

export function RuntimeConfigurationForm({
  computerOnline = true,
  initialConfig,
  save,
  section = "all",
}: RuntimeConfigurationFormProps) {
  return (
    <RuntimeConfigurationEditor
      computerOnline={computerOnline}
      initialConfig={initialConfig}
      save={save}
      section={section}
    />
  );
}

function RuntimeConfigurationEditor({
  computerOnline = true,
  initialConfig,
  save,
  section = "all",
}: RuntimeConfigurationFormProps) {
  const initialOptions = getRuntimeConfigurationOptions(initialConfig.runtimeProvider);
  const [config, setConfig] = useState(initialConfig);
  const [modelDraft, setModelDraft] = useState(initialConfig.runtimeConfig.model ?? "");
  const [modelSelection, setModelSelection] = useState(() =>
    modelSelectionFor(initialConfig.runtimeConfig.model, initialOptions.modelSuggestions),
  );
  const [reasoningSelection, setReasoningSelection] = useState(
    initialConfig.runtimeConfig.reasoningEffort ?? PROVIDER_DEFAULT_OPTION,
  );
  const [instructionsDraft, setInstructionsDraft] = useState(initialConfig.runtimeConfig.instructions);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    section: "runtime" | "instructions";
    text: string;
  }>();
  const [saving, setSaving] = useState<"runtime" | "instructions">();
  const fieldId = (name: string) => `runtime-${name}-${config.id}`;
  const providerName = config.runtimeProvider === "codex" ? "Codex" : "Claude Code";
  const ExecutionHeading = section === "execution" ? "h1" : "h3";
  const InstructionsHeading = section === "instructions" ? "h1" : "h3";
  const TroubleshootingHeading = section === "execution" ? "h2" : "h3";
  const runtimeOptions = getRuntimeConfigurationOptions(config.runtimeProvider);
  const hasHistoricalReasoningDraft =
    reasoningSelection !== PROVIDER_DEFAULT_OPTION &&
    !runtimeOptions.reasoningEffortAllowedValues.includes(reasoningSelection);
  const reasoningDraft = reasoningSelection === PROVIDER_DEFAULT_OPTION ? "" : reasoningSelection;
  const runtimeDirty =
    modelDraft !== (config.runtimeConfig.model ?? "") ||
    reasoningDraft !== (config.runtimeConfig.reasoningEffort ?? "");
  const customModelInvalid = modelSelection === CUSTOM_MODEL_OPTION && modelDraft.trim().length === 0;
  const instructionsDirty = instructionsDraft !== config.runtimeConfig.instructions;

  async function saveRuntime(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || customModelInvalid) return;
    setSaving("runtime");
    setMessage(undefined);
    try {
      const runtimeConfig: UpdateAgentRuntimeConfig = {
        model: nullableText(modelDraft),
        reasoningEffort: nullableText(reasoningDraft),
      };
      const updated = await save({ expectedRevision: config.revision, runtimeConfig });
      const updatedOptions = getRuntimeConfigurationOptions(updated.runtimeProvider);
      setConfig(updated);
      setModelDraft(updated.runtimeConfig.model ?? "");
      setModelSelection(modelSelectionFor(updated.runtimeConfig.model, updatedOptions.modelSuggestions));
      setReasoningSelection(updated.runtimeConfig.reasoningEffort ?? PROVIDER_DEFAULT_OPTION);
      setMessage({ kind: "success", section: "runtime", text: m.agent_settings_model_saved() });
    } catch {
      setMessage({ kind: "error", section: "runtime", text: m.agent_settings_execution_save_failed() });
    } finally {
      setSaving(undefined);
    }
  }

  async function saveInstructions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving("instructions");
    setMessage(undefined);
    try {
      const updated = await save({
        expectedRevision: config.revision,
        runtimeConfig: { instructions: instructionsDraft },
      });
      setConfig(updated);
      setInstructionsDraft(updated.runtimeConfig.instructions);
      setMessage({ kind: "success", section: "instructions", text: m.agent_settings_instructions_saved() });
    } catch {
      setMessage({ kind: "error", section: "instructions", text: m.agent_settings_instructions_save_failed() });
    } finally {
      setSaving(undefined);
    }
  }

  function discardRuntimeChanges() {
    setModelDraft(config.runtimeConfig.model ?? "");
    setModelSelection(modelSelectionFor(config.runtimeConfig.model, runtimeOptions.modelSuggestions));
    setReasoningSelection(config.runtimeConfig.reasoningEffort ?? PROVIDER_DEFAULT_OPTION);
    setMessage(undefined);
  }

  return (
    <div className="grid gap-6" data-ui={section === "all" ? "runtime-settings" : "settings-section"}>
      {section !== "instructions" ? (
        <section aria-labelledby="execution-heading" className="grid gap-4">
          <ExecutionHeading id="execution-heading">{m.agent_settings_model()}</ExecutionHeading>
          <form className="grid gap-4" onSubmit={saveRuntime}>
            <SettingsList>
              <SettingsRow description={m.agent_settings_runtime_fixed()} label={m.agent_settings_runtime()}>
                <div className="flex justify-start @min-[44rem]/workspace:justify-end">
                  <span className="text-sm text-kumo-default">{providerName}</span>
                </div>
              </SettingsRow>
              <SettingsRow label={m.agent_settings_model()}>
                <div className="grid w-full gap-2 @min-[44rem]/workspace:ml-auto @min-[44rem]/workspace:max-w-80">
                  <Select
                    aria-label={m.agent_settings_model()}
                    className="w-full"
                    id={fieldId("model")}
                    itemToStringLabel={(value) => modelOptionLabel(String(value))}
                    value={modelSelection}
                    onValueChange={(nextValue) => {
                      const selection = String(nextValue);
                      setModelSelection(selection);
                      if (selection === CUSTOM_MODEL_OPTION) {
                        if (modelSelection !== CUSTOM_MODEL_OPTION) setModelDraft("");
                      } else {
                        setModelDraft(selection === PROVIDER_DEFAULT_OPTION ? "" : selection);
                      }
                      setMessage(undefined);
                    }}
                  >
                    <Select.Option value={PROVIDER_DEFAULT_OPTION}>{m.agent_settings_provider_default()}</Select.Option>
                    {runtimeOptions.modelSuggestions.map((model) => (
                      <Select.Option value={model} key={model}>
                        {model}
                      </Select.Option>
                    ))}
                    <Select.Option value={CUSTOM_MODEL_OPTION}>{m.agent_settings_model_custom()}</Select.Option>
                  </Select>
                  {modelSelection === CUSTOM_MODEL_OPTION ? (
                    <KumoInputControl
                      aria-label={m.agent_settings_model_custom_label()}
                      autoComplete="off"
                      id={fieldId("custom-model")}
                      required
                      value={modelDraft}
                      onChange={(event) => {
                        setModelDraft(event.currentTarget.value);
                        setMessage(undefined);
                      }}
                    />
                  ) : null}
                </div>
              </SettingsRow>
              <SettingsRow
                description={m.agent_settings_reasoning_effort_description()}
                label={m.agent_settings_reasoning_effort()}
              >
                <div className="w-full @min-[44rem]/workspace:ml-auto @min-[44rem]/workspace:max-w-80">
                  <Select
                    aria-label={m.agent_settings_reasoning_effort()}
                    className="w-full"
                    id={fieldId("reasoning-effort")}
                    itemToStringLabel={(value) => reasoningOptionLabel(String(value))}
                    name="reasoningEffort"
                    value={reasoningSelection}
                    onValueChange={(nextValue) => {
                      setReasoningSelection(String(nextValue));
                      setMessage(undefined);
                    }}
                  >
                    <Select.Option value={PROVIDER_DEFAULT_OPTION}>{m.agent_settings_provider_default()}</Select.Option>
                    {hasHistoricalReasoningDraft ? (
                      <Select.Option value={reasoningSelection}>
                        {m.agent_settings_reasoning_saved_value({ value: reasoningSelection })}
                      </Select.Option>
                    ) : null}
                    {runtimeOptions.reasoningEffortAllowedValues.map((effort) => (
                      <Select.Option value={effort} key={effort}>
                        {reasoningOptionLabel(effort)}
                      </Select.Option>
                    ))}
                  </Select>
                </div>
              </SettingsRow>
            </SettingsList>
            {runtimeDirty ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
                <span className="text-sm text-kumo-subtle">{m.agent_settings_unsaved_changes()}</span>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button disabled={Boolean(saving)} variant="ghost" onClick={discardRuntimeChanges}>
                    {m.agent_settings_discard()}
                  </Button>
                  <Button disabled={Boolean(saving) || customModelInvalid} type="submit">
                    {saving === "runtime" ? m.agent_settings_saving() : m.agent_settings_save_changes()}
                  </Button>
                </div>
              </div>
            ) : null}
          </form>
          {message?.section === "runtime" ? <SaveMessage message={message} /> : null}
          <section aria-labelledby="runtime-test-heading" className="mt-2 grid gap-3">
            <Text as={TroubleshootingHeading} id="runtime-test-heading" variant="heading">
              {m.agent_settings_troubleshooting()}
            </Text>
            <SettingsList>
              <RuntimeTestAction
                agentId={config.id}
                disabledReason={
                  runtimeDirty
                    ? m.agent_settings_runtime_test_disabled_unsaved()
                    : computerOnline
                      ? undefined
                      : m.agent_settings_runtime_test_disabled_computer()
                }
                expectedRevision={config.revision}
                expectedRuntimeConfigRevision={config.runtimeConfig.revision}
                providerName={providerName}
              />
            </SettingsList>
          </section>
        </section>
      ) : null}

      {section !== "execution" ? (
        <section aria-labelledby="agent-instructions-heading" className="grid gap-4">
          <header className="grid gap-2">
            <InstructionsHeading id="agent-instructions-heading">
              {m.agent_settings_instructions_title()}
            </InstructionsHeading>
            <p className="text-sm text-kumo-subtle">{m.agent_settings_instructions_description()}</p>
          </header>
          <form className="grid gap-4" onSubmit={saveInstructions}>
            <InputArea
              aria-label={m.agent_settings_instructions_title()}
              autoResize
              id={fieldId("instructions")}
              maxRows={16}
              minRows={8}
              name="instructions"
              placeholder={m.agent_settings_instructions_placeholder()}
              value={instructionsDraft}
              onValueChange={(value) => {
                setInstructionsDraft(value);
                setMessage(undefined);
              }}
            />
            {instructionsDirty ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
                <span className="text-sm text-kumo-subtle">{m.agent_settings_unsaved_changes()}</span>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    disabled={Boolean(saving)}
                    variant="ghost"
                    onClick={() => {
                      setInstructionsDraft(config.runtimeConfig.instructions);
                      setMessage(undefined);
                    }}
                  >
                    {m.agent_settings_discard()}
                  </Button>
                  <Button disabled={Boolean(saving)} type="submit">
                    {saving === "instructions" ? m.agent_settings_saving() : m.agent_settings_save_changes()}
                  </Button>
                </div>
              </div>
            ) : null}
          </form>
          {message?.section === "instructions" ? <SaveMessage message={message} /> : null}
        </section>
      ) : null}
    </div>
  );
}

function modelSelectionFor(model: string | null, suggestions: readonly string[]): string {
  if (model === null) return PROVIDER_DEFAULT_OPTION;
  return suggestions.includes(model) ? model : CUSTOM_MODEL_OPTION;
}

function modelOptionLabel(value: string): string {
  if (value === PROVIDER_DEFAULT_OPTION) return m.agent_settings_provider_default();
  if (value === CUSTOM_MODEL_OPTION) return m.agent_settings_model_custom();
  return value;
}

function reasoningOptionLabel(value: string): string {
  if (value === PROVIDER_DEFAULT_OPTION) return m.agent_settings_provider_default();
  return (
    {
      minimal: m.agent_settings_reasoning_minimal(),
      low: m.agent_settings_reasoning_low(),
      medium: m.agent_settings_reasoning_medium(),
      high: m.agent_settings_reasoning_high(),
      xhigh: m.agent_settings_reasoning_extra_high(),
      max: m.agent_settings_reasoning_max(),
    }[value] ?? value
  );
}

function SaveMessage({ message }: { message: { kind: "error" | "success"; text: string } }) {
  return (
    <Banner
      description={message.text}
      role={message.kind === "error" ? "alert" : "status"}
      variant={message.kind === "error" ? "error" : "secondary"}
    />
  );
}

export function runtimeConfigurationFromForm(data: FormData): UpdateAgentRuntimeConfig {
  return {
    model: nullableText(data.get("model")),
    reasoningEffort: nullableText(data.get("reasoningEffort")),
  };
}

function nullableText(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}
