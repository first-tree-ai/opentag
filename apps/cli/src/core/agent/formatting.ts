import type { Agent, ListAgentsResponse } from "@opentag/shared";
import type { AgentCreateResult } from "./mutations.js";

export function formatAgentCreated(result: AgentCreateResult): string {
  return `Created Agent ${result.agent.id} (${result.agent.name}) on Computer ${result.agent.computerId}`;
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

export function formatAgent(agent: Agent): string {
  return [
    `id\t${agent.id}`,
    `name\t${agent.name}`,
    `displayName\t${agent.displayName}`,
    `teamId\t${agent.teamId}`,
    `managerUserId\t${agent.managerUserId}`,
    `computerId\t${agent.computerId}`,
    `runtimeProvider\t${agent.runtimeProvider}`,
    `receiveMode\t${agent.receiveMode}`,
    `revision\t${agent.revision}`,
  ].join("\n");
}
