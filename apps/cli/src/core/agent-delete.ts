import { type AgentCommandDependencies, resolveAgentCommandContext } from "./agent-context.js";

export async function runAgentDelete(agentId: string, options: AgentCommandDependencies = {}): Promise<string> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  await api.deleteAgent(accessToken, agentId);
  return `Deleted Agent ${agentId}`;
}
