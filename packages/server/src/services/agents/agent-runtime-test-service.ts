import {
  type AgentRuntimeTestRequest,
  AgentRuntimeTestRequestSchema,
  type AgentRuntimeTestResponse,
} from "@opentag/shared";
import type { AgentRuntimeTestOwner } from "../../runtime/agent-runtime-test-owner.js";
import type { AgentService } from "./agent-service.js";
import { AgentServiceError } from "./errors.js";

export class AgentRuntimeTestService {
  readonly #agents: Pick<AgentService, "getConfigById">;
  readonly #owner: AgentRuntimeTestOwner;

  constructor(agents: Pick<AgentService, "getConfigById">, owner: AgentRuntimeTestOwner) {
    this.#agents = agents;
    this.#owner = owner;
  }

  async test(
    callerUserId: string,
    agentId: string,
    rawInput: AgentRuntimeTestRequest,
    signal?: AbortSignal,
  ): Promise<AgentRuntimeTestResponse> {
    const input = AgentRuntimeTestRequestSchema.parse(rawInput);
    const config = await this.#agents.getConfigById(callerUserId, agentId);
    if (
      config.revision !== input.expectedRevision ||
      config.runtimeConfig.revision !== input.expectedRuntimeConfigRevision
    ) {
      return { status: "failed", code: "stale_configuration" };
    }
    // Placement derives the Computer from the Agent, so an Agent that has none has nowhere to run
    // the test. Refusing keeps this consistent with Session placement and IM delivery rather than
    // reporting a verdict about a machine that was never chosen.
    if (config.computerId === null) {
      throw new AgentServiceError(
        "AGENT_COMPUTER_NOT_BOUND",
        "deterministic",
        "The Agent is not bound to a Computer",
        409,
      );
    }
    return this.#owner.start(config.computerId, {
      computerId: config.computerId,
      provider: config.runtimeProvider,
      ...(config.runtimeConfig.model ? { model: config.runtimeConfig.model } : {}),
      ...(config.runtimeConfig.reasoningEffort ? { reasoningEffort: config.runtimeConfig.reasoningEffort } : {}),
      signal,
    });
  }
}
