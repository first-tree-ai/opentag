import type { AgentAdminConfig, AgentSummary, CreateAgentRequest } from "@opentag/shared/browser";
import { ApiError } from "../api.js";

/**
 * `agents_team_name_active_unique` makes a retried Agent creation fail with
 * AGENT_NAME_CONFLICT. That is exactly what happens when the first request
 * succeeded on the Server but its response never reached the browser: the Agent
 * exists, the browser does not know its ID, and a naive retry would either fail
 * the flow or push the admin into inventing a second name and a second Agent.
 * Recovering the Agent by name keeps onboarding idempotent.
 */
export const AGENT_NAME_CONFLICT_CODE = "AGENT_NAME_CONFLICT";

export type AgentCreationOutcome =
  | { readonly kind: "created"; readonly agent: AgentAdminConfig }
  | { readonly kind: "recovered"; readonly agent: AgentAdminConfig };

export interface AgentCreationPort {
  createAgent(input: CreateAgentRequest): Promise<AgentAdminConfig>;
  listAgents(): Promise<readonly AgentSummary[]>;
  agentConfig(agentId: string): Promise<AgentAdminConfig>;
}

export function isAgentNameConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === AGENT_NAME_CONFLICT_CODE;
}

/**
 * Finds an Agent this manager already owns under `name`. A name held by another
 * manager is a real conflict, not a lost response, so it is deliberately not
 * adopted.
 */
export function findRecoverableAgent(
  agents: readonly AgentSummary[],
  name: string,
  managerUserId: string,
): AgentSummary | undefined {
  return agents.find((agent) => agent.name === name && agent.manager.userId === managerUserId);
}

export async function createOrRecoverAgent(
  port: AgentCreationPort,
  input: CreateAgentRequest,
  managerUserId: string,
): Promise<AgentCreationOutcome> {
  try {
    return { kind: "created", agent: await port.createAgent(input) };
  } catch (cause) {
    if (!isAgentNameConflict(cause)) throw cause;
    const existing = findRecoverableAgent(await port.listAgents(), input.name, managerUserId);
    if (!existing) throw cause;
    return { kind: "recovered", agent: await port.agentConfig(existing.id) };
  }
}
