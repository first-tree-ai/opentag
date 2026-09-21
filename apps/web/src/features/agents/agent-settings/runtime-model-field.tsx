import type { CloudModelOptions, RuntimeConfigurationOptions } from "@opentag/shared/browser";
import * as m from "../../../paraglide/messages.js";
import { Button, KumoInputControl, Select, SettingsRow } from "../../../ui/design-system.js";

export type CloudModelState =
  | { kind: "loading" }
  | { kind: "unavailable"; retry(): void }
  | { kind: "ready"; value: CloudModelOptions };

const DEFAULT = "__provider_default__";
const CUSTOM = "__custom_model__";

export function runtimeModelField({
  cloud,
  cloudOptions,
  modelDraft,
  modelSelection,
  runtimeOptions,
}: {
  cloud: boolean;
  cloudOptions: CloudModelOptions | undefined;
  modelDraft: string;
  modelSelection: string;
  runtimeOptions: RuntimeConfigurationOptions;
}) {
  const choices = cloud ? (cloudOptions?.models ?? []) : runtimeOptions.modelSuggestions;
  const unavailable = cloud && !cloudOptions;
  const unsupported = cloud && Boolean(modelDraft) && !choices.includes(modelDraft);
  const invalid = cloud ? unavailable || unsupported : modelSelection === CUSTOM && !modelDraft.trim();
  let defaultLabel = m.agent_settings_provider_default();
  if (cloud) {
    defaultLabel = cloudOptions?.defaultModel
      ? m.agent_settings_cloud_model_default({ model: cloudOptions.defaultModel })
      : m.agent_settings_cloud_model_default_unknown();
  }
  return {
    cloud,
    choices,
    unavailable,
    unsupported,
    invalid,
    defaultLabel,
    selection: cloud ? modelDraft || DEFAULT : modelSelection,
  };
}

export function RuntimeModelField({
  state,
  cloudModelState,
  modelDraft,
  id,
  onSelectionChange,
  onModelChange,
}: {
  state: ReturnType<typeof runtimeModelField>;
  cloudModelState: CloudModelState | undefined;
  modelDraft: string;
  id: string;
  onSelectionChange(value: string): void;
  onModelChange(value: string): void;
}) {
  const label = (value: string) => {
    if (value === DEFAULT) return state.defaultLabel;
    return value === CUSTOM ? m.agent_settings_model_custom() : value;
  };
  return (
    <SettingsRow label={m.agent_settings_model()}>
      <div className="grid w-full gap-2 @min-[44rem]/content:ml-auto @min-[44rem]/content:max-w-80">
        <Select
          aria-label={m.agent_settings_model()}
          className="w-full"
          id={id}
          disabled={state.unavailable}
          itemToStringLabel={(value) => label(String(value))}
          value={state.selection}
          onValueChange={(value) => onSelectionChange(String(value))}
        >
          <Select.Option value={DEFAULT}>{state.defaultLabel}</Select.Option>
          {state.unsupported ? (
            <Select.Option value={modelDraft} disabled>
              {modelDraft}
            </Select.Option>
          ) : null}
          {state.choices.map((model) => (
            <Select.Option value={model} key={model}>
              {model}
            </Select.Option>
          ))}
          {!state.cloud ? <Select.Option value={CUSTOM}>{m.agent_settings_model_custom()}</Select.Option> : null}
        </Select>
        <CloudModelFeedback state={cloudModelState} unsupported={state.unsupported} />
        {!state.cloud && state.selection === CUSTOM ? (
          <KumoInputControl
            aria-label={m.agent_settings_model_custom_label()}
            autoComplete="off"
            id={`${id}-custom`}
            required
            value={modelDraft}
            onChange={(event) => onModelChange(event.currentTarget.value)}
          />
        ) : null}
      </div>
    </SettingsRow>
  );
}

function CloudModelFeedback({ state, unsupported }: { state: CloudModelState | undefined; unsupported: boolean }) {
  if (state?.kind === "loading") {
    return (
      <p role="status" className="text-sm text-kumo-subtle">
        {m.agent_settings_cloud_models_loading()}
      </p>
    );
  }
  if (state?.kind === "unavailable") {
    return (
      <div className="grid gap-2">
        <p role="alert" className="text-sm text-kumo-danger">
          {m.agent_settings_cloud_models_unavailable()}
        </p>
        <Button type="button" size="compact" variant="secondary" onClick={state.retry}>
          {m.agent_settings_cloud_models_retry()}
        </Button>
      </div>
    );
  }
  if (unsupported)
    return (
      <p role="alert" className="text-sm text-kumo-danger">
        {m.agent_settings_cloud_model_not_allowed()}
      </p>
    );
  return null;
}
