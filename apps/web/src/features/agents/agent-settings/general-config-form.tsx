import type { AgentAdminConfig } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { browserApi } from "../../../api.js";
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
      setMessage("Name saved.");
      onAgentChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save name");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      aria-labelledby="agent-name-heading"
      className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      onSubmit={submit}
    >
      <header className="grid gap-2">
        <Text as="h2" id="agent-name-heading" variant="heading">
          Name
        </Text>
      </header>
      <Field htmlFor="agent-display-name" label="Display name">
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
          <span className="text-sm text-kumo-subtle">Unsaved changes</span>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={saving}
              variant="ghost"
              onClick={() => {
                setDisplayName(config.displayName);
                setMessage(undefined);
              }}
            >
              Discard
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
