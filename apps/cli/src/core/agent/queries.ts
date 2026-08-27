import type { AgentAdminConfig, ListAgentsResponse } from "@opentag/shared";
import { type AgentCommandDependencies, resolveAgentCommandContext } from "./context.js";

export type AgentListOptions = AgentCommandDependencies;

export async function runAgentList(options: AgentListOptions = {}): Promise<ListAgentsResponse> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.listAgents(accessToken);
}

export async function runAgentShow(agentId: string, options: AgentCommandDependencies = {}): Promise<AgentAdminConfig> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.getAgentConfig(accessToken, agentId);
}
