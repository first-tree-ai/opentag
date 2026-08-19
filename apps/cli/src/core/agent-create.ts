import type { Agent, Computer, ListComputersResponse } from "@opentag/shared";
import { CreateAgentRequestSchema } from "@opentag/shared";
import { type AgentCommandDependencies, resolveAgentCommandContext } from "./agent-context.js";
import { selectTeam } from "./team-selection.js";

export interface AgentCreateOptions extends AgentCommandDependencies {
  computerId?: string;
  displayName: string;
  name: string;
  runtimeProvider: string;
  teamName?: string;
}

export interface AgentCreateResult {
  agent: Agent;
  warning?: string;
}

export function selectComputer(response: ListComputersResponse, requestedComputerId?: string): Computer {
  if (requestedComputerId) {
    const selected = response.computers.find((computer) => computer.id === requestedComputerId);
    if (!selected) throw new Error(`Computer "${requestedComputerId}" is not owned by the current user`);
    return selected;
  }
  if (response.computers.length === 1) {
    const selected = response.computers[0];
    if (!selected) throw new Error("No Computer is registered; start the daemon first");
    return selected;
  }
  if (response.computers.length === 0) throw new Error("No Computer is registered; start the daemon first");
  throw new Error("Multiple Computers are available; use --computer <uuid>");
}

export async function runAgentCreate(options: AgentCreateOptions): Promise<AgentCreateResult> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  const [me, computers] = await Promise.all([api.me(accessToken), api.listComputers(accessToken)]);
  const team = selectTeam(me, options.teamName);
  const computer = selectComputer(computers, options.computerId);
  const input = CreateAgentRequestSchema.parse({
    name: options.name,
    displayName: options.displayName,
    runtimeProvider: options.runtimeProvider,
    computerId: computer.id,
  });
  const agent = await api.createAgent(accessToken, team.teamId, input);
  return {
    agent,
    ...(computer.connectionStatus === "offline"
      ? { warning: `Computer ${computer.id} is offline; the Agent configuration was created` }
      : {}),
  };
}

export function formatAgentCreated(result: AgentCreateResult): string {
  return `Created Agent ${result.agent.id} (${result.agent.name}) on Computer ${result.agent.computerId}`;
}
