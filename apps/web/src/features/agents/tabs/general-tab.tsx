import type { AgentAdminConfig, AgentDetail } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { browserApi } from "../../../api.js";
import { formatDate } from "../../../lib/format.js";
import { useResource } from "../../../lib/resource.js";
import { AsyncState } from "../../../ui/async-state.js";
import { DefinitionList } from "../../../ui/data-display.js";
import { Status } from "../../../ui/feedback.js";
import { FormCard } from "../../../ui/form-card.js";

export function GeneralTab({ agent }: { agent: AgentDetail }) {
  return (
    <>
      <DefinitionList
        rows={[
          ["Display name", agent.displayName],
          ["Manager", agent.manager.displayName],
          ["Computer", agent.computer.displayName],
          ["Created", formatDate(agent.createdAt)],
        ]}
      />
      {agent.viewerCapabilities.canManage ? <GeneralAdminForm agent={agent} /> : null}
    </>
  );
}

function GeneralAdminForm({ agent }: { agent: AgentDetail }) {
  const configState = useResource(() => browserApi.agents.config(agent.id), agent.id);
  return <AsyncState state={configState}>{(config) => <GeneralConfigForm initialConfig={config} />}</AsyncState>;
}

function GeneralConfigForm({ initialConfig }: { initialConfig: AgentAdminConfig }) {
  const [config, setConfig] = useState(initialConfig);
  const [message, setMessage] = useState<string>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = String(new FormData(event.currentTarget).get("displayName") ?? "");
    try {
      setConfig(await browserApi.agents.update(config.id, { expectedRevision: config.revision, displayName }));
      setMessage("General settings saved.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save General settings");
    }
  }
  return (
    <FormCard onSubmit={submit}>
      <h2>Admin configuration</h2>
      <label>
        Display name
        <input defaultValue={config.displayName} key={config.revision} name="displayName" required />
      </label>
      <button className="button" type="submit">
        Save General settings
      </button>
      {message ? <Status>{message}</Status> : null}
    </FormCard>
  );
}
