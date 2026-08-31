import type { AgentAdminConfig } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { browserApi } from "../../../api.js";
import { Button, Field, KumoInputControl, Text } from "../../../ui/design-system.js";

export function GeneralConfigForm({
  config,
  onAgentChanged,
}: {
  config: AgentAdminConfig;
  /**
   * Publishes the record the write produced, or asks for a re-read when there is no record because
   * the write was refused. This block renders from the shared reading rather than from a copy of its
   * own, so the field shows the saved name only once the caller has published it -- which is the
   * same condition under which the blocks beside it stop being a revision behind.
   */
  onAgentChanged: (saved?: AgentAdminConfig) => void;
}) {
  /*
   * The field follows the record until someone types in it, and the typing is held apart from the
   * record rather than replacing it. That is what lets another block's write move this block's
   * revision on: nothing here is a private copy of the Agent that a save would send back stale, and
   * an untouched field that catches up with a new name does not read as an edit nobody made.
   */
  const [draft, setDraft] = useState<string>();
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string }>();
  const [saving, setSaving] = useState(false);
  const displayName = draft ?? config.displayName;
  const dirty = draft !== undefined && draft !== config.displayName;
  function discard() {
    setDraft(undefined);
    setMessage(undefined);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const updated = await browserApi.updateAgent(config.id, { expectedRevision: config.revision, displayName });
      setDraft(undefined);
      setMessage({ kind: "success", text: "Name saved." });
      onAgentChanged(updated);
    } catch (cause) {
      // A refused write is a failure, not a status line. This block sits beside four others editing
      // the same Agent, so a revision conflict here is an ordinary outcome rather than a rarity, and
      // it has to interrupt the way the same refusal already does inside the Model dialog.
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Unable to save name" });
      /*
       * A refusal is usually the Agent having moved on somewhere else, and the answer to that is to
       * go and read where it moved to. Without this the same revision is re-sent on every retry and
       * the field is stuck until the page is reloaded -- on a screen whose own back link is already
       * showing the new name. The draft is untouched, so the retry carries what was typed.
       */
      onAgentChanged();
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
            setDraft(event.currentTarget.value);
            setMessage(undefined);
          }}
        />
      </Field>
      {dirty ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
          <span className="text-sm text-kumo-subtle">Unsaved changes</span>
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={saving} variant="ghost" onClick={discard}>
              Discard
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p
          className={message.kind === "error" ? "text-sm text-kumo-danger" : undefined}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
