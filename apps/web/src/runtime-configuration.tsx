import {
  type AgentAdminConfig,
  getRuntimeConfigurationOptions,
  type UpdateAgentRequest,
  type UpdateAgentRuntimeConfig,
} from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { Button, Field, KumoInputAreaControl, KumoInputControl, KumoSelectControl } from "./ui/design-system.js";

const CUSTOM_MODEL_OPTION = "__custom_model__";

export interface RuntimeConfigurationFormProps {
  readonly initialConfig: AgentAdminConfig;
  readonly save: (input: UpdateAgentRequest) => Promise<AgentAdminConfig>;
  readonly section?: "all" | "execution" | "instructions";
}

export function RuntimeConfigurationForm({ initialConfig, save, section = "all" }: RuntimeConfigurationFormProps) {
  return <RuntimeConfigurationEditor initialConfig={initialConfig} save={save} section={section} />;
}

function RuntimeConfigurationEditor({ initialConfig, save, section = "all" }: RuntimeConfigurationFormProps) {
  const initialOptions = getRuntimeConfigurationOptions(initialConfig.runtimeProvider);
  const [config, setConfig] = useState(initialConfig);
  const [modelDraft, setModelDraft] = useState(initialConfig.runtimeConfig.model ?? "");
  const [modelSelection, setModelSelection] = useState(() =>
    modelSelectionFor(initialConfig.runtimeConfig.model, initialOptions.modelSuggestions),
  );
  const [reasoningDraft, setReasoningDraft] = useState(initialConfig.runtimeConfig.reasoningEffort ?? "");
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
  const runtimeOptions = getRuntimeConfigurationOptions(config.runtimeProvider);
  const hasHistoricalReasoningDraft =
    reasoningDraft !== "" && !runtimeOptions.reasoningEffortAllowedValues.includes(reasoningDraft);
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
      setConfig(updated);
      setModelDraft(updated.runtimeConfig.model ?? "");
      setModelSelection(
        modelSelectionFor(
          updated.runtimeConfig.model,
          getRuntimeConfigurationOptions(updated.runtimeProvider).modelSuggestions,
        ),
      );
      setReasoningDraft(updated.runtimeConfig.reasoningEffort ?? "");
      setMessage({ kind: "success", section: "runtime", text: "Execution settings saved." });
    } catch (cause) {
      setMessage({
        kind: "error",
        section: "runtime",
        text: cause instanceof Error ? cause.message : "Unable to save Execution settings",
      });
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
      setMessage({ kind: "success", section: "instructions", text: "Agent instructions saved." });
    } catch (cause) {
      setMessage({
        kind: "error",
        section: "instructions",
        text: cause instanceof Error ? cause.message : "Unable to save Agent instructions",
      });
    } finally {
      setSaving(undefined);
    }
  }

  return (
    <div className="grid gap-6" data-ui={section === "all" ? "runtime-settings" : "settings-section"}>
      {section !== "instructions" ? (
        <section
          aria-labelledby="execution-heading"
          className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
        >
          <header className="flex items-start justify-between gap-3">
            <div>
              <ExecutionHeading id="execution-heading">
                {section === "execution" ? "Model & reasoning" : "Execution"}
              </ExecutionHeading>
            </div>
          </header>
          {section !== "execution" ? <p className="text-sm text-kumo-subtle">Provider: {providerName}</p> : null}
          <form className="grid gap-4" onSubmit={saveRuntime}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field htmlFor={fieldId("model")} label="Model">
                <KumoSelectControl
                  id={fieldId("model")}
                  aria-label="Model"
                  value={modelSelection}
                  onChange={(event) => {
                    const selection = event.currentTarget.value;
                    setModelSelection(selection);
                    if (selection === CUSTOM_MODEL_OPTION) {
                      if (modelSelection !== CUSTOM_MODEL_OPTION) setModelDraft("");
                    } else {
                      setModelDraft(selection);
                    }
                    setMessage(undefined);
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
                {modelSelection === CUSTOM_MODEL_OPTION ? (
                  <div className="mt-2">
                    <KumoInputControl
                      aria-label="Custom model ID"
                      autoComplete="off"
                      id={fieldId("custom-model")}
                      required
                      value={modelDraft}
                      onChange={(event) => {
                        setModelDraft(event.currentTarget.value);
                        setMessage(undefined);
                      }}
                    />
                  </div>
                ) : null}
              </Field>
              <Field htmlFor={fieldId("reasoning-effort")} label="Reasoning level">
                <KumoSelectControl
                  id={fieldId("reasoning-effort")}
                  aria-label="Reasoning level"
                  name="reasoningEffort"
                  value={reasoningDraft}
                  onChange={(event) => {
                    setReasoningDraft(event.currentTarget.value);
                    setMessage(undefined);
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
            </div>
            {runtimeDirty ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
                <span className="text-sm text-kumo-subtle">Unsaved changes</span>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    disabled={Boolean(saving)}
                    variant="ghost"
                    onClick={() => {
                      setModelDraft(config.runtimeConfig.model ?? "");
                      setModelSelection(modelSelectionFor(config.runtimeConfig.model, runtimeOptions.modelSuggestions));
                      setReasoningDraft(config.runtimeConfig.reasoningEffort ?? "");
                      setMessage(undefined);
                    }}
                  >
                    Discard
                  </Button>
                  <Button disabled={Boolean(saving) || customModelInvalid} type="submit">
                    {saving === "runtime" ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </div>
            ) : null}
          </form>
          {message?.section === "runtime" ? <SaveMessage message={message} /> : null}
        </section>
      ) : null}

      {section !== "execution" ? (
        <section
          aria-labelledby="agent-instructions-heading"
          className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
        >
          <header className="flex items-start justify-between gap-3">
            <div>
              <InstructionsHeading id="agent-instructions-heading">
                {section === "instructions" ? "Instructions" : "Agent instructions"}
              </InstructionsHeading>
            </div>
          </header>
          <form className="grid gap-4" onSubmit={saveInstructions}>
            <Field htmlFor={fieldId("instructions")} label="Instructions">
              <KumoInputAreaControl
                id={fieldId("instructions")}
                name="instructions"
                rows={8}
                value={instructionsDraft}
                onChange={(event) => {
                  setInstructionsDraft(event.currentTarget.value);
                  setMessage(undefined);
                }}
              />
            </Field>
            {instructionsDirty ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
                <span className="text-sm text-kumo-subtle">Unsaved changes</span>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    disabled={Boolean(saving)}
                    variant="ghost"
                    onClick={() => {
                      setInstructionsDraft(config.runtimeConfig.instructions);
                      setMessage(undefined);
                    }}
                  >
                    Discard
                  </Button>
                  <Button disabled={Boolean(saving)} type="submit">
                    {saving === "instructions" ? "Saving…" : "Save changes"}
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
  if (model === null) return "";
  return suggestions.includes(model) ? model : CUSTOM_MODEL_OPTION;
}

function SaveMessage({ message }: { message: { kind: "error" | "success"; text: string } }) {
  return (
    <p
      className={message.kind === "error" ? "text-sm text-kumo-danger" : "text-sm text-kumo-success"}
      role={message.kind === "error" ? "alert" : "status"}
    >
      {message.text}
    </p>
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
