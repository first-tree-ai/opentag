import type { AgentAdminConfig, ListAgentsResponse } from "@opentag/shared";
import { selectWorkspace } from "../selection/workspace.js";
import { type AgentCommandDependencies, resolveAgentCommandContext } from "./context.js";

export interface AgentListOptions extends AgentCommandDependencies {
  workspaceName?: string;
}

export async function runAgentList(options: AgentListOptions = {}): Promise<ListAgentsResponse> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  const workspace = selectWorkspace(await api.me(accessToken), options.workspaceName);
  return api.listAgents(accessToken, workspace.id);
}

export async function runAgentShow(agentId: string, options: AgentCommandDependencies = {}): Promise<AgentAdminConfig> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.getAgentConfig(accessToken, agentId);
}
