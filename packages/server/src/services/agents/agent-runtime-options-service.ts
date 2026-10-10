import type { AgentRuntimeOptions } from "@opentag/shared";
import type { AgentRuntimeOptionsOwner } from "../../runtime/agent-runtime-options-owner.js";
import type { AgentService } from "./agent-service.js";
import { AgentServiceError } from "./errors.js";

export class AgentRuntimeOptionsService {
  constructor(
    readonly agents: Pick<AgentService, "getConfigById">,
    readonly owner: AgentRuntimeOptionsOwner,
    readonly computerKind: (computerId: string) => Promise<"local" | "cloud" | undefined>,
  ) {}

  async get(userId: string, agentId: string, model?: string, signal?: AbortSignal): Promise<AgentRuntimeOptions> {
    const config = await this.agents.getConfigById(userId, agentId);
    if (!config.computerId)
      throw new AgentServiceError(
        "AGENT_COMPUTER_NOT_BOUND",
        "deterministic",
        "The Agent is not bound to a Computer",
        409,
      );
    if ((await this.computerKind(config.computerId)) !== "local")
      throw new AgentServiceError(
        "PROTOCOL_CAPABILITY_UNSUPPORTED",
        "deterministic",
        "Local runtime options require a Local Computer",
        501,
      );
    const result = await this.owner.start(
      { agentId, computerId: config.computerId, provider: config.runtimeProvider, ...(model ? { model } : {}) },
      signal,
    );
    const current = await this.agents.getConfigById(userId, agentId);
    if (current.computerId !== config.computerId || current.runtimeProvider !== config.runtimeProvider)
      throw new AgentServiceError(
        "AGENT_REVISION_CONFLICT",
        "deterministic",
        "Agent placement changed while reading runtime options",
        409,
      );
    return result;
  }
}
