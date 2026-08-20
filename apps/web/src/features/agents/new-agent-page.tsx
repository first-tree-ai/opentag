import type { Computer } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { browserApi } from "../../api.js";
import { useResource } from "../../lib/resource.js";
import { UnavailablePage } from "../../routes/fallback-pages.js";
import { useTeam } from "../../session/team-session.js";
import { AsyncState } from "../../ui/async-state.js";
import { EmptyState } from "../../ui/empty-state.js";
import { Notice } from "../../ui/feedback.js";
import { FormCard } from "../../ui/form-card.js";
import { Page } from "../../ui/page.js";

export function NewAgentPage() {
  const { membership } = useTeam();
  const navigate = useNavigate();
  const computers = useResource(() => browserApi.computers.listMine(), membership.teamId);
  const [error, setError] = useState<string>();
  if (membership.role !== "admin") return <UnavailablePage title="Team Admin access required" />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const created = await browserApi.agents.create(membership.teamId, {
        name: String(data.get("name") ?? ""),
        displayName: String(data.get("displayName") ?? ""),
        runtimeProvider: String(data.get("runtimeProvider") ?? "codex") as "codex" | "claude-code",
        computerId: String(data.get("computerId") ?? ""),
      });
      navigate(`/agents/${created.id}/general`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent creation failed");
    }
  }
  return (
    <Page title="Create Agent">
      <AsyncState state={computers}>
        {(value) =>
          value.computers.length === 0 ? (
            <EmptyState title="Connect a Local Computer first">
              Open <Link to="/settings/computers">Computer settings</Link> to generate a connection command.
            </EmptyState>
          ) : (
            <FormCard onSubmit={submit}>
              <label>
                Name
                <input name="name" required pattern="[a-z0-9][a-z0-9-]*" />
              </label>
              <label>
                Display name
                <input name="displayName" required />
              </label>
              <label>
                Provider
                <select name="runtimeProvider">
                  <option value="codex">Codex</option>
                  <option value="claude-code">Claude Code</option>
                </select>
              </label>
              <label>
                Computer
                <select name="computerId" required>
                  {value.computers.map((computer: Computer) => (
                    <option value={computer.id} key={computer.id}>
                      {computer.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">New Agents receive only direct mentions by default.</p>
              <button className="button" type="submit">
                Create Agent
              </button>
              {error ? <Notice tone="error">{error}</Notice> : null}
            </FormCard>
          )
        }
      </AsyncState>
    </Page>
  );
}
