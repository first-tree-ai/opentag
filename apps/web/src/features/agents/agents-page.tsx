import type { AgentSummary } from "@opentag/shared/browser";
import { Link } from "react-router-dom";
import { browserApi } from "../../api.js";
import { useResource } from "../../lib/resource.js";
import { useTeam } from "../../session/team-session.js";
import { AsyncState } from "../../ui/async-state.js";
import { EmptyState } from "../../ui/empty-state.js";
import { Page } from "../../ui/page.js";

export function AgentsPage() {
  const { membership } = useTeam();
  const state = useResource(() => browserApi.agents.list(membership.teamId), membership.teamId);
  return (
    <Page
      title="Agents"
      action={
        membership.role === "admin" ? (
          <Link className="button" to="/agents/new">
            Create Agent
          </Link>
        ) : undefined
      }
    >
      <AsyncState state={state}>
        {(value) =>
          value.agents.length === 0 ? (
            <EmptyState title="No Agents yet">A Team Admin can create the first Agent.</EmptyState>
          ) : (
            <div className="card-grid">
              {value.agents.map((agent: AgentSummary) => (
                <AgentCard agent={agent} key={agent.id} />
              ))}
            </div>
          )
        }
      </AsyncState>
    </Page>
  );
}

function AgentCard({ agent }: { agent: AgentSummary }) {
  return (
    <Link className="agent-card" to={`/agents/${agent.id}/general`}>
      <div>
        <strong>{agent.displayName}</strong>
        <small>{agent.name}</small>
      </div>
      <dl>
        <div>
          <dt>Provider</dt>
          <dd>{agent.runtimeProvider}</dd>
        </div>
        <div>
          <dt>Computer</dt>
          <dd>{agent.computer.displayName}</dd>
        </div>
        <div>
          <dt>IM policy</dt>
          <dd>{agent.receiveMode}</dd>
        </div>
      </dl>
    </Link>
  );
}
