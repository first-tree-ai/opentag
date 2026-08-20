import type { MeMembership } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { browserApi } from "../../api.js";
import { DefinitionList } from "../../ui/data-display.js";
import { Status } from "../../ui/feedback.js";
import { FormCard } from "../../ui/form-card.js";

export function TeamSettings({ membership, refreshMe }: { membership: MeMembership; refreshMe: () => void }) {
  const [message, setMessage] = useState<string>();
  if (membership.role !== "admin") {
    return (
      <DefinitionList
        rows={[
          ["Canonical name", membership.teamName],
          ["Display name", membership.teamDisplayName],
          ["Your role", membership.role],
        ]}
      />
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      setMessage(undefined);
      await browserApi.teams.update(membership.teamId, {
        name: String(data.get("name") ?? ""),
        displayName: String(data.get("displayName") ?? ""),
      });
      refreshMe();
      setMessage("Team profile saved.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save the Team profile");
    }
  }
  return (
    <FormCard key={`${membership.teamName}:${membership.teamDisplayName}`} onSubmit={submit}>
      <h2>Team profile</h2>
      <label>
        Canonical name
        <input defaultValue={membership.teamName} name="name" pattern="[A-Za-z0-9][A-Za-z0-9-]*" required />
      </label>
      <p className="muted">Changing this name immediately changes the CLI --team selector. The Team ID stays stable.</p>
      <label>
        Display name
        <input defaultValue={membership.teamDisplayName} name="displayName" required />
      </label>
      <button className="button" type="submit">
        Save Team profile
      </button>
      {message ? <Status>{message}</Status> : null}
    </FormCard>
  );
}
