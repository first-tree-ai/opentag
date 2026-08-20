import {
  type AgentAdminConfig,
  type AgentDetail,
  type AgentRuntimeConfig,
  AgentRuntimeConfigSchema,
  type AgentSummary,
  type CreateAgentRequest,
  CreateAgentRequestSchema,
  type CreateAgentRuntimeConfig,
  hasRequiredFeishuTenantScopes,
  type ListAgentsResponse,
  type UpdateAgentRequest,
  UpdateAgentRequestSchema,
} from "@opentag/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agentRuntimeConfigs, agents, computers, imBindings, memberships, users } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
import { resolveAgentRuntimeConfig } from "../runtime-config/index.js";
import { TeamMembershipService } from "../teams/index.js";
import { AgentServiceError, resourceNotFound } from "./errors.js";

type AgentRow = typeof agents.$inferSelect;
type AgentRuntimeConfigRow = typeof agentRuntimeConfigs.$inferSelect;
type QueryExecutor = Pick<DatabaseClient, "select">;

interface AgentScope {
  agent: AgentRow;
  canManage: boolean;
}

interface AgentSafeRow {
  id: string;
  teamId: string;
  managerUserId: string;
  managerDisplayName: string;
  computerId: string;
  computerDisplayName: string;
  computerPlatform: "darwin" | "linux" | "win32";
  name: string;
  displayName: string;
  runtimeProvider: "codex" | "claude-code";
  receiveMode: "all_message" | "mention_only";
  createdAt: Date;
  updatedAt: Date;
}

function toRuntimeConfig(row: AgentRuntimeConfigRow): AgentRuntimeConfig {
  return AgentRuntimeConfigSchema.parse({
    revision: row.revision,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    instructions: row.instructions,
    allowedTools: row.allowedTools,
    maxDurationMs: row.maxDurationMs,
  });
}

function toAgentAdminConfig(row: AgentRow, runtimeConfig: AgentRuntimeConfigRow): AgentAdminConfig {
  return {
    id: row.id,
    teamId: row.teamId,
    managerUserId: row.managerUserId,
    computerId: row.computerId,
    name: row.name,
    displayName: row.displayName,
    runtimeProvider: row.runtimeProvider,
    receiveMode: row.receiveMode,
    revision: row.revision,
    runtimeConfig: toRuntimeConfig(runtimeConfig),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAgentSummary(row: AgentSafeRow): AgentSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    manager: { userId: row.managerUserId, displayName: row.managerDisplayName },
    computer: {
      id: row.computerId,
      displayName: row.computerDisplayName,
      platform: row.computerPlatform,
    },
    name: row.name,
    displayName: row.displayName,
    runtimeProvider: row.runtimeProvider,
    receiveMode: row.receiveMode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function runtimeConfigsEqual(
  left: AgentRuntimeConfigRow,
  right: Readonly<Required<CreateAgentRuntimeConfig>>,
): boolean {
  return (
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.instructions === right.instructions &&
    left.maxDurationMs === right.maxDurationMs &&
    left.allowedTools.length === right.allowedTools.length &&
    left.allowedTools.every((toolId, index) => toolId === right.allowedTools[index])
  );
}

function isAgentNameConflict(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      current.constraint_name === "agents_team_name_active_unique"
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export class AgentService {
  readonly #afterMembershipLocked?: () => Promise<void>;
  readonly #database: DatabaseClient;
  readonly #membershipService: TeamMembershipService;
  readonly #now: () => Date;

  constructor(
    database: DatabaseClient,
    options: {
      afterMembershipLocked?: () => Promise<void>;
      membershipService?: TeamMembershipService;
      now?: () => Date;
    } = {},
  ) {
    this.#afterMembershipLocked = options.afterMembershipLocked;
    this.#database = database;
    this.#membershipService = options.membershipService ?? new TeamMembershipService(database, { now: options.now });
    this.#now = options.now ?? (() => new Date());
  }

  async createForTeam(callerUserId: string, teamId: string, rawInput: CreateAgentRequest): Promise<AgentAdminConfig> {
    const input = CreateAgentRequestSchema.parse(rawInput);
    const runtimeConfig = resolveAgentRuntimeConfig(input.runtimeConfig);
    try {
      return await this.#database.transaction(async (transaction) => {
        await this.#requireTeamMembershipForMutation(transaction, callerUserId, teamId, "admin");
        await this.#afterMembershipLocked?.();
        const [computer] = await transaction
          .select({ id: computers.id })
          .from(computers)
          .where(and(eq(computers.id, input.computerId), eq(computers.ownerUserId, callerUserId)))
          .limit(1);
        if (!computer) {
          throw new AgentServiceError(
            "COMPUTER_NOT_FOUND",
            "deterministic",
            "The requested Computer was not found",
            404,
          );
        }

        const now = this.#now();
        const [created] = await transaction
          .insert(agents)
          .values({
            teamId,
            managerUserId: callerUserId,
            computerId: input.computerId,
            name: input.name,
            displayName: input.displayName,
            runtimeProvider: input.runtimeProvider,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!created) throw new Error("Agent insert did not return a row");
        const [createdRuntimeConfig] = await transaction
          .insert(agentRuntimeConfigs)
          .values({ agentId: created.id, ...runtimeConfig, createdAt: now, updatedAt: now })
          .returning();
        if (!createdRuntimeConfig) throw new Error("Agent runtime config insert did not return a row");
        return toAgentAdminConfig(created, createdRuntimeConfig);
      });
    } catch (error) {
      if (isAgentNameConflict(error)) {
        throw new AgentServiceError(
          "AGENT_NAME_CONFLICT",
          "deterministic",
          "An active Agent with this name already exists in the Team",
          409,
        );
      }
      throw error;
    }
  }

  async listForTeam(callerUserId: string, teamId: string): Promise<ListAgentsResponse> {
    const manager = alias(users, "agent_manager");
    const rows = await this.#database
      .select({
        id: agents.id,
        teamId: agents.teamId,
        managerUserId: agents.managerUserId,
        managerDisplayName: manager.displayName,
        computerId: agents.computerId,
        computerDisplayName: computers.displayName,
        computerPlatform: computers.platform,
        name: agents.name,
        displayName: agents.displayName,
        runtimeProvider: agents.runtimeProvider,
        receiveMode: agents.receiveMode,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(agents, and(eq(agents.teamId, memberships.teamId), isNull(agents.deletedAt)))
      .leftJoin(manager, eq(manager.id, agents.managerUserId))
      .leftJoin(computers, eq(computers.id, agents.computerId))
      .where(
        and(
          eq(memberships.teamId, teamId),
          eq(memberships.userId, callerUserId),
          eq(memberships.status, "active"),
          isNull(users.suspendedAt),
        ),
      )
      .orderBy(asc(agents.name), asc(agents.id));
    if (rows.length === 0) throw resourceNotFound();
    return {
      agents: rows.flatMap((row) => {
        if (!row.id) return [];
        if (!row.managerDisplayName || !row.computerId || !row.computerDisplayName || !row.computerPlatform) {
          throw new Error("Active Agent is missing its manager or Computer");
        }
        return [toAgentSummary(row as AgentSafeRow)];
      }),
    };
  }

  async getById(callerUserId: string, agentId: string): Promise<AgentDetail> {
    const manager = alias(users, "agent_manager");
    const [row] = await this.#database
      .select({
        id: agents.id,
        teamId: agents.teamId,
        managerUserId: agents.managerUserId,
        managerDisplayName: manager.displayName,
        computerId: agents.computerId,
        computerDisplayName: computers.displayName,
        computerPlatform: computers.platform,
        name: agents.name,
        displayName: agents.displayName,
        runtimeProvider: agents.runtimeProvider,
        receiveMode: agents.receiveMode,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .innerJoin(manager, eq(manager.id, agents.managerUserId))
      .innerJoin(computers, eq(computers.id, agents.computerId))
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1);
    if (!row) throw resourceNotFound();
    const role = await this.#requireTeamMembership(this.#database, callerUserId, row.teamId);
    return { ...toAgentSummary(row), viewerCapabilities: { canManage: role === "admin" } };
  }

  async getConfigById(callerUserId: string, agentId: string): Promise<AgentAdminConfig> {
    const scope = await this.#resolveAgentDetailScope(this.#database, callerUserId, agentId);
    this.#requireManagePermission(scope);
    return toAgentAdminConfig(scope.agent, scope.runtimeConfig);
  }

  async updateById(callerUserId: string, agentId: string, rawInput: UpdateAgentRequest): Promise<AgentAdminConfig> {
    const input = UpdateAgentRequestSchema.parse(rawInput);
    return this.#database.transaction(async (transaction) => {
      const scope = await this.#lockAgentScopeForMutation(transaction, callerUserId, agentId, false);
      this.#requireManagePermission(scope);
      if (scope.agent.revision !== input.expectedRevision) {
        throw new AgentServiceError(
          "AGENT_REVISION_CONFLICT",
          "deterministic",
          "The Agent changed since it was read",
          409,
        );
      }
      if (input.receiveMode === "all_message") {
        const [imBinding] = await transaction
          .select({ provider: imBindings.provider, capabilities: imBindings.grantedCapabilities })
          .from(imBindings)
          .where(and(eq(imBindings.agentId, agentId), isNull(imBindings.disabledAt)))
          .limit(1);
        const missingRequiredCapabilities =
          imBinding?.provider === "feishu"
            ? !hasRequiredFeishuTenantScopes(imBinding.capabilities)
            : imBinding?.provider === "slack"
              ? ["channels:history", "groups:history", "mpim:history"].some(
                  (capability) => !imBinding.capabilities.includes(capability),
                )
              : false;
        if (imBinding && missingRequiredCapabilities) {
          throw new AgentServiceError(
            "IM_BINDING_SCOPE_REAUTH_REQUIRED",
            "deterministic",
            "The IM binding must be reauthorized before enabling all-message receive mode",
            409,
          );
        }
      }
      const currentRuntimeConfig = await this.#lockRuntimeConfig(transaction, agentId);
      const currentRuntimeProjection = toRuntimeConfig(currentRuntimeConfig);
      const nextRuntimeConfig = resolveAgentRuntimeConfig({
        model: input.runtimeConfig?.model !== undefined ? input.runtimeConfig.model : currentRuntimeProjection.model,
        reasoningEffort:
          input.runtimeConfig?.reasoningEffort !== undefined
            ? input.runtimeConfig.reasoningEffort
            : currentRuntimeProjection.reasoningEffort,
        instructions: input.runtimeConfig?.instructions ?? currentRuntimeProjection.instructions,
        allowedTools: input.runtimeConfig?.allowedTools ?? currentRuntimeProjection.allowedTools,
        maxDurationMs:
          input.runtimeConfig?.maxDurationMs !== undefined
            ? input.runtimeConfig.maxDurationMs
            : currentRuntimeProjection.maxDurationMs,
      });
      const runtimeConfigChanged = !runtimeConfigsEqual(currentRuntimeConfig, nextRuntimeConfig);
      const now = this.#now();
      const [updated] = await transaction
        .update(agents)
        .set({
          displayName: input.displayName ?? scope.agent.displayName,
          receiveMode: input.receiveMode ?? scope.agent.receiveMode,
          revision: sql`${agents.revision} + 1`,
          updatedAt: now,
        })
        .where(and(eq(agents.id, agentId), isNull(agents.deletedAt), eq(agents.revision, input.expectedRevision)))
        .returning();
      if (updated) {
        let runtimeConfig = currentRuntimeConfig;
        if (runtimeConfigChanged) {
          const [updatedRuntimeConfig] = await transaction
            .update(agentRuntimeConfigs)
            .set({ ...nextRuntimeConfig, revision: sql`nextval('runtime_config_revision_sequence')`, updatedAt: now })
            .where(eq(agentRuntimeConfigs.agentId, agentId))
            .returning();
          if (!updatedRuntimeConfig) throw new Error("Agent runtime config update did not return a row");
          runtimeConfig = updatedRuntimeConfig;
        }
        return toAgentAdminConfig(updated, runtimeConfig);
      }

      const current = await this.#resolveAgentScope(transaction, callerUserId, agentId, false);
      this.#requireManagePermission(current);
      throw new AgentServiceError(
        "AGENT_REVISION_CONFLICT",
        "deterministic",
        "The Agent changed since it was read",
        409,
      );
    });
  }

  async deleteById(callerUserId: string, agentId: string): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const scope = await this.#lockAgentScopeForMutation(transaction, callerUserId, agentId, true);
      if (scope.agent.deletedAt) {
        if (scope.canManage) return;
        throw resourceNotFound();
      }
      this.#requireManagePermission(scope);

      const now = this.#now();
      await transaction
        .update(agents)
        .set({ deletedAt: now, updatedAt: now, revision: sql`${agents.revision} + 1` })
        .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)));
    });
  }

  async #lockAgentScopeForMutation(
    transaction: DatabaseTransaction,
    callerUserId: string,
    agentId: string,
    includeDeleted: boolean,
  ): Promise<AgentScope> {
    const [candidate] = await transaction
      .select({ teamId: agents.teamId })
      .from(agents)
      .where(and(eq(agents.id, agentId), ...(includeDeleted ? [] : [isNull(agents.deletedAt)])))
      .limit(1);
    if (!candidate) throw resourceNotFound();
    const role = await this.#requireTeamMembershipForMutation(transaction, callerUserId, candidate.teamId);
    const [agent] = await transaction
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), ...(includeDeleted ? [] : [isNull(agents.deletedAt)])))
      .limit(1)
      .for("update");
    if (!agent) throw resourceNotFound();
    return { agent, canManage: role === "admin" };
  }

  async #lockRuntimeConfig(transaction: DatabaseTransaction, agentId: string): Promise<AgentRuntimeConfigRow> {
    const [runtimeConfig] = await transaction
      .select()
      .from(agentRuntimeConfigs)
      .where(eq(agentRuntimeConfigs.agentId, agentId))
      .limit(1)
      .for("update");
    if (!runtimeConfig) throw new Error("Active Agent is missing its runtime config");
    return runtimeConfig;
  }

  async #requireTeamMembership(
    executor: QueryExecutor,
    callerUserId: string,
    teamId: string,
  ): Promise<"admin" | "member"> {
    const [membership] = await executor
      .select({ role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.teamId, teamId),
          eq(memberships.userId, callerUserId),
          eq(memberships.status, "active"),
          isNull(users.suspendedAt),
        ),
      )
      .limit(1);
    if (!membership) throw resourceNotFound();
    return membership.role;
  }

  async #requireTeamMembershipForMutation(
    transaction: DatabaseTransaction,
    callerUserId: string,
    teamId: string,
    requiredRole?: "admin",
  ): Promise<"admin" | "member"> {
    try {
      return await this.#membershipService.requireActiveMembershipForMutation(
        transaction,
        callerUserId,
        teamId,
        requiredRole,
      );
    } catch (error) {
      if (error instanceof AuthServiceError && error.statusCode === 404) throw resourceNotFound();
      throw error;
    }
  }

  async #resolveAgentScope(
    executor: QueryExecutor,
    callerUserId: string,
    agentId: string,
    includeDeleted: boolean,
  ): Promise<AgentScope> {
    const [agent] = await executor
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), ...(includeDeleted ? [] : [isNull(agents.deletedAt)])))
      .limit(1);
    if (!agent) throw resourceNotFound();
    const role = await this.#requireTeamMembership(executor, callerUserId, agent.teamId);
    return { agent, canManage: role === "admin" };
  }

  async #resolveAgentDetailScope(
    executor: QueryExecutor,
    callerUserId: string,
    agentId: string,
  ): Promise<AgentScope & { runtimeConfig: AgentRuntimeConfigRow }> {
    const [row] = await executor
      .select({ agent: agents, runtimeConfig: agentRuntimeConfigs })
      .from(agents)
      .innerJoin(agentRuntimeConfigs, eq(agentRuntimeConfigs.agentId, agents.id))
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1);
    if (!row) throw resourceNotFound();
    const role = await this.#requireTeamMembership(executor, callerUserId, row.agent.teamId);
    return {
      agent: row.agent,
      runtimeConfig: row.runtimeConfig,
      canManage: role === "admin",
    };
  }

  #requireManagePermission(scope: AgentScope): void {
    if (!scope.canManage) {
      throw new AgentServiceError("AGENT_FORBIDDEN", "deterministic", "The caller cannot manage this Agent", 403);
    }
  }
}
