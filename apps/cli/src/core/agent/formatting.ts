import type { AgentAdminConfig, ListAgentsResponse } from "@opentag/shared";
import type { AgentBindResult, AgentCreateResult } from "./mutations.js";

export function formatAgentCreated(result: AgentCreateResult): string {
  const created = `Created Agent ${result.agent.id} (${result.agent.name})`;
  return result.agent.computerId
    ? `${created} on Computer ${result.agent.computerId}`
    : `${created} without a Computer`;
}

export function formatAgentBound(result: AgentBindResult): string {
  return `Bound Agent ${result.agent.id} (${result.agent.name}) to Computer ${result.agent.computerId}`;
}

/**
 * How an absent Computer is written in the machine-readable output. An empty field reads as a value
 * that went missing; an Agent with no Computer is a stated fact, and it is the one thing about the
 * Agent that a reader of this output most needs to see. It cannot be mistaken for an identifier.
 */
const NO_COMPUTER = "none";

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
        agent.computer?.computerId ?? NO_COMPUTER,
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
    `createdByUserId\t${agent.createdByUserId}`,
    `computerId\t${agent.computerId ?? NO_COMPUTER}`,
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
