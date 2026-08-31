import type { AgentAdminConfig } from "@opentag/shared/browser";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import { formatNumber } from "../../../i18n/format.js";
import * as m from "../../../paraglide/messages.js";
import {
  Button,
  Dialog,
  Field,
  KumoInputAreaControl,
  SettingsList,
  SettingsRow,
  Text,
} from "../../../ui/design-system.js";
import type { AgentDetailView } from "../agent-model.js";

export function AgentResourcesSettings({
  agent,
  config: initialConfig,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  config: AgentAdminConfig;
  onAgentChanged: () => void;
}) {
  const [config, setConfig] = useState(initialConfig);
  const [editing, setEditing] = useState(false);
  const [instructionsDraft, setInstructionsDraft] = useState(initialConfig.runtimeConfig.instructions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const editingRef = useRef(false);
  const pendingConfigRef = useRef<AgentAdminConfig | undefined>(undefined);
  const dirty = instructionsDraft !== config.runtimeConfig.instructions;
  const instructionsId = `resources-instructions-${config.id}`;

  useEffect(() => {
    if (editingRef.current) {
      pendingConfigRef.current = newerConfig(pendingConfigRef.current, initialConfig);
      return;
    }
    setConfig((current) => newerConfig(current, initialConfig));
  }, [initialConfig]);

  function openEditor() {
    editingRef.current = true;
    pendingConfigRef.current = undefined;
    setInstructionsDraft(config.runtimeConfig.instructions);
    setError(undefined);
    setMessage(undefined);
    setEditing(true);
  }

  function closeEditor() {
    editingRef.current = false;
    const pendingConfig = pendingConfigRef.current;
    pendingConfigRef.current = undefined;
    if (pendingConfig) setConfig((current) => newerConfig(current, pendingConfig));
    setEditing(false);
    setError(undefined);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await browserApi.updateAgent(config.id, {
        expectedRevision: config.revision,
        runtimeConfig: { instructions: instructionsDraft },
      });
      const pendingConfig = pendingConfigRef.current;
      const resolvedConfig = pendingConfig ? newerConfig(updated, pendingConfig) : updated;
      setConfig(resolvedConfig);
      setInstructionsDraft(resolvedConfig.runtimeConfig.instructions);
      setMessage(m.agent_settings_instructions_saved());
      editingRef.current = false;
      pendingConfigRef.current = undefined;
      setEditing(false);
      onAgentChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.agent_settings_save_instructions_failed());
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby={`resources-settings-heading-${config.id}`}
      className="grid gap-4"
      data-agent-id={agent.id}
    >
      <Text as="h2" id={`resources-settings-heading-${config.id}`} variant="heading">
        {m.agent_settings_resources_title()}
      </Text>
      <SettingsList>
        <SettingsRow
          description={instructionsSummary(config.runtimeConfig.instructions)}
          label={m.agent_settings_instructions_label()}
        >
          <Button ref={editButtonRef} size="compact" variant="secondary" onClick={openEditor}>
            {m.agent_settings_edit_action()}
          </Button>
        </SettingsRow>
      </SettingsList>
      {message ? <p role="status">{message}</p> : null}
      {editing ? (
        <Dialog
          busy={saving}
          description={m.agent_settings_instructions_dialog_description()}
          returnFocusRef={editButtonRef}
          title={m.agent_settings_edit_instructions_title()}
          onClose={closeEditor}
        >
          <form className="grid gap-4" onSubmit={save}>
            <Field htmlFor={instructionsId} label={m.agent_settings_instructions_label()}>
              <KumoInputAreaControl
                id={instructionsId}
                name="instructions"
                rows={8}
                value={instructionsDraft}
                onChange={(event) => {
                  setInstructionsDraft(event.currentTarget.value);
                  setError(undefined);
                }}
              />
            </Field>
            {error ? (
              <p className="text-sm text-kumo-danger" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2 border-t border-kumo-line pt-4">
              <Button disabled={saving} variant="ghost" onClick={closeEditor}>
                {m.agent_settings_cancel_action()}
              </Button>
              <Button disabled={!dirty || saving} type="submit">
                {saving ? m.agent_settings_saving_action() : m.agent_settings_save_changes_action()}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}

function instructionsSummary(instructions: string): string {
  if (instructions.length === 0) return m.agent_settings_not_customized_characters({ count: formatNumber(0) });
  const length = Array.from(instructions).length;
  return length === 1
    ? m.agent_settings_custom_character({ count: formatNumber(length) })
    : m.agent_settings_custom_characters({ count: formatNumber(length) });
}

function newerConfig(current: AgentAdminConfig | undefined, candidate: AgentAdminConfig): AgentAdminConfig {
  if (!current || current.id !== candidate.id || candidate.revision >= current.revision) return candidate;
  return current;
}
