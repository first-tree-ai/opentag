import type { CreateTeamResponse } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { ApiError, browserApi } from "./api.js";

/** Derives the canonical Team handle a display name suggests; the user stays free to replace it. */
export function toTeamHandle(displayName: string): string {
  return displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
}

/**
 * Canonical names are ASCII, so derivation drops anything else. Latin accents survive as their base letter,
 * but other scripts leave nothing behind: the suggestion silently empties or keeps only an ASCII fragment,
 * which the user has to be told rather than left to notice.
 */
function dropsCharactersFromHandle(displayName: string): boolean {
  return /[^\p{ASCII}]/u.test(displayName.normalize("NFKD").replace(/\p{M}/gu, ""));
}

/**
 * The single Team creation form. It is mounted both by the standalone `/teams/new` page and by the first
 * onboarding step, so creating a Team behaves identically whether it is a first-run or an additional Team.
 * The caller owns what happens next; this component owns the fields, the derivation and the error surface.
 */
export function CreateTeamForm({
  onCreated,
  onUnauthenticated,
  submitLabel = "Create Team",
}: {
  onCreated: (team: CreateTeamResponse) => void;
  onUnauthenticated?: () => void;
  submitLabel?: string;
}) {
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      setError(undefined);
      onCreated(await browserApi.createTeam({ name, displayName }));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401 && onUnauthenticated) {
        onUnauthenticated();
        return;
      }
      setError(cause instanceof Error ? cause.message : "The Team could not be created");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form-card" onSubmit={submit}>
      <label>
        Display name
        <input
          name="displayName"
          required
          value={displayName}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDisplayName(value);
            if (!nameEdited) setName(toTeamHandle(value));
          }}
        />
      </label>
      <label>
        Canonical name
        <input
          name="name"
          required
          pattern="[a-z0-9][a-z0-9-]*"
          maxLength={64}
          value={name}
          onChange={(event) => {
            const value = event.currentTarget.value;
            // Emptying the field hands control back to the display name instead of latching it off.
            setNameEdited(value.length > 0);
            setName(value);
          }}
        />
      </label>
      {displayName && dropsCharactersFromHandle(displayName) ? (
        <p className="notice" role="status">
          A canonical name can only use lowercase letters, digits and hyphens, so the suggestion above leaves out the
          rest of “{displayName}”. Write the name you want teammates to type in the CLI.
        </p>
      ) : null}
      <p className="muted">
        Lowercase letters, digits and hyphens. This is the CLI --team selector and must be unique across OpenTag; Team
        Admins can change it later.
      </p>
      <button className="button" type="submit" disabled={submitting}>
        {submitLabel}
      </button>
      {error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
