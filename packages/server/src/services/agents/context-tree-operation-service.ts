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
    readonly agents: Pick<AgentService, "getConfigById" | "updateContextTreeSelection">,
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
    const result: ContextTreeOperationResponse =
      input.action === "disconnect"
        ? { status: "completed", repository: null }
        : config.computerId
          ? await this.owner.start({
              agentId,
              computerId: config.computerId,
              requireStopped: config.runtimeConfig.contextTreeRepository !== null,
              input,
            })
          : { status: "failed", code: "computer_unavailable" };
    if (result.status !== "completed") return result;
    if (result.repository?.toLowerCase() !== input.repository?.toLowerCase())
      return { status: "failed", code: "failed" };
    try {
      await this.agents.updateContextTreeSelection(
        userId,
        agentId,
        {
          revision: config.revision,
          runtimeConfigRevision: config.runtimeConfig.revision,
          computerId: config.computerId,
          status: config.status,
        },
        input.repository,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "AGENT_REVISION_CONFLICT")
        return { status: "failed", code: "stale_configuration" };
      throw error;
    }
    return result;
  }
}
