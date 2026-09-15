import {
  type ContextTreeOperationRequest,
  ContextTreeOperationRequestSchema,
  type ContextTreeOperationResponse,
} from "@opentag/shared";
import type { ContextTreeOperationOwner } from "../../runtime/context-tree-operation-owner.js";
import type { AgentService } from "./agent-service.js";

/** Validate remotely first, then compare revisions again inside the Agent update transaction. */
export class ContextTreeOperationService {
  constructor(
    readonly agents: Pick<AgentService, "getConfigById" | "updateById">,
    readonly owner: ContextTreeOperationOwner,
  ) {}
  async run(userId: string, agentId: string, raw: ContextTreeOperationRequest): Promise<ContextTreeOperationResponse> {
    const input = ContextTreeOperationRequestSchema.parse(raw);
    const config = await this.agents.getConfigById(userId, agentId);
    if (
      config.revision !== input.expectedRevision ||
      config.runtimeConfig.revision !== input.expectedRuntimeConfigRevision
    )
      return { status: "failed", code: "stale_configuration" };
    if (config.runtimeConfig.contextTreeRepository !== null && config.status !== "suspended")
      return { status: "failed", code: "pause_required" };
    if (!config.computerId) return { status: "failed", code: "computer_unavailable" };
    const result = await this.owner.start({
      agentId,
      computerId: config.computerId,
      requireStopped: config.runtimeConfig.contextTreeRepository !== null,
      input,
    });
    if (result.status !== "completed") return result;
    if (result.repository !== input.repository) return { status: "failed", code: "failed" };
    // Re-read permission, placement, status, and both revisions before applying an asynchronous result.
    const current = await this.agents.getConfigById(userId, agentId);
    if (
      current.revision !== config.revision ||
      current.runtimeConfig.revision !== config.runtimeConfig.revision ||
      current.computerId !== config.computerId ||
      current.status !== config.status
    )
      return { status: "failed", code: "stale_configuration" };
    try {
      await this.agents.updateById(
        userId,
        agentId,
        { expectedRevision: config.revision, runtimeConfig: { contextTreeRepository: input.repository } },
        true,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "AGENT_REVISION_CONFLICT")
        return { status: "failed", code: "stale_configuration" };
      throw error;
    }
    return result;
  }
}
