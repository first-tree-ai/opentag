import type { AgentAdminConfig, UpdateAgentRequest, UpdateAgentRuntimeConfig } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { Button, Field } from "./ui/design-system.js";

const CODEX_REASONING_EFFORT_SUGGESTIONS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const CLAUDE_CODE_REASONING_EFFORT_SUGGESTIONS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;

export interface RuntimeConfigurationFormProps {
  readonly initialConfig: AgentAdminConfig;
  readonly save: (input: UpdateAgentRequest) => Promise<AgentAdminConfig>;
}

export function RuntimeConfigurationForm({ initialConfig, save }: RuntimeConfigurationFormProps) {
  return <RuntimeConfigurationEditor initialConfig={initialConfig} save={save} />;
}

function RuntimeConfigurationEditor({ initialConfig, save }: RuntimeConfigurationFormProps) {
  const [config, setConfig] = useState(initialConfig);
  const [editingRuntime, setEditingRuntime] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    section: "runtime" | "instructions";
    text: string;
  }>();
  const [saving, setSaving] = useState<"runtime" | "instructions">();
  const fieldId = (name: string) => `runtime-${name}-${config.id}`;
  const reasoningListId = `reasoning-effort-${config.id}`;
  const providerName = config.runtimeProvider === "codex" ? "Codex" : "Claude Code";
  const reasoningSuggestions =
    config.runtimeProvider === "codex" ? CODEX_REASONING_EFFORT_SUGGESTIONS : CLAUDE_CODE_REASONING_EFFORT_SUGGESTIONS;

  async function saveRuntime(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving("runtime");
    setMessage(undefined);
    try {
      const runtimeConfig = runtimeConfigurationFromForm(new FormData(event.currentTarget));
      const updated = await save({ expectedRevision: config.revision, runtimeConfig });
      setConfig(updated);
      setEditingRuntime(false);
      setMessage({ kind: "success", section: "runtime", text: "Runtime settings saved." });
    } catch (cause) {
      setMessage({
        kind: "error",
        section: "runtime",
        text: cause instanceof Error ? cause.message : "Unable to save Runtime settings",
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
      const instructions = String(new FormData(event.currentTarget).get("instructions") ?? "");
      const updated = await save({
        expectedRevision: config.revision,
        runtimeConfig: { instructions },
      });
      setConfig(updated);
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
    <div className="agent-runtime-settings">
      <section aria-labelledby="runtime-heading" className="agent-runtime-section">
        <header className="agent-runtime-section__header">
          <div>
            <h3 id="runtime-heading">Runtime</h3>
            <p>Choose how this Agent runs.</p>
          </div>
          {!editingRuntime ? (
            <Button size="compact" variant="inline" onClick={() => setEditingRuntime(true)}>
              Edit settings
            </Button>
          ) : null}
        </header>
        {editingRuntime ? (
          <form className="agent-runtime-edit-form" key={config.revision} onSubmit={saveRuntime}>
            <div className="agent-runtime-field-grid">
              <Field
                hint="Leave blank to use the provider default."
                hintId={fieldId("model-help")}
                htmlFor={fieldId("model")}
                label="Model"
              >
                <input
                  aria-describedby={fieldId("model-help")}
                  autoComplete="off"
                  defaultValue={config.runtimeConfig.model ?? ""}
                  id={fieldId("model")}
                  name="model"
                  placeholder="Provider default"
                />
              </Field>
              <Field
                hint="Leave blank to use the provider default."
                hintId={fieldId("reasoning-help")}
                htmlFor={fieldId("reasoning-effort")}
                label="Reasoning level"
              >
                <input
                  aria-describedby={fieldId("reasoning-help")}
                  autoComplete="off"
                  defaultValue={config.runtimeConfig.reasoningEffort ?? ""}
                  id={fieldId("reasoning-effort")}
                  list={reasoningListId}
                  name="reasoningEffort"
                  placeholder="Provider default"
                />
                <datalist id={reasoningListId}>
                  {reasoningSuggestions.map((effort) => (
                    <option value={effort} key={effort} />
                  ))}
                </datalist>
              </Field>
            </div>
            <div className="agent-runtime-actions">
              <Button disabled={Boolean(saving)} type="submit">
                {saving === "runtime" ? "Saving…" : "Save settings"}
              </Button>
              <Button disabled={Boolean(saving)} variant="ghost" onClick={() => setEditingRuntime(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <RuntimeFacts
            rows={[
              ["Provider", providerName],
              ["Model", config.runtimeConfig.model ?? "Provider default"],
              ["Reasoning level", config.runtimeConfig.reasoningEffort ?? "Provider default"],
            ]}
          />
        )}
        {message?.section === "runtime" ? <SaveMessage message={message} /> : null}
      </section>

      <section aria-labelledby="agent-instructions-heading" className="agent-runtime-section">
        <header className="agent-runtime-section__header">
          <div>
            <h3 id="agent-instructions-heading">Agent instructions</h3>
            <p>Set the guidance applied to every Turn this Agent runs.</p>
          </div>
        </header>
        <form className="agent-instructions-form" key={config.runtimeConfig.revision} onSubmit={saveInstructions}>
          <Field
            hint="Be concise and specific. These instructions apply in addition to OpenTag's platform guidance."
            hintId={fieldId("instructions-help")}
            htmlFor={fieldId("instructions")}
            label="Instructions"
          >
            <textarea
              aria-describedby={fieldId("instructions-help")}
              defaultValue={config.runtimeConfig.instructions}
              id={fieldId("instructions")}
              name="instructions"
              rows={8}
            />
          </Field>
          <Button disabled={Boolean(saving)} type="submit">
            {saving === "instructions" ? "Saving…" : "Save instructions"}
          </Button>
        </form>
        {message?.section === "instructions" ? <SaveMessage message={message} /> : null}
      </section>
    </div>
  );
}

function RuntimeFacts({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="agent-runtime-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SaveMessage({ message }: { message: { kind: "error" | "success"; text: string } }) {
  return (
    <p
      className={message.kind === "error" ? "error" : "agent-runtime-save-message"}
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
