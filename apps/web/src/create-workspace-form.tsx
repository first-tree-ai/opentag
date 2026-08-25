import type { CreateWorkspaceResponse } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { ApiError, browserApi } from "./api.js";
import { Button, Field } from "./ui/design-system.js";

/** Derives the internal Workspace handle suggested by a user-facing name. */
export function toWorkspaceHandle(displayName: string): string {
  return displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
}

function handleWithSuffix(handle: string, suffix: string): string {
  const base = (handle || "workspace").slice(0, 64 - suffix.length - 1).replace(/-+$/g, "") || "workspace";
  return `${base}-${suffix}`;
}

function randomHandleSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

const MAX_HANDLE_ATTEMPTS = 4;

/** Creates a Workspace without exposing its internal handle, retrying deterministic handle collisions. */
export async function createWorkspaceWithUniqueHandle(displayName: string): Promise<CreateWorkspaceResponse> {
  const suggestedHandle = toWorkspaceHandle(displayName);
  for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt += 1) {
    const name =
      attempt === 0 && suggestedHandle ? suggestedHandle : handleWithSuffix(suggestedHandle, randomHandleSuffix());
    try {
      return await browserApi.createWorkspace({ name, displayName });
    } catch (cause) {
      if (
        !(cause instanceof ApiError) ||
        cause.code !== "WORKSPACE_NAME_CONFLICT" ||
        attempt === MAX_HANDLE_ATTEMPTS - 1
      ) {
        throw cause;
      }
    }
  }
  throw new Error("The Workspace could not be created");
}

/**
 * The single Workspace creation form. It is mounted by the standalone `/workspaces/new` page for both first-run
 * and additional Workspace creation while the backing domain continues to use Workspace identifiers.
 * The caller owns what happens next; this component owns the fields, the derivation and the error surface.
 */
export function CreateWorkspaceForm({
  onCreated,
  onUnauthenticated,
  submitLabel = "Create Workspace",
}: {
  onCreated: (workspace: CreateWorkspaceResponse) => void;
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
      onCreated(await createWorkspaceWithUniqueHandle(displayName));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401 && onUnauthenticated) {
        onUnauthenticated();
        return;
      }
      setError(
        cause instanceof ApiError && cause.code === "WORKSPACE_NAME_CONFLICT"
          ? "We couldn't create a unique Workspace address. Try again."
          : cause instanceof Error
            ? cause.message
            : "The Workspace could not be created",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form-card" onSubmit={submit}>
      <Field htmlFor="workspace-display-name" label="Workspace name">
        <input
          id="workspace-display-name"
          name="displayName"
          autoComplete="organization"
          maxLength={120}
          placeholder="e.g. Platform Workspace"
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.currentTarget.value)}
        />
      </Field>
      <Button type="submit" disabled={submitting}>
        {submitting ? "Creating…" : submitLabel}
      </Button>
      {error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
