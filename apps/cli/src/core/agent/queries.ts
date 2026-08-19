import type { Agent, ListAgentsResponse } from "@opentag/shared";
import { selectTeam } from "../selection/team.js";
import { type AgentCommandDependencies, resolveAgentCommandContext } from "./context.js";

export interface AgentListOptions extends AgentCommandDependencies {
  teamName?: string;
}

export async function runAgentList(options: AgentListOptions = {}): Promise<ListAgentsResponse> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  const team = selectTeam(await api.me(accessToken), options.teamName);
  return api.listAgents(accessToken, team.teamId);
}

export async function runAgentShow(agentId: string, options: AgentCommandDependencies = {}): Promise<Agent> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.getAgent(accessToken, agentId);
}
