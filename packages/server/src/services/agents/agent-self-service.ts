import {
  type AgentAdminConfig,
  type CreateSelfMCPServerRequest,
  type MCPAgentServer,
  type MCPAvailableServer,
  type SelfMCPOAuthStatus,
  type StartMCPOAuthRequest,
  type StartMCPOAuthResponse,
  selfMcpOAuthStatus,
  type UpdateSelfAgentRequest,
  type UpdateSelfMCPBindingRequest,
} from "@opentag/shared";
import { and, eq, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { McpAuthorizationService, McpOAuthFlowService, McpServerService } from "../mcp/index.js";
import type { SessionCliProofService } from "../sessions/session-cli-proof-service.js";
import type { AgentService } from "./agent-service.js";
import { AgentServiceError, resourceNotFound } from "./errors.js";

/**
 * Agent self-configuration, authorized by a Session CLI proof.
 *
 * The proof is the only identity input: it resolves the Agent, and the Agent's owning Account is
 * read from the Agent row, never from the request. Every operation then delegates to the same
 * Account-scoped service the Account surface uses, so ownership checks, revision conflicts, and
 * Cloud model validation apply unchanged. The narrowing of what an Agent may change is enforced by
 * the request schemas in `@opentag/shared` (`agent-self.ts`) and by which service calls exist here.
 *
 * A Server definition this Agent registers is written into the owning Account's pool, because that
 * is where definitions live and where a later human can see, adopt, or delete it. It is never a
 * rename of an existing definition: `mcp_servers` names are unique per Account, so a self-registered
 * name that is already taken fails with `MCP_SERVER_NAME_CONFLICT` instead of shadowing it.
 */

export interface AgentOwnerResolver {
  resolveAccountId(agentId: string): Promise<string>;
  isSelfConfigurationEnabled(agentId: string): Promise<boolean>;
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

  async isSelfConfigurationEnabled(agentId: string): Promise<boolean> {
    const [row] = await this.#database
      .select({ selfConfigurationEnabled: agents.selfConfigurationEnabled })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!row) throw resourceNotFound();
    return row.selfConfigurationEnabled;
  }
}

export interface AgentSelfServiceOptions {
  agents: Pick<AgentService, "getConfigById" | "updateById">;
  authorization: Pick<McpAuthorizationService, "probe" | "setBearerOrNone">;
  flows: Pick<McpOAuthFlowService, "startWithHandoff">;
  logger?: ServiceLogger;
  mcp: Pick<
    McpServerService,
    | "attachServer"
    | "createAndAttachServer"
    | "createServer"
    | "deleteServer"
    | "detachServer"
    | "listAgentServers"
    | "listAvailableServers"
    | "readAgentServer"
    | "readServer"
    | "updateBinding"
  >;
  owners: AgentOwnerResolver;
  proofs: Pick<SessionCliProofService, "authenticate">;
  publicOrigin: string;
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
    const mounted = await this.#options.mcp.attachServer(
      scope.accountId,
      scope.agentId,
      mcpServerId,
      enabled,
      "agent-self",
    );
    this.#audit(scope, "agent_self.mcp_attached", { mcpServerId, enabled });
    return mounted;
  }

  /**
   * Register a definition and mount it on this Agent atomically in a single transaction.
   * Eliminates the window where a failed mount leaves an unattached orphan definition behind.
   */
  async createMcpServer(scope: AgentSelfScope, input: CreateSelfMCPServerRequest): Promise<MCPAgentServer> {
    const created = await this.#options.mcp.createAndAttachServer(
      scope.accountId,
      scope.agentId,
      {
        name: input.name,
        description: "Created by Agent self-service",
        url: input.url,
        defaultAuthKind: input.defaultAuthKind,
      },
      true,
      "agent-self",
    );
    if (input.apiKey !== undefined) {
      await this.#options.authorization.setBearerOrNone(
        scope.accountId,
        scope.agentId,
        created.mcpServerId,
        { kind: "bearer", bearerKey: input.apiKey },
        "agent-self",
      );
      // Synchronous so `add --api-key` reports the tool catalogue it just earned, rather than an
      // object that is still `pending` and needs a second command to interpret.
      await this.#options.authorization.probe(scope.accountId, scope.agentId, created.mcpServerId);
    }
    this.#audit(scope, "agent_self.mcp_server_created", {
      mcpServerId: created.mcpServerId,
      defaultAuthKind: input.defaultAuthKind,
      credentialWritten: input.apiKey !== undefined,
    });
    return this.#options.mcp.readAgentServer(scope.accountId, scope.agentId, created.mcpServerId);
  }

  /**
   * Unmount the MCP Server from this Agent.
   *
   * Under the least-privilege self-service boundary, an Agent can only manage its own mounts.
   * Account-level definitions are preserved across self-service deletion, eliminating provenance
   * heuristics and preventing accidental destruction of shared or human-managed definitions.
   *
   * `agent-self` is passed down so the unmount re-checks the owner's opt-in under the same row lock a
   * human edit takes: an opt-in revoked after the Agent authenticated still refuses the write.
   */
  async deleteMcpServer(scope: AgentSelfScope, mcpServerId: string): Promise<{ definitionRemoved: boolean }> {
    await this.#options.mcp.detachServer(scope.accountId, scope.agentId, mcpServerId, "agent-self");
    this.#audit(scope, "agent_self.mcp_server_deleted", { mcpServerId, definitionRemoved: false });
    return { definitionRemoved: false };
  }

  async updateMcpBinding(
    scope: AgentSelfScope,
    mcpServerId: string,
    input: UpdateSelfMCPBindingRequest,
  ): Promise<MCPAgentServer> {
    const mounted = await this.#options.mcp.updateBinding(
      scope.accountId,
      scope.agentId,
      mcpServerId,
      { enabled: input.enabled },
      "agent-self",
    );
    this.#audit(scope, "agent_self.mcp_binding_updated", { mcpServerId, enabled: input.enabled });
    return mounted;
  }

  async detachMcpServer(scope: AgentSelfScope, mcpServerId: string): Promise<void> {
    await this.#options.mcp.detachServer(scope.accountId, scope.agentId, mcpServerId, "agent-self");
    this.#audit(scope, "agent_self.mcp_detached", { mcpServerId });
  }

  /**
   * Write this Agent's own Bearer key, then probe so the caller learns whether it works.
   *
   * The key is a credential write, so the opt-in is re-checked inside the transaction rather than
   * trusted from the authentication that preceded it: an owner who revokes self-configuration while a
   * request is in flight must not end up with a key written after the revocation.
   */
  async setMcpBearerKey(scope: AgentSelfScope, mcpServerId: string, apiKey: string): Promise<MCPAgentServer> {
    await this.#options.authorization.setBearerOrNone(
      scope.accountId,
      scope.agentId,
      mcpServerId,
      { kind: "bearer", bearerKey: apiKey },
      "agent-self",
    );
    await this.#options.authorization.probe(scope.accountId, scope.agentId, mcpServerId);
    // The key itself is never logged, not even masked.
    this.#audit(scope, "agent_self.mcp_credential_written", { mcpServerId, kind: "bearer" });
    return this.#options.mcp.readAgentServer(scope.accountId, scope.agentId, mcpServerId);
  }

  /**
   * Begin an OAuth flow for a Server this Agent mounts, returning a same-origin handoff URL.
   *
   * The URL routes through the same-origin handoff endpoint, so the browser receives the
   * `mcpOAuthContext` cookie and is redirected to the provider with PKCE, state, and cookie binding
   * intact. The handoff itself is session- and owner-checked and single use; the Agent can produce the
   * link, but only the Account that owns it can complete the flow.
   *
   * `startWithHandoff` defaults to `agent-self`, which is what re-checks the opt-in under the row lock.
   */
  async startMcpOAuth(
    scope: AgentSelfScope,
    mcpServerId: string,
    input: StartMCPOAuthRequest,
  ): Promise<StartMCPOAuthResponse> {
    const started = await this.#options.flows.startWithHandoff(
      scope.accountId,
      scope.agentId,
      mcpServerId,
      input.scopes ?? [],
      this.#options.publicOrigin,
      "agent-self",
    );
    this.#audit(scope, "agent_self.mcp_oauth_started", {
      mcpServerId,
      scopes: input.scopes?.length ?? 0,
    });
    return { authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt.toISOString() };
  }

  async getMcpOAuthStatus(scope: AgentSelfScope, mcpServerId: string): Promise<SelfMCPOAuthStatus> {
    return selfMcpOAuthStatus(await this.#options.mcp.readAgentServer(scope.accountId, scope.agentId, mcpServerId));
  }

  async authenticate(proof: string): Promise<AgentSelfScope> {
    const source = await this.#options.proofs.authenticate(proof);
    const accountId = await this.#options.owners.resolveAccountId(source.agentId);
    if (!(await this.#options.owners.isSelfConfigurationEnabled(source.agentId))) {
      this.#options.logger?.debug(
        { agentId: source.agentId, sessionId: source.sessionId, code: "AGENT_SELF_CONFIGURATION_DISABLED" },
        "agent self-configuration is disabled by the Agent owner",
      );
      throw new AgentServiceError(
        "AGENT_SELF_CONFIGURATION_DISABLED",
        "deterministic",
        "Agent self-configuration is disabled by the Agent owner",
        403,
      );
    }
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
