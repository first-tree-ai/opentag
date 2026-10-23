import {
  type AgentAdminConfig,
  CONTEXT_TREES_MAX,
  type ContextTreeConnection,
  ContextTreeConnectionSchema,
  type ContextTreeOperationRequest,
  ContextTreeOperationRequestSchema,
  type ContextTreeOperationResponse,
  contextTreeIdentity,
  RUNTIME_CAPABILITY,
} from "@opentag/shared";
import type { ConnectionRegistry } from "../../runtime/connection-registry.js";
import type { AgentService } from "./agent-service.js";
import type { GitHubContextTreeOperationRunner } from "./github-context-tree-operations.js";

/** Validate remotely first, then compare revisions again inside the Agent update transaction. */
export class ContextTreeOperationService {
  constructor(
    readonly agents: Pick<AgentService, "getConfigById" | "updateContextTreeSelection">,
    readonly registry: Pick<ConnectionRegistry, "currentInstanceId" | "supportsCapability">,
    readonly github: GitHubContextTreeOperationRunner,
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
    const selection = updatedSelection(connections, input, result);
    if (!selection) return { status: "failed", code: "failed" };
    if (selection === connections) return result;
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
        selection,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "AGENT_REVISION_CONFLICT")
        return { status: "failed", code: "stale_configuration" };
      throw error;
    }
    return result;
  }

  /** GitHub settings operations always run on the Server. */
  async #dispatch(
    userId: string,
    agentId: string,
    config: AgentAdminConfig,
    action: "connect" | "create",
    input: ContextTreeOperationRequest,
  ): Promise<ContextTreeOperationResponse> {
    if (config.computerId === null) return { status: "failed", code: "computer_unavailable" };
    const kind = await this.github.computerKind(config.computerId);
    if (!kind) return { status: "failed", code: "computer_unavailable" };
    if (kind === "local") {
      const failure = this.#checkComputer(config.computerId);
      if (failure) return failure;
    }
    const result = await this.github.run({
      accountId: userId,
      agentId,
      action,
      path: input.path,
      ref: input.ref,
      repository: input.repository,
    });
    // A reconnect during remote verification must not persist a selection for an older peer.
    return kind === "local" && result.status === "completed"
      ? (this.#checkComputer(config.computerId) ?? result)
      : result;
  }

  #checkComputer(computerId: string): Extract<ContextTreeOperationResponse, { status: "failed" }> | undefined {
    const instanceId = this.registry.currentInstanceId(computerId);
    if (!instanceId) return { status: "failed", code: "computer_unavailable" };
    if (!this.registry.supportsCapability(computerId, instanceId, RUNTIME_CAPABILITY.contextTreeSettings))
      return { status: "failed", code: "capability_missing" };
    return undefined;
  }
}

/** Idempotence and collisions are decided before any remote verification or publication. */
function attachmentOutcome(
  config: AgentAdminConfig,
  input: ContextTreeOperationRequest,
): ContextTreeOperationResponse | undefined {
  const connections = config.runtimeConfig.contextTrees;
  const existing = connections.find(
    (entry) =>
      contextTreeIdentity(entry) === contextTreeIdentity(input) ||
      (input.action === "create" &&
        input.ref === "HEAD" &&
        entry.repository.toLowerCase() === input.repository.toLowerCase() &&
        entry.path === input.path),
  );
  if (input.action !== "disconnect") {
    if (existing)
      return {
        status: "completed",
        repository: existing.repository,
        ...(input.ref === "HEAD" ? { ref: existing.ref } : {}),
      };
    if (connections.length >= CONTEXT_TREES_MAX) return { status: "failed", code: "tree_limit_reached" };
  } else if (!existing) return { status: "completed", repository: null };
  return undefined;
}

function updatedSelection(
  connections: ContextTreeConnection[],
  input: ContextTreeOperationRequest,
  result: Extract<ContextTreeOperationResponse, { status: "completed" }>,
): ContextTreeConnection[] | undefined {
  if (result.repository?.toLowerCase() !== (input.action === "disconnect" ? undefined : input.repository.toLowerCase()))
    return undefined;
  if (input.action === "disconnect")
    return connections.filter((entry) => contextTreeIdentity(entry) !== contextTreeIdentity(input));
  if (input.ref === "HEAD" && (!result.ref || result.ref === "HEAD")) return undefined;
  const source = ContextTreeConnectionSchema.parse({
    kind: input.kind,
    repository: input.repository,
    path: input.path,
    ref: result.ref ?? input.ref,
  });
  return connections.some((entry) => contextTreeIdentity(entry) === contextTreeIdentity(source))
    ? connections
    : [...connections, source];
}
