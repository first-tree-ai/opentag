import {
  type AgentAdminConfig,
  type ContextTreeOperationRequest,
  ContextTreeOperationRequestSchema,
  type ContextTreeOperationResponse,
} from "@opentag/shared";
import type { ContextTreeOperationOwner } from "../../runtime/context-tree-operation-owner.js";
import type { AgentService } from "./agent-service.js";
import type { CloudContextTreeOperationRunner } from "./cloud-context-tree-operations.js";

/** Validate remotely first, then compare revisions again inside the Agent update transaction. */
export class ContextTreeOperationService {
  constructor(
    readonly agents: Pick<AgentService, "getConfigById" | "updateContextTreeSelection">,
    readonly owner: ContextTreeOperationOwner,
    /** Server-side Cloud connect for Cloud Computers, which have no Runtime owner WebSocket. */
    readonly cloud?: CloudContextTreeOperationRunner,
  ) {}
  async run(userId: string, agentId: string, raw: ContextTreeOperationRequest): Promise<ContextTreeOperationResponse> {
    const input = ContextTreeOperationRequestSchema.parse(raw);
    const config = await this.agents.getConfigById(userId, agentId);
    if (
      config.revision !== input.expectedRevision ||
      config.runtimeConfig.revision !== input.expectedRuntimeConfigRevision
    )
      return { status: "failed", code: "stale_configuration" };
    const connections = config.runtimeConfig.contextTrees;
    const unchanged = attachmentOutcome(config, input);
    if (unchanged) return unchanged;
    if (connections.length > 0 && config.status !== "suspended") return { status: "failed", code: "pause_required" };
    const result: ContextTreeOperationResponse =
      input.action === "disconnect"
        ? { status: "completed", repository: null }
        : await this.#dispatch(userId, agentId, config, input.action, input);
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
        input.action === "disconnect"
          ? connections.filter((entry) => entry.alias !== input.alias)
          : [...connections, { alias: input.alias, repository: input.repository as string }],
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "AGENT_REVISION_CONFLICT")
        return { status: "failed", code: "stale_configuration" };
      throw error;
    }
    return result;
  }

  /**
   * Both paths share the revision/pause gates and the CAS commit above; only the execution venue
   * differs. Disconnect needs neither. The schema refinement guarantees a repository here.
   */
  async #dispatch(
    userId: string,
    agentId: string,
    config: AgentAdminConfig,
    action: "connect" | "create",
    input: ContextTreeOperationRequest,
  ): Promise<ContextTreeOperationResponse> {
    if (config.computerId === null) return { status: "failed", code: "computer_unavailable" };
    if (this.cloud && (await this.cloud.computerKind(config.computerId)) === "cloud") {
      return this.cloud.run({
        accountId: userId,
        agentId,
        action,
        alias: input.alias,
        repository: input.repository ?? "",
      });
    }
    return this.owner.start({
      agentId,
      computerId: config.computerId,
      requireStopped: config.runtimeConfig.contextTrees.length > 0,
      input,
    });
  }
}

/** Idempotence and collisions are decided before any remote verification or publication. */
function attachmentOutcome(
  config: AgentAdminConfig,
  input: ContextTreeOperationRequest,
): ContextTreeOperationResponse | undefined {
  const connections = config.runtimeConfig.contextTrees;
  const existing = connections.find((entry) => entry.alias === input.alias);
  if (input.action !== "disconnect") {
    if (existing)
      return existing.repository.toLowerCase() === input.repository?.toLowerCase()
        ? { status: "completed", repository: existing.repository }
        : { status: "failed", code: "alias_conflict" };
    if (connections.some((entry) => entry.repository.toLowerCase() === input.repository?.toLowerCase()))
      return { status: "failed", code: "repository_conflict" };
  } else if (!existing) return { status: "completed", repository: null };
  return undefined;
}
