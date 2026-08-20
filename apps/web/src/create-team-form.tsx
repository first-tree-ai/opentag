import type { CreateTeamResponse } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { ApiError, browserApi } from "./api.js";

/** Derives the internal Team handle suggested by a user-facing name. */
export function toTeamHandle(displayName: string): string {
  return displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
}

function handleWithSuffix(handle: string, suffix: string): string {
  const base = (handle || "team").slice(0, 64 - suffix.length - 1).replace(/-+$/g, "") || "team";
  return `${base}-${suffix}`;
}

function randomHandleSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

const MAX_HANDLE_ATTEMPTS = 4;

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      setError(undefined);
      const suggestedHandle = toTeamHandle(displayName);
      for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt += 1) {
        const name =
          attempt === 0 && suggestedHandle ? suggestedHandle : handleWithSuffix(suggestedHandle, randomHandleSuffix());
        try {
          onCreated(await browserApi.createTeam({ name, displayName }));
          return;
        } catch (cause) {
          if (
            !(cause instanceof ApiError) ||
            cause.code !== "TEAM_NAME_CONFLICT" ||
            attempt === MAX_HANDLE_ATTEMPTS - 1
          ) {
            throw cause;
          }
        }
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401 && onUnauthenticated) {
        onUnauthenticated();
        return;
      }
      setError(
        cause instanceof ApiError && cause.code === "TEAM_NAME_CONFLICT"
          ? "We couldn't create a unique team address. Try again."
          : cause instanceof Error
            ? cause.message
            : "The Team could not be created",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form-card" onSubmit={submit}>
      <label>
        Team name
        <input
          name="displayName"
          autoComplete="organization"
          maxLength={120}
          placeholder="e.g. Platform team"
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.currentTarget.value)}
        />
      </label>
      <button className="button" type="submit" disabled={submitting}>
        {submitting ? "Creating…" : submitLabel}
      </button>
      {error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
