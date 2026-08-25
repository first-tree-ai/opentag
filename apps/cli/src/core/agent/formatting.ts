import type { AgentAdminConfig, ListAgentsResponse } from "@opentag/shared";
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
        agent.status,
        agent.runtimeProvider,
        agent.computer.computerId,
        agent.receiveMode,
      ].join("\t"),
    )
    .join("\n");
}

export function formatAgent(agent: AgentAdminConfig): string {
  return [
    `id\t${agent.id}`,
    `name\t${agent.name}`,
    `displayName\t${agent.displayName}`,
    `workspaceId\t${agent.workspaceId}`,
    `createdByUserId\t${agent.createdByUserId}`,
    `computerId\t${agent.computerId}`,
    `runtimeProvider\t${agent.runtimeProvider}`,
    `receiveMode\t${agent.receiveMode}`,
    `status\t${agent.status}`,
    `revision\t${agent.revision}`,
    `runtimeConfig.revision\t${agent.runtimeConfig.revision}`,
    `runtimeConfig.model\t${agent.runtimeConfig.model ?? ""}`,
    `runtimeConfig.reasoningEffort\t${agent.runtimeConfig.reasoningEffort ?? ""}`,
    `runtimeConfig.instructions\t${JSON.stringify(agent.runtimeConfig.instructions)}`,
    `runtimeConfig.maxDurationMs\t${agent.runtimeConfig.maxDurationMs ?? ""}`,
  ].join("\n");
}
