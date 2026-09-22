import type {
  AgentAdminConfig,
  MCPAgentServer,
  MCPAvailableServer,
  UpdateSelfAgentRequest,
  UpdateSelfMCPBindingRequest,
} from "@opentag/shared";
import { and, eq, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { McpServerService } from "../mcp/index.js";
import type { SessionCliProofService } from "../sessions/session-cli-proof-service.js";
import type { AgentService } from "./agent-service.js";
import { resourceNotFound } from "./errors.js";

/**
 * Agent self-configuration, authorized by a Session CLI proof.
 *
 * The proof is the only identity input: it resolves the Agent, and the Agent's owning Account is
 * read from the Agent row, never from the request. Every operation then delegates to the same
 * Account-scoped service the Account surface uses, so ownership checks, revision conflicts, and
 * Cloud model validation apply unchanged. The narrowing of what an Agent may change is enforced by
 * the request schemas in `@opentag/shared` (`agent-self.ts`) and by which service calls exist here.
 */

export interface AgentOwnerResolver {
  resolveAccountId(agentId: string): Promise<string>;
}

export class DatabaseAgentOwnerResolver implements AgentOwnerResolver {
  readonly #database: DatabaseClient;

  constructor(database: DatabaseClient) {
    this.#database = database;
  }

  async resolveAccountId(agentId: string): Promise<string> {
    const [row] = await this.#database
      .select({ accountId: agents.createdByUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!row) throw resourceNotFound();
    return row.accountId;
  }
}

export interface AgentSelfServiceOptions {
  agents: Pick<AgentService, "getConfigById" | "updateById">;
  logger?: ServiceLogger;
  mcp: Pick<
    McpServerService,
    "attachServer" | "detachServer" | "listAgentServers" | "listAvailableServers" | "updateBinding"
  >;
  owners: AgentOwnerResolver;
  proofs: Pick<SessionCliProofService, "authenticate">;
}

/** The authenticated self scope. Only `authenticate` creates one; callers pass it back unchanged. */
export interface AgentSelfScope {
  readonly accountId: string;
  readonly agentId: string;
  readonly sessionId: string;
}

export class AgentSelfService {
  readonly #options: AgentSelfServiceOptions;

  constructor(options: AgentSelfServiceOptions) {
    this.#options = options;
  }

  async getConfig(scope: AgentSelfScope): Promise<AgentAdminConfig> {
    return this.#options.agents.getConfigById(scope.accountId, scope.agentId);
  }

  async updateConfig(scope: AgentSelfScope, input: UpdateSelfAgentRequest): Promise<AgentAdminConfig> {
    const updated = await this.#options.agents.updateById(scope.accountId, scope.agentId, {
      expectedRevision: input.expectedRevision,
      runtimeConfig: input.runtimeConfig,
    });
    // Field names only: instructions are Agent-authored text and never belong in a log line.
    this.#audit(scope, "agent_self.config_updated", {
      fields: Object.keys(input.runtimeConfig).sort(),
      revision: updated.revision,
      runtimeConfigRevision: updated.runtimeConfig.revision,
    });
    return updated;
  }

  async listMcpServers(scope: AgentSelfScope): Promise<MCPAgentServer[]> {
    return this.#options.mcp.listAgentServers(scope.accountId, scope.agentId);
  }

  async listAvailableMcpServers(scope: AgentSelfScope): Promise<MCPAvailableServer[]> {
    return this.#options.mcp.listAvailableServers(scope.accountId, scope.agentId);
  }

  async attachMcpServer(scope: AgentSelfScope, mcpServerId: string, enabled: boolean): Promise<MCPAgentServer> {
    const mounted = await this.#options.mcp.attachServer(scope.accountId, scope.agentId, mcpServerId, enabled);
    this.#audit(scope, "agent_self.mcp_attached", { mcpServerId, enabled });
    return mounted;
  }

  async updateMcpBinding(
    scope: AgentSelfScope,
    mcpServerId: string,
    input: UpdateSelfMCPBindingRequest,
  ): Promise<MCPAgentServer> {
    const mounted = await this.#options.mcp.updateBinding(scope.accountId, scope.agentId, mcpServerId, {
      enabled: input.enabled,
    });
    this.#audit(scope, "agent_self.mcp_binding_updated", { mcpServerId, enabled: input.enabled });
    return mounted;
  }

  async detachMcpServer(scope: AgentSelfScope, mcpServerId: string): Promise<void> {
    await this.#options.mcp.detachServer(scope.accountId, scope.agentId, mcpServerId);
    this.#audit(scope, "agent_self.mcp_detached", { mcpServerId });
  }

  async authenticate(proof: string): Promise<AgentSelfScope> {
    const source = await this.#options.proofs.authenticate(proof);
    const accountId = await this.#options.owners.resolveAccountId(source.agentId);
    this.#options.logger?.debug(
      { agentId: source.agentId, sessionId: source.sessionId },
      "agent self-configuration request authenticated",
    );
    return { accountId, agentId: source.agentId, sessionId: source.sessionId };
  }

  #audit(scope: AgentSelfScope, event: string, details: Record<string, unknown>): void {
    this.#options.logger?.info({ event, agentId: scope.agentId, sessionId: scope.sessionId, ...details }, event);
  }
}
