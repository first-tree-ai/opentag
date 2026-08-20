import type { AgentAdminConfig, AgentDetail, UpdateAgentRuntimeConfig } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { browserApi } from "../../../api.js";
import { useResource } from "../../../lib/resource.js";
import { AsyncState } from "../../../ui/async-state.js";
import { DefinitionList } from "../../../ui/data-display.js";
import { Status } from "../../../ui/feedback.js";
import { FormCard } from "../../../ui/form-card.js";

export function RuntimeTab({ agent }: { agent: AgentDetail }) {
  const state = useResource(
    () => (agent.viewerCapabilities.canManage ? browserApi.agents.config(agent.id) : Promise.resolve(undefined)),
    `${agent.id}:${agent.viewerCapabilities.canManage}`,
  );
  return (
    <AsyncState state={state}>
      {(config) => (
        <>
          <DefinitionList
            rows={[
              ["Provider", agent.runtimeProvider],
              ["Computer", agent.computer.displayName],
            ]}
          />
          {config ? (
            <RuntimeConfigForm initialConfig={config} />
          ) : (
            <p className="muted">Runtime instructions and tuning are visible only to Team Admins.</p>
          )}
        </>
      )}
    </AsyncState>
  );
}

function RuntimeConfigForm({ initialConfig }: { initialConfig: AgentAdminConfig }) {
  const [config, setConfig] = useState(initialConfig);
  const [message, setMessage] = useState<string>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const maxDuration = String(data.get("maxDurationMs") ?? "").trim();
    const runtimeConfig: UpdateAgentRuntimeConfig = {
      model: nullableText(data.get("model")),
      reasoningEffort: nullableText(data.get("reasoningEffort")),
      instructions: String(data.get("instructions") ?? ""),
      maxDurationMs: maxDuration ? Number(maxDuration) : null,
    };
    try {
      const updated = await browserApi.agents.update(config.id, {
        expectedRevision: config.revision,
        runtimeConfig,
      });
      setConfig(updated);
      setMessage("Runtime configuration saved.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save Runtime configuration");
    }
  }
  return (
    <FormCard key={config.revision} onSubmit={submit}>
      <h2>Admin configuration</h2>
      <label>
        Model
        <input defaultValue={config.runtimeConfig.model ?? ""} name="model" placeholder="Provider default" />
      </label>
      <label>
        Reasoning effort
        <input
          defaultValue={config.runtimeConfig.reasoningEffort ?? ""}
          name="reasoningEffort"
          placeholder="Provider default"
        />
      </label>
      <label>
        Instructions
        <textarea defaultValue={config.runtimeConfig.instructions} name="instructions" rows={10} />
      </label>
      <label>
        Maximum duration (ms)
        <input defaultValue={config.runtimeConfig.maxDurationMs ?? ""} min="1" name="maxDurationMs" type="number" />
      </label>
      <p className="muted">Allowed message tools: {config.runtimeConfig.allowedTools.join(", ") || "None"}</p>
      <button className="button" type="submit">
        Save Runtime settings
      </button>
      {message ? <Status>{message}</Status> : null}
    </FormCard>
  );
}

function nullableText(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}
