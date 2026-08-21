import {
  type AgentAdminConfig,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  RUNTIME_MAX_DURATION_MS,
  type UpdateAgentRequest,
  type UpdateAgentRuntimeConfig,
} from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";

const CODEX_REASONING_EFFORT_SUGGESTIONS = ["minimal", "low", "medium", "high", "xhigh"] as const;

const DEFAULT_DURATION_SECONDS = RUNTIME_DEFAULT_MAX_DURATION_MS / 1_000;
const MAX_DURATION_SECONDS = RUNTIME_MAX_DURATION_MS / 1_000;

export interface RuntimeConfigurationFormProps {
  readonly initialConfig: AgentAdminConfig;
  readonly save: (input: UpdateAgentRequest) => Promise<AgentAdminConfig>;
}

export function RuntimeConfigurationForm({ initialConfig, save }: RuntimeConfigurationFormProps) {
  if (initialConfig.runtimeProvider !== "codex") {
    return (
      <section className="form-card">
        <h2>Execution choices</h2>
        <p className="muted">
          Runtime Configuration is not available for Claude Code Agents. Effective Runtime Snapshots currently support
          Codex only.
        </p>
      </section>
    );
  }
  return <CodexRuntimeConfigurationForm initialConfig={initialConfig} save={save} />;
}

function CodexRuntimeConfigurationForm({ initialConfig, save }: RuntimeConfigurationFormProps) {
  const [config, setConfig] = useState(initialConfig);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string }>();
  const [saving, setSaving] = useState(false);
  const fieldId = (name: string) => `runtime-${name}-${config.id}`;
  const reasoningListId = `reasoning-effort-${config.id}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const runtimeConfig = runtimeConfigurationFromForm(new FormData(event.currentTarget));
      const updated = await save({ expectedRevision: config.revision, runtimeConfig });
      setConfig(updated);
      setMessage({ kind: "success", text: "Runtime configuration saved." });
    } catch (cause) {
      setMessage({
        kind: "error",
        text: cause instanceof Error ? cause.message : "Unable to save Runtime configuration",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="form-card" key={config.revision} onSubmit={submit}>
      <h2>Execution choices</h2>
      <div className="form-field">
        <label htmlFor={fieldId("model")}>Model</label>
        <input
          aria-describedby={fieldId("model-help")}
          autoComplete="off"
          defaultValue={config.runtimeConfig.model ?? ""}
          id={fieldId("model")}
          name="model"
          placeholder="Managed by provider"
        />
        <small className="field-help" id={fieldId("model-help")}>
          Enter an exact Codex model ID. Leave blank to let Codex manage the selection.
        </small>
      </div>
      <div className="form-field">
        <label htmlFor={fieldId("reasoning-effort")}>Reasoning effort</label>
        <input
          aria-describedby={fieldId("reasoning-help")}
          autoComplete="off"
          defaultValue={config.runtimeConfig.reasoningEffort ?? ""}
          id={fieldId("reasoning-effort")}
          list={reasoningListId}
          name="reasoningEffort"
          placeholder="Managed by provider"
        />
        <datalist id={reasoningListId}>
          {CODEX_REASONING_EFFORT_SUGGESTIONS.map((effort) => (
            <option value={effort} key={effort} />
          ))}
        </datalist>
        <small className="field-help" id={fieldId("reasoning-help")}>
          These are common Codex values, not a compatibility guarantee. The bound Computer performs the authoritative
          runtime check.
        </small>
      </div>
      <div className="form-field">
        <label htmlFor={fieldId("max-duration")}>Maximum Turn duration</label>
        <input
          aria-describedby={fieldId("duration-help")}
          defaultValue={millisecondsToSeconds(config.runtimeConfig.maxDurationMs)}
          id={fieldId("max-duration")}
          max={MAX_DURATION_SECONDS}
          min="0.001"
          name="maxDurationSeconds"
          placeholder={String(DEFAULT_DURATION_SECONDS)}
          step="0.001"
          type="number"
        />
        <small className="field-help" id={fieldId("duration-help")}>
          Seconds. Leave blank to use OpenTag's {formatMinutes(RUNTIME_DEFAULT_MAX_DURATION_MS)} default. A timeout
          stops the Turn, but external effects may already have occurred.
        </small>
      </div>
      <div className="form-field">
        <label htmlFor={fieldId("instructions")}>Instructions</label>
        <textarea
          defaultValue={config.runtimeConfig.instructions}
          id={fieldId("instructions")}
          name="instructions"
          rows={10}
        />
      </div>
      <button className="button" disabled={saving} type="submit">
        {saving ? "Saving…" : "Save Runtime settings"}
      </button>
      {message ? (
        <p
          className={message.kind === "error" ? "error" : undefined}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}
    </form>
  );
}

export function runtimeConfigurationFromForm(data: FormData): UpdateAgentRuntimeConfig {
  return {
    model: nullableText(data.get("model")),
    reasoningEffort: nullableText(data.get("reasoningEffort")),
    instructions: String(data.get("instructions") ?? ""),
    maxDurationMs: durationMilliseconds(data.get("maxDurationSeconds")),
  };
}

function durationMilliseconds(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const milliseconds = Number(text) * 1_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > RUNTIME_MAX_DURATION_MS) {
    throw new Error("Maximum Turn duration must be between 0.001 and 86400 seconds, in millisecond increments.");
  }
  return milliseconds;
}

function millisecondsToSeconds(value: number | null): string {
  return value === null ? "" : String(value / 1_000);
}

function nullableText(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function formatMinutes(milliseconds: number): string {
  return `${milliseconds / 60_000}-minute`;
}
