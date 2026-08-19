import type { Agent } from "@opentag/shared";
import { type AgentCommandDependencies, resolveAgentCommandContext } from "./agent-context.js";

export interface AgentUpdateOptions extends AgentCommandDependencies {
  displayName: string;
}

export async function runAgentUpdate(agentId: string, options: AgentUpdateOptions): Promise<Agent> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  const current = await api.getAgent(accessToken, agentId);
  return api.updateAgent(accessToken, agentId, {
    displayName: options.displayName,
    expectedRevision: current.revision,
  });
}
