import type { ListAgentsResponse } from "@opentag/shared";
import { type AgentCommandDependencies, resolveAgentCommandContext } from "./agent-context.js";
import { selectTeam } from "./team-selection.js";

export interface AgentListOptions extends AgentCommandDependencies {
  teamName?: string;
}

export async function runAgentList(options: AgentListOptions = {}): Promise<ListAgentsResponse> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  const team = selectTeam(await api.me(accessToken), options.teamName);
  return api.listAgents(accessToken, team.teamId);
}

export function formatAgentList(response: ListAgentsResponse): string {
  if (response.agents.length === 0) return "No Agents registered";
  return response.agents
    .map((agent) =>
      [
        agent.name,
        agent.id,
        agent.displayName,
        agent.runtimeProvider,
        agent.computerId,
        `revision=${agent.revision}`,
      ].join("\t"),
    )
    .join("\n");
}
