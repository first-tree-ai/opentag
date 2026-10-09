import {
  type AgentAdminConfig,
  type AgentRuntimeOptions,
  getRuntimeConfigurationOptions,
  type RuntimeConfigurationOptions,
  type UpdateAgentRequest,
  type UpdateAgentRuntimeConfig,
} from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError, browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { queryKeys } from "../../../query/keys.js";
import { liveResourceQueryOptions } from "../../../query/live.js";
import { Banner, Button, Select, SettingsList, SettingsRow, Text } from "../../../ui/design-system.js";
import { isConfirmedQuerySuccess } from "../../resource/resource-state.js";
import { runtimeProviderName } from "../agent-presentation.js";
import { type CloudModelState, RuntimeModelField, runtimeModelField } from "./runtime-model-field.js";
import { RuntimeTestAction } from "./runtime-test-action.js";
import { AgentSettingsPageHeader, SettingsSaveActions, UnsavedChangesGuard } from "./settings-layout.js";
import { SoulEditor } from "./soul-editor.js";

const CUSTOM_MODEL_OPTION = "__custom_model__";
const PROVIDER_DEFAULT_OPTION = "__provider_default__";

export interface RuntimeConfigurationFormProps {
  readonly computerKind?: "local" | "cloud";
  readonly computerOnline?: boolean;
  readonly initialConfig: AgentAdminConfig;
  readonly save: (input: UpdateAgentRequest) => Promise<AgentAdminConfig>;
  readonly section?: "all" | "execution" | "instructions";
}

export function RuntimeConfigurationForm(props: RuntimeConfigurationFormProps) {
  if (props.computerKind === "cloud" && props.section !== "instructions") {
    return (
      <CloudRuntimeConfigurationForm
        key={`${props.initialConfig.id}:${props.initialConfig.computerId}:${props.initialConfig.runtimeProvider}`}
        {...props}
      />
    );
  }
  return (
    <RuntimeConfigurationEditor
      key={`${props.initialConfig.id}:${props.initialConfig.computerId}:${props.initialConfig.runtimeProvider}`}
      {...props}
    />
  );
}

function CloudRuntimeConfigurationForm(props: RuntimeConfigurationFormProps) {
  const query = useQuery({
    queryKey: queryKeys.cloudModelOptions(),
    queryFn: () => browserApi.cloudModelOptions(),
    ...liveResourceQueryOptions,
  });
  const cloudModelState: CloudModelState =
    isConfirmedQuerySuccess(query) && query.data?.available
      ? { kind: "ready", value: query.data }
      : query.isPending
        ? { kind: "loading" }
        : { kind: "unavailable", retry: () => void query.refetch() };
  return <RuntimeConfigurationEditor {...props} cloudModelState={cloudModelState} />;
}

function RuntimeConfigurationEditor({
  computerKind = "local",
  computerOnline = true,
  cloudModelState,
  initialConfig,
  save,
  section = "all",
}: RuntimeConfigurationFormProps & { cloudModelState?: CloudModelState }) {
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
  const providerName = runtimeProviderName(config.runtimeProvider);
  const TroubleshootingHeading = section === "execution" ? "h2" : "h3";
  const cloud = computerKind === "cloud";
  const localOptions = useLocalRuntimeOptions(
    initialConfig,
    modelDraft,
    !cloud && section !== "instructions" && computerOnline,
  );
  const discovered = localDiscoveredOptions(localOptions, cloud, computerOnline);
  const runtimeOptions = formRuntimeOptions(config.runtimeProvider, discovered);
  const defaultLabel = reasoningOptionLabel(PROVIDER_DEFAULT_OPTION, cloud);
  const cloudOptions = cloudModelState?.kind === "ready" ? cloudModelState.value : undefined;
  const modelField = runtimeModelField({
    cloud,
    cloudOptions,
    modelDraft,
    modelSelection: visibleModelSelection(modelSelection, modelDraft, runtimeOptions.modelSuggestions),
    runtimeOptions,
  });
  const { unavailable: cloudModelsUnavailable, invalid: modelInvalid } = modelField;
  const hasHistoricalReasoningDraft =
    reasoningSelection !== PROVIDER_DEFAULT_OPTION &&
    !runtimeOptions.reasoningEffortAllowedValues.includes(reasoningSelection);
  const reasoningDraft = reasoningSelection === PROVIDER_DEFAULT_OPTION ? "" : reasoningSelection;
  const runtimeDirty =
    modelDraft !== (config.runtimeConfig.model ?? "") ||
    reasoningDraft !== (config.runtimeConfig.reasoningEffort ?? "");
  const reasoningInvalid = invalidNewReasoning(discovered, hasHistoricalReasoningDraft, runtimeDirty, cloud);
  const instructionsDirty = instructionsDraft !== config.runtimeConfig.instructions;

  async function saveRuntime(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || modelFieldInvalid(modelInvalid, reasoningInvalid)) return;
    setSaving("runtime");
    setMessage(undefined);
    try {
      const runtimeConfig: UpdateAgentRuntimeConfig = {
        model: nullableText(modelDraft),
        reasoningEffort: nullableText(reasoningDraft),
      };
      const updated = await save({ expectedRevision: config.revision, runtimeConfig });
      const updatedOptions = runtimeOptions;
      setConfig(updated);
      setModelDraft(updated.runtimeConfig.model ?? "");
      setModelSelection(modelSelectionFor(updated.runtimeConfig.model, updatedOptions.modelSuggestions));
      setReasoningSelection(updated.runtimeConfig.reasoningEffort ?? PROVIDER_DEFAULT_OPTION);
      setMessage({ kind: "success", section: "runtime", text: m.agent_settings_model_saved() });
    } catch (cause) {
      setMessage({ kind: "error", section: "runtime", text: modelSaveFailureMessage(cause) });
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
      setMessage({ kind: "success", section: "instructions", text: m.agent_settings_soul_updated() });
    } catch {
      setMessage({ kind: "error", section: "instructions", text: m.agent_settings_soul_apply_failed() });
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
      <UnsavedChangesGuard when={runtimeDirty || instructionsDirty} />
      {section !== "instructions" ? (
        <section aria-labelledby="execution-heading" className={section === "execution" ? "grid gap-6" : "grid gap-4"}>
          {section === "execution" ? (
            <AgentSettingsPageHeader id="execution-heading" title={m.agent_settings_model()} />
          ) : (
            <Text as="h3" id="execution-heading" variant="heading">
              {m.agent_settings_model()}
            </Text>
          )}
          <form className="grid gap-4" onSubmit={saveRuntime}>
            <SettingsList>
              <SettingsRow description={m.agent_settings_runtime_fixed()} label={m.agent_settings_runtime()}>
                <div className="flex justify-start @min-[44rem]/content:justify-end">
                  <span className="text-sm text-kumo-default">{providerName}</span>
                </div>
              </SettingsRow>
              <RuntimeModelField
                state={modelField}
                cloudModelState={cloudModelState}
                modelDraft={modelDraft}
                id={fieldId("model")}
                onSelectionChange={(selection) => {
                  setModelSelection(selection);
                  if (selection === CUSTOM_MODEL_OPTION) {
                    if (modelSelection !== CUSTOM_MODEL_OPTION) setModelDraft("");
                  } else {
                    setModelDraft(selection === PROVIDER_DEFAULT_OPTION ? "" : selection);
                  }
                  setMessage(undefined);
                }}
                onModelChange={(value) => {
                  setModelDraft(value);
                  setMessage(undefined);
                }}
              />
              <SettingsRow
                description={m.agent_settings_reasoning_effort_description()}
                label={m.agent_settings_reasoning_effort()}
              >
                <div className="w-full @min-[44rem]/content:ml-auto @min-[44rem]/content:max-w-80">
                  <Select
                    aria-label={m.agent_settings_reasoning_effort()}
                    disabled={cloudModelsUnavailable}
                    className="w-full"
                    id={fieldId("reasoning-effort")}
                    itemToStringLabel={(value) => reasoningOptionLabel(String(value), cloud)}
                    name="reasoningEffort"
                    value={reasoningSelection}
                    onValueChange={(nextValue) => {
                      setReasoningSelection(String(nextValue));
                      setMessage(undefined);
                    }}
                  >
                    <Select.Option value={PROVIDER_DEFAULT_OPTION}>{defaultLabel}</Select.Option>
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
            {!cloud ? (
              <LocalRuntimeOptionsFeedback
                query={localOptions}
                computerOnline={computerOnline}
                discovered={discovered}
                reasoningInvalid={reasoningInvalid}
              />
            ) : null}
            {runtimeDirty ? (
              <SettingsSaveActions
                busy={Boolean(saving)}
                saveDisabled={modelInvalid || reasoningInvalid}
                onDiscard={discardRuntimeChanges}
              />
            ) : null}
          </form>
          {message?.section === "runtime" ? <SaveMessage message={message} /> : null}
          {/* The platform owns Cloud execution, so only a Local Computer gets a connection test. */}
          {cloud ? null : (
            <section aria-labelledby="runtime-test-heading" className="mt-2 grid gap-3">
              <Text as={TroubleshootingHeading} id="runtime-test-heading" variant="heading">
                {m.agent_settings_troubleshooting()}
              </Text>
              <SettingsList>
                <RuntimeTestAction
                  agentId={config.id}
                  disabledReason={runtimeTestDisabledReason({ runtimeDirty, computerOnline })}
                  expectedRevision={config.revision}
                  expectedRuntimeConfigRevision={config.runtimeConfig.revision}
                  providerName={providerName}
                />
              </SettingsList>
            </section>
          )}
        </section>
      ) : null}

      {section !== "execution" ? (
        <section
          aria-labelledby="agent-instructions-heading"
          className={section === "instructions" ? "grid gap-6" : "grid gap-4"}
        >
          {section === "instructions" ? (
            <AgentSettingsPageHeader
              description={m.agent_settings_instructions_description({ agentName: config.displayName })}
              id="agent-instructions-heading"
              title={m.agent_settings_instructions_title()}
            />
          ) : (
            <header className="grid gap-2">
              <Text as="h3" id="agent-instructions-heading" variant="heading">
                {m.agent_settings_instructions_title()}
              </Text>
              <p className="text-sm text-kumo-subtle">
                {m.agent_settings_instructions_description({ agentName: config.displayName })}
              </p>
            </header>
          )}
          <form className="grid gap-4" onSubmit={saveInstructions}>
            <SoulEditor
              disabled={Boolean(saving)}
              id={fieldId("instructions")}
              value={instructionsDraft}
              onValueChange={(value) => {
                setInstructionsDraft(value);
                setMessage(undefined);
              }}
            />
            {instructionsDirty ? (
              <div className="grid gap-3">
                <SettingsSaveActions
                  busy={Boolean(saving)}
                  saveLabel={m.agent_settings_soul_apply_action()}
                  savingLabel={m.agent_settings_soul_applying_action()}
                  statusLabel={m.agent_settings_soul_unapplied_changes()}
                  onDiscard={() => {
                    setInstructionsDraft(config.runtimeConfig.instructions);
                    setMessage(undefined);
                  }}
                />
                <p className="text-xs leading-relaxed text-kumo-subtle">{m.agent_settings_soul_next_turn_notice()}</p>
              </div>
            ) : null}
          </form>
          {message?.section === "instructions" ? <SaveMessage message={message} /> : null}
        </section>
      ) : null}
    </div>
  );
}

function useLocalRuntimeOptions(config: AgentAdminConfig, model: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.agents.runtimeOptions(config.id, config.computerId, config.runtimeProvider, model.trim()),
    queryFn: ({ signal }) => browserApi.agentRuntimeOptions(config.id, model.trim() || undefined, signal),
    enabled: enabled && Boolean(config.computerId),
    retry: false,
    staleTime: 60_000,
  });
}

function localDiscoveredOptions(query: ReturnType<typeof useLocalRuntimeOptions>, cloud: boolean, online: boolean) {
  if (cloud || !online || !isConfirmedQuerySuccess(query)) return undefined;
  return query.data;
}

function formRuntimeOptions(
  provider: AgentAdminConfig["runtimeProvider"],
  discovered?: AgentRuntimeOptions,
): RuntimeConfigurationOptions {
  const fallback = getRuntimeConfigurationOptions(provider);
  return {
    modelSuggestions: discovered?.modelSuggestions ?? fallback.modelSuggestions,
    reasoningEffortAllowedValues: discovered?.reasoningEffortAllowedValues ?? fallback.reasoningEffortAllowedValues,
  };
}

function visibleModelSelection(selection: string, model: string, choices: readonly string[]) {
  if (selection !== CUSTOM_MODEL_OPTION && model && !choices.includes(model)) return CUSTOM_MODEL_OPTION;
  return selection;
}

function modelFieldInvalid(modelInvalid: boolean, reasoningInvalid: boolean) {
  return modelInvalid || reasoningInvalid;
}

function invalidNewReasoning(
  discovered: AgentRuntimeOptions | undefined,
  historical: boolean,
  dirty: boolean,
  cloud: boolean,
) {
  if (cloud || !discovered || discovered.reasoningEffortAllowedValues === null) return false;
  return historical && dirty;
}

function LocalRuntimeOptionsFeedback({
  query,
  computerOnline,
  discovered,
  reasoningInvalid,
}: {
  query: ReturnType<typeof useLocalRuntimeOptions>;
  computerOnline: boolean;
  discovered?: AgentRuntimeOptions;
  reasoningInvalid: boolean;
}) {
  const denied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
  let feedback = null;
  if (!computerOnline || query.isError)
    feedback = (
      <p role={denied ? "alert" : "status"} className="text-sm text-kumo-subtle">
        {denied ? m.agent_settings_runtime_options_denied() : m.agent_settings_runtime_options_unavailable()}
      </p>
    );
  else if (query.isFetching) feedback = <p role="status">{m.agent_settings_runtime_options_loading()}</p>;
  return (
    <div className="grid gap-2">
      <p className="text-sm text-kumo-subtle">{m.agent_settings_inherit_local_description()}</p>
      {feedback}
      {!discovered || discovered.reasoningEffortAllowedValues === null ? (
        <p className="text-sm text-kumo-subtle">{m.agent_settings_reasoning_unknown()}</p>
      ) : null}
      {reasoningInvalid ? (
        <p role="alert" className="text-sm text-kumo-danger">
          {m.agent_settings_reasoning_unsupported()}
        </p>
      ) : null}
      <Button
        type="button"
        size="compact"
        variant="secondary"
        disabled={!computerOnline || query.isFetching}
        onClick={() => void query.refetch()}
      >
        {m.agent_settings_runtime_options_refresh()}
      </Button>
    </div>
  );
}

function modelSelectionFor(model: string | null, suggestions: readonly string[]): string {
  if (model === null) return PROVIDER_DEFAULT_OPTION;
  return suggestions.includes(model) ? model : CUSTOM_MODEL_OPTION;
}

function reasoningOptionLabel(value: string, cloud = false): string {
  if (value === PROVIDER_DEFAULT_OPTION)
    return cloud ? m.agent_settings_provider_default() : m.agent_settings_inherit_local();
  return (
    {
      off: m.agent_settings_reasoning_off(),
      minimal: m.agent_settings_reasoning_minimal(),
      low: m.agent_settings_reasoning_low(),
      medium: m.agent_settings_reasoning_medium(),
      high: m.agent_settings_reasoning_high(),
      xhigh: m.agent_settings_reasoning_extra_high(),
      max: m.agent_settings_reasoning_max(),
      ultra: m.agent_settings_reasoning_ultra(),
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

function modelSaveFailureMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === "CLOUD_MODEL_NOT_ALLOWED") return m.agent_settings_cloud_model_not_allowed();
    if (cause.code === "CLOUD_MODEL_UNAVAILABLE") return m.agent_settings_cloud_models_unavailable();
  }
  return m.agent_settings_execution_save_failed();
}

function runtimeTestDisabledReason(input: { runtimeDirty: boolean; computerOnline: boolean }): string | undefined {
  if (input.runtimeDirty) return m.agent_settings_runtime_test_disabled_unsaved();
  if (!input.computerOnline) return m.agent_settings_runtime_test_disabled_computer();
  return undefined;
}
