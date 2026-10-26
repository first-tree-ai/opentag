import {
  type AgentAdminConfig,
  type CreateSelfMCPServerRequest,
  MCP_ERROR_CODES,
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
import { generateSecret } from "../auth/security.js";
import {
  type McpAuthorizationService,
  type McpOAuthFlowService,
  type McpServerService,
  McpServiceError,
} from "../mcp/index.js";
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
  flows: Pick<McpOAuthFlowService, "start">;
  logger?: ServiceLogger;
  mcp: Pick<
    McpServerService,
    | "attachServer"
    | "createServer"
    | "deleteServer"
    | "detachServer"
    | "listAgentServers"
    | "listAvailableServers"
    | "readAgentServer"
    | "updateBinding"
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
   * Register a definition and mount it on this Agent.
   *
   * The definition is written first because a mount needs one, so a failed mount must not leave the
   * definition behind: an orphan in the Account pool that no Agent mounts would show up in every
   * Agent's "available" list and would block the name on the next attempt. The compensating delete is
   * best effort — the original mount error is the one worth reporting.
   */
  async createMcpServer(scope: AgentSelfScope, input: CreateSelfMCPServerRequest): Promise<MCPAgentServer> {
    const created = await this.#options.mcp.createServer(scope.accountId, {
      name: input.name,
      url: input.url,
      defaultAuthKind: input.defaultAuthKind,
    });
    try {
      await this.#options.mcp.attachServer(scope.accountId, scope.agentId, created.id, true, "agent-self");
    } catch (error) {
      await this.#options.mcp.deleteServer(scope.accountId, created.id).catch(() => undefined);
      throw error;
    }
    if (input.apiKey !== undefined) {
      await this.#options.authorization.setBearerOrNone(scope.accountId, scope.agentId, created.id, {
        kind: "bearer",
        bearerKey: input.apiKey,
      });
      // Synchronous so `add --api-key` reports the tool catalogue it just earned, rather than an
      // object that is still `pending` and needs a second command to interpret.
      await this.#options.authorization.probe(scope.accountId, scope.agentId, created.id);
    }
    this.#audit(scope, "agent_self.mcp_server_created", {
      mcpServerId: created.id,
      defaultAuthKind: created.defaultAuthKind,
      credentialWritten: input.apiKey !== undefined,
    });
    return this.#options.mcp.readAgentServer(scope.accountId, scope.agentId, created.id);
  }

  /**
   * Unmount, then drop the definition when nothing else mounts it.
   *
   * `SERVER_IN_USE` is the expected answer when another Agent of the Account still mounts the
   * definition: the unmount succeeded, and the shared definition must stay for that other Agent.
   */
  async deleteMcpServer(scope: AgentSelfScope, mcpServerId: string): Promise<{ definitionRemoved: boolean }> {
    await this.#options.mcp.detachServer(scope.accountId, scope.agentId, mcpServerId);
    let definitionRemoved = true;
    try {
      await this.#options.mcp.deleteServer(scope.accountId, mcpServerId);
    } catch (error) {
      if (!(error instanceof McpServiceError) || error.code !== MCP_ERROR_CODES.SERVER_IN_USE) throw error;
      definitionRemoved = false;
    }
    this.#audit(scope, "agent_self.mcp_server_deleted", { mcpServerId, definitionRemoved });
    return { definitionRemoved };
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

  /** Write this Agent's own Bearer key, then probe so the caller learns whether it works. */
  async setMcpBearerKey(scope: AgentSelfScope, mcpServerId: string, apiKey: string): Promise<MCPAgentServer> {
    await this.#options.authorization.setBearerOrNone(scope.accountId, scope.agentId, mcpServerId, {
      kind: "bearer",
      bearerKey: apiKey,
    });
    await this.#options.authorization.probe(scope.accountId, scope.agentId, mcpServerId);
    // The key itself is never logged, not even masked.
    this.#audit(scope, "agent_self.mcp_credential_written", { mcpServerId, kind: "bearer" });
    return this.#options.mcp.readAgentServer(scope.accountId, scope.agentId, mcpServerId);
  }

  /**
   * Begin an OAuth flow for a Server this Agent mounts.
   *
   * The flow secret is minted here and nowhere else: the Agent surface has no browser, so it cannot
   * be handed a cookie the way the Account surface's start route does. It exists so the flow row is
   * bound to a single start rather than left with a null binding.
   *
   * `shortcut:` the browser that completes this flow does not hold the flow secret cookie, so the
   * callback's browser binding is not satisfied by an Agent-started flow; the state is still single
   * use, hashed, and short lived. Upgrade by having the returned URL pass through a same-origin
   * handoff that sets the cookie before redirecting to the provider.
   */
  async startMcpOAuth(
    scope: AgentSelfScope,
    mcpServerId: string,
    input: StartMCPOAuthRequest,
  ): Promise<StartMCPOAuthResponse> {
    const started = await this.#options.flows.start(
      scope.accountId,
      scope.agentId,
      mcpServerId,
      input.scopes ?? [],
      generateSecret(32),
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
