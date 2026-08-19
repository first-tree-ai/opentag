import type { Agent } from "@opentag/shared";
import { type AgentCommandDependencies, resolveAgentCommandContext } from "./agent-context.js";

export async function runAgentShow(agentId: string, options: AgentCommandDependencies = {}): Promise<Agent> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.getAgent(accessToken, agentId);
}

export function formatAgent(agent: Agent): string {
  return [
    `id\t${agent.id}`,
    `name\t${agent.name}`,
    `displayName\t${agent.displayName}`,
    `teamId\t${agent.teamId}`,
    `managerUserId\t${agent.managerUserId}`,
    `computerId\t${agent.computerId}`,
    `runtimeProvider\t${agent.runtimeProvider}`,
    `revision\t${agent.revision}`,
  ].join("\n");
}
