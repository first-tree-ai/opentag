import type { AgentAdminConfig } from "@opentag/shared/browser";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
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
      setConfig(updated);
      setInstructionsDraft(updated.runtimeConfig.instructions);
      setMessage("Instructions saved.");
      editingRef.current = false;
      pendingConfigRef.current = undefined;
      setEditing(false);
      onAgentChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save instructions");
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
        Resources
      </Text>
      <SettingsList>
        <SettingsRow description={instructionsSummary(config.runtimeConfig.instructions)} label="Instructions">
          <Button ref={editButtonRef} size="compact" variant="secondary" onClick={openEditor}>
            Edit
          </Button>
        </SettingsRow>
        <SettingsRow label="Skills">
          <span className="text-sm text-kumo-subtle">Coming soon</span>
        </SettingsRow>
        <SettingsRow label="Integrations">
          <span className="text-sm text-kumo-subtle">Coming soon</span>
        </SettingsRow>
      </SettingsList>
      <p className="text-sm text-kumo-subtle">
        Coming soon. For now, chat with your agent to set up skills and integrations.
      </p>
      {message ? <p role="status">{message}</p> : null}
      {editing ? (
        <Dialog
          busy={saving}
          description="These instructions guide this Agent in addition to OpenTag's platform guidance."
          returnFocusRef={editButtonRef}
          title="Edit instructions"
          onClose={closeEditor}
        >
          <form className="grid gap-4" onSubmit={save}>
            <Field htmlFor={instructionsId} label="Instructions">
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
                Cancel
              </Button>
              <Button disabled={!dirty || saving} type="submit">
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}

function instructionsSummary(instructions: string): string {
  if (instructions.length === 0) return "Not customized · 0 characters";
  const length = Array.from(instructions).length;
  return `Custom · ${length} ${length === 1 ? "character" : "characters"}`;
}

function newerConfig(current: AgentAdminConfig | undefined, candidate: AgentAdminConfig): AgentAdminConfig {
  if (!current || current.id !== candidate.id || candidate.revision >= current.revision) return candidate;
  return current;
}
