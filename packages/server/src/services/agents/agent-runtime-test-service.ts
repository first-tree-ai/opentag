import {
  type AgentRuntimeTestRequest,
  AgentRuntimeTestRequestSchema,
  type AgentRuntimeTestResponse,
} from "@opentag/shared";
import type { AgentRuntimeTestOwner } from "../../runtime/agent-runtime-test-owner.js";
import type { AgentService } from "./agent-service.js";
import { AgentServiceError } from "./errors.js";

/**
 * The Cloud probe boundary: a bounded Server-to-model connectivity test against the deployment
 * Router with the Agent's saved/default model. Implemented by CloudAgentRuntimeTester; no
 * Session, Sandbox, or Instance is created and no product history is written.
 */
export interface CloudAgentRuntimeTestPort {
  test(input: { computerId: string; model: string | null; signal?: AbortSignal }): Promise<AgentRuntimeTestResponse>;
}

export class AgentRuntimeTestService {
  readonly #agents: Pick<AgentService, "getConfigById">;
  readonly #owner: AgentRuntimeTestOwner;
  readonly #cloud?: CloudAgentRuntimeTestPort;
  readonly #computerKind?: (computerId: string) => Promise<"local" | "cloud" | undefined>;

  constructor(
    agents: Pick<AgentService, "getConfigById">,
    owner: AgentRuntimeTestOwner,
    options: {
      /**
       * Server-derived Computer kind read; absent keeps the historical Local-only behavior (a
       * Cloud Computer then reports computer_unavailable from the Local registry, as before).
       */
      computerKind?: (computerId: string) => Promise<"local" | "cloud" | undefined>;
      /** Present exactly when the deployment's Cloud model path is enabled. */
      cloud?: CloudAgentRuntimeTestPort;
    } = {},
  ) {
    this.#agents = agents;
    this.#owner = owner;
    this.#computerKind = options.computerKind;
    this.#cloud = options.cloud;
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
    // Branch on the server-derived bound Computer kind (ownership was already proven by
    // getConfigById): a Cloud Computer has no Local daemon connection, so the test is the bounded
    // hosted-model connectivity probe instead of a dispatch.
    if ((await this.#computerKind?.(config.computerId)) === "cloud") {
      const cloud = this.#cloud;
      if (!cloud) return { status: "failed", code: "computer_unavailable" };
      return cloud.test({
        computerId: config.computerId,
        model: config.runtimeConfig.model,
        ...(signal ? { signal } : {}),
      });
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
