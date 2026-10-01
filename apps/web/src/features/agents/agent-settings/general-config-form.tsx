import type { AgentAdminConfig } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { KumoInputControl, SettingsList, SettingsRow, Switch } from "../../../ui/design-system.js";
import { AgentSettingsPageHeader, SettingsSaveActions, UnsavedChangesGuard } from "./settings-layout.js";

export function GeneralConfigForm({
  initialConfig,
  onAgentChanged,
}: {
  initialConfig: AgentAdminConfig;
  onAgentChanged: () => void;
}) {
  const [config, setConfig] = useState(initialConfig);
  const [displayName, setDisplayName] = useState(initialConfig.displayName);
  const [selfConfigurationEnabled, setSelfConfigurationEnabled] = useState(initialConfig.selfConfigurationEnabled);
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [selfConfigurationSaving, setSelfConfigurationSaving] = useState(false);
  const dirty = displayName !== config.displayName;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving || selfConfigurationSaving) return;
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
  async function changeSelfConfiguration(next: boolean) {
    if (saving || selfConfigurationSaving) return;
    setSelfConfigurationSaving(true);
    setMessage(undefined);
    try {
      const updated = await browserApi.updateAgent(config.id, {
        expectedRevision: config.revision,
        selfConfigurationEnabled: next,
      });
      setConfig(updated);
      setSelfConfigurationEnabled(updated.selfConfigurationEnabled);
      setMessage(m.agent_settings_self_configuration_saved());
      onAgentChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : m.agent_settings_save_self_configuration_failed());
    } finally {
      setSelfConfigurationSaving(false);
    }
  }
  return (
    <div className="grid gap-6">
      <AgentSettingsPageHeader title={m.agent_settings_name_title()} />
      <UnsavedChangesGuard when={dirty} />
      <form className="grid gap-4" onSubmit={submit}>
        <SettingsList>
          <SettingsRow label={m.agent_settings_display_name_label()}>
            <div className="w-full [&>input]:w-full @min-[44rem]/content:ml-auto @min-[44rem]/content:max-w-80">
              <KumoInputControl
                aria-label={m.agent_settings_display_name_label()}
                id="agent-display-name"
                name="displayName"
                required
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.currentTarget.value);
                  setMessage(undefined);
                }}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            description={m.agent_settings_self_configuration_description()}
            label={m.agent_settings_self_configuration()}
          >
            <Switch
              aria-label={m.agent_settings_self_configuration()}
              checked={selfConfigurationEnabled}
              disabled={saving || selfConfigurationSaving}
              onCheckedChange={(next) => void changeSelfConfiguration(next === true)}
              transitioning={selfConfigurationSaving}
            />
          </SettingsRow>
        </SettingsList>
        {dirty ? (
          <SettingsSaveActions
            busy={saving || selfConfigurationSaving}
            onDiscard={() => {
              setDisplayName(config.displayName);
              setMessage(undefined);
            }}
          />
        ) : null}
        {message ? <p role="status">{message}</p> : null}
      </form>
    </div>
  );
}
