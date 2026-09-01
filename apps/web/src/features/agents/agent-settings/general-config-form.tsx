import type { AgentAdminConfig } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { Button, Field, KumoInputControl, Text } from "../../../ui/design-system.js";

export function GeneralConfigForm({
  initialConfig,
  onAgentChanged,
}: {
  initialConfig: AgentAdminConfig;
  onAgentChanged: () => void;
}) {
  const [config, setConfig] = useState(initialConfig);
  const [displayName, setDisplayName] = useState(initialConfig.displayName);
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const dirty = displayName !== config.displayName;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const updated = await browserApi.updateAgent(config.id, { expectedRevision: config.revision, displayName });
      setConfig(updated);
      setDisplayName(updated.displayName);
      setMessage(m.agent_settings_name_saved());
      onAgentChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : m.agent_settings_save_name_failed());
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line" onSubmit={submit}>
      <header className="grid gap-2">
        <Text as="h1" size="lg" variant="heading">
          {m.agent_settings_name_title()}
        </Text>
      </header>
      <Field htmlFor="agent-display-name" label={m.agent_settings_display_name_label()}>
        <KumoInputControl
          id="agent-display-name"
          name="displayName"
          required
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.currentTarget.value);
            setMessage(undefined);
          }}
        />
      </Field>
      {dirty ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
          <span className="text-sm text-kumo-subtle">{m.agent_settings_unsaved_changes()}</span>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={saving}
              variant="ghost"
              onClick={() => {
                setDisplayName(config.displayName);
                setMessage(undefined);
              }}
            >
              {m.agent_settings_discard_action()}
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? m.agent_settings_saving_action() : m.agent_settings_save_changes_action()}
            </Button>
          </div>
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
