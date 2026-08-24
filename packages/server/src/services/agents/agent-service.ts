import { createHash } from "node:crypto";
import {
  AGENT_USAGE_WINDOW_DAYS,
  type AgentAdminConfig,
  type AgentDetail,
  type AgentListItem,
  type AgentRuntimeConfig,
  AgentRuntimeConfigSchema,
  type AgentRuntimeProvider,
  type AgentSummary,
  type CreateAgentRequest,
  CreateAgentRequestSchema,
  type CreateAgentRuntimeConfig,
  hasRequiredFeishuTenantScopes,
  type ListAgentsResponse,
  runtimeUsageTotalTokens,
  type UpdateAgentRequest,
  UpdateAgentRequestSchema,
} from "@opentag/shared";
import { and, asc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  memberships,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
import { disableImBindingInTransaction } from "../im-bindings/index.js";
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
  status: AgentRow["status"];
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentSessionStopTarget {
  agentId: string;
  computerId: string;
  placementGeneration: number;
  sessionId: string;
}

function toRuntimeConfig(row: AgentRuntimeConfigRow): AgentRuntimeConfig {
  return AgentRuntimeConfigSchema.parse({
    revision: row.revision,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    instructions: row.instructions,
    maxDurationMs: row.maxDurationMs,
  });
}

function toAgentAdminConfig(row: AgentRow, runtimeConfig: AgentRuntimeConfigRow): AgentAdminConfig {
  if (row.status === "deleted") throw new Error("Deleted Agent cannot be projected as an admin config");
  return {
    id: row.id,
    teamId: row.teamId,
    managerUserId: row.managerUserId,
    computerId: row.computerId,
    name: row.name,
    displayName: row.displayName,
    runtimeProvider: row.runtimeProvider,
    receiveMode: row.receiveMode,
    status: row.status,
    revision: row.revision,
    runtimeConfig: toRuntimeConfig(runtimeConfig),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAgentSummary(row: AgentSafeRow): AgentSummary {
  if (row.status === "deleted") throw new Error("Deleted Agent cannot be projected as a summary");
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
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function deliveryTokenCount(
  provider: AgentRuntimeProvider,
  inputTokens: string | null,
  cachedInputTokens: string | null,
  outputTokens: string | null,
): number {
  const parse = (value: string | null): number | undefined => {
    if (value === null) return undefined;
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new Error("Agent usage contains an invalid token count");
    }
    return result;
  };
  return runtimeUsageTotalTokens(provider, {
    inputTokens: parse(inputTokens),
    cachedInputTokens: parse(cachedInputTokens),
    outputTokens: parse(outputTokens),
  });
}

function runtimeConfigsEqual(
  left: AgentRuntimeConfigRow,
  right: Readonly<Required<CreateAgentRuntimeConfig>>,
): boolean {
  return (
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.instructions === right.instructions &&
    left.maxDurationMs === right.maxDurationMs
  );
}

function creationIntentFingerprint(input: CreateAgentRequest): string {
  const runtimeConfig = input.runtimeConfig;
  const explicitRuntimeConfig =
    runtimeConfig && Object.values(runtimeConfig).some((value) => value !== undefined)
      ? {
          instructions: runtimeConfig.instructions,
          maxDurationMs: runtimeConfig.maxDurationMs,
          model: runtimeConfig.model,
          reasoningEffort: runtimeConfig.reasoningEffort,
        }
      : undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        computerId: input.computerId,
        displayName: input.displayName,
        name: input.name,
        runtimeConfig: explicitRuntimeConfig,
        runtimeProvider: input.runtimeProvider,
      }),
    )
    .digest("hex");
}

function uniqueConstraintName(error: unknown): string | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if ("code" in current && current.code === "23505" && "constraint_name" in current) {
      return typeof current.constraint_name === "string" ? current.constraint_name : undefined;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

export class AgentService {
  readonly #afterAgentLocked?: () => Promise<void>;
  readonly #afterMembershipLocked?: () => Promise<void>;
  readonly #database: DatabaseClient;
  readonly #membershipService: TeamMembershipService;
  readonly #now: () => Date;
  readonly #onDiagnostic: (code: string) => void;
  readonly #stopSessions: (targets: AgentSessionStopTarget[]) => Promise<void>;

  constructor(
    database: DatabaseClient,
    options: {
      afterAgentLocked?: () => Promise<void>;
      afterMembershipLocked?: () => Promise<void>;
      membershipService?: TeamMembershipService;
      now?: () => Date;
      onDiagnostic?: (code: string) => void;
      stopSessions?: (targets: AgentSessionStopTarget[]) => Promise<void>;
    } = {},
  ) {
    this.#afterAgentLocked = options.afterAgentLocked;
    this.#afterMembershipLocked = options.afterMembershipLocked;
    this.#database = database;
    this.#membershipService = options.membershipService ?? new TeamMembershipService(database, { now: options.now });
    this.#now = options.now ?? (() => new Date());
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#stopSessions = options.stopSessions ?? (async () => undefined);
  }

  async createForTeam(callerUserId: string, teamId: string, rawInput: CreateAgentRequest): Promise<AgentAdminConfig> {
    const input = CreateAgentRequestSchema.parse(rawInput);
    const runtimeConfig = resolveAgentRuntimeConfig(input.runtimeConfig);
    const intentFingerprint = input.creationIntentId ? creationIntentFingerprint(input) : undefined;
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
            creationIntentId: input.creationIntentId,
            creationIntentFingerprint: intentFingerprint,
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
      const constraintName = uniqueConstraintName(error);
      if (constraintName && input.creationIntentId) {
        const replay = await this.#replayCreationIntent(
          callerUserId,
          teamId,
          input.creationIntentId,
          creationIntentFingerprint(input),
        );
        if (replay) return replay;
      }
      if (constraintName === "agents_team_name_active_unique") {
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

  async #replayCreationIntent(
    callerUserId: string,
    teamId: string,
    creationIntentId: string,
    intentFingerprint: string,
  ): Promise<AgentAdminConfig | undefined> {
    return this.#database.transaction(async (transaction) => {
      await this.#requireTeamMembershipForMutation(transaction, callerUserId, teamId, "admin");
      const [row] = await transaction
        .select({ agent: agents, runtimeConfig: agentRuntimeConfigs })
        .from(agents)
        .leftJoin(agentRuntimeConfigs, eq(agentRuntimeConfigs.agentId, agents.id))
        .where(
          and(
            eq(agents.teamId, teamId),
            eq(agents.managerUserId, callerUserId),
            eq(agents.creationIntentId, creationIntentId),
          ),
        )
        .limit(1);
      if (!row) return undefined;
      if (
        row.agent.status === "deleted" ||
        row.runtimeConfig === null ||
        row.agent.creationIntentFingerprint !== intentFingerprint
      ) {
        throw new AgentServiceError(
          "AGENT_CREATION_INTENT_CONFLICT",
          "deterministic",
          "This Agent creation intent was already used for a different request",
          409,
        );
      }
      return toAgentAdminConfig(row.agent, row.runtimeConfig);
    });
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
        status: agents.status,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(agents, and(eq(agents.teamId, memberships.teamId), ne(agents.status, "deleted")))
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
    const summaries = rows.flatMap((row) => {
      if (!row.id) return [];
      if (!row.managerDisplayName || !row.computerId || !row.computerDisplayName || !row.computerPlatform) {
        throw new Error("Active Agent is missing its manager or Computer");
      }
      return [toAgentSummary(row as AgentSafeRow)];
    });
    if (summaries.length === 0) return { agents: [] };

    const now = this.#now();
    const usageStartedAt = new Date(now.getTime() - AGENT_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1_000);
    const activityRows = await this.#database
      .select({
        acceptedAt: imMessageDeliveries.acceptedAt,
        agentId: imBindings.agentId,
        cachedInputTokens: sql<string | null>`${imMessageDeliveries.turnReport} #>> '{usage,cachedInputTokens}'`,
        inputTokens: sql<string | null>`${imMessageDeliveries.turnReport} #>> '{usage,inputTokens}'`,
        outcome: sql<string | null>`${imMessageDeliveries.turnReport} ->> 'outcome'`,
        outputTokens: sql<string | null>`${imMessageDeliveries.turnReport} #>> '{usage,outputTokens}'`,
        reportedAt: imMessageDeliveries.reportedAt,
        bindingStatus: imBindings.status,
        sessionEndedAt: sessions.endedAt,
        state: imMessageDeliveries.state,
      })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .where(
        and(
          inArray(
            imBindings.agentId,
            summaries.map((agent) => agent.id),
          ),
          or(
            and(eq(imMessageDeliveries.state, "accepted"), isNull(imMessageDeliveries.reportedAt)),
            gte(imMessageDeliveries.acceptedAt, usageStartedAt),
          ),
        ),
      );

    const usageByAgent = new Map<string, { failed: number; tasks: number; tokens: number }>();
    const workingByAgent = new Map<string, Date>();
    const runtimeProviderByAgent = new Map(summaries.map((agent) => [agent.id, agent.runtimeProvider]));
    for (const row of activityRows) {
      if (
        row.state === "accepted" &&
        row.reportedAt === null &&
        row.acceptedAt &&
        row.bindingStatus === "active" &&
        row.sessionEndedAt === null
      ) {
        const currentStartedAt = workingByAgent.get(row.agentId);
        if (!currentStartedAt || row.acceptedAt > currentStartedAt) workingByAgent.set(row.agentId, row.acceptedAt);
      }
      if (!row.acceptedAt || row.acceptedAt < usageStartedAt) continue;
      const usage = usageByAgent.get(row.agentId) ?? { failed: 0, tasks: 0, tokens: 0 };
      usage.tasks += 1;
      if (row.outcome === "failed") usage.failed += 1;
      const runtimeProvider = runtimeProviderByAgent.get(row.agentId);
      if (!runtimeProvider) throw new Error("Agent usage is missing its runtime Provider");
      usage.tokens += deliveryTokenCount(runtimeProvider, row.inputTokens, row.cachedInputTokens, row.outputTokens);
      if (!Number.isSafeInteger(usage.tokens))
        throw new Error("Agent usage token total exceeds the safe integer range");
      usageByAgent.set(row.agentId, usage);
    }

    return {
      agents: summaries.map((agent): AgentListItem => {
        const usage = usageByAgent.get(agent.id) ?? { failed: 0, tasks: 0, tokens: 0 };
        const currentWorkStartedAt = workingByAgent.get(agent.id);
        return {
          ...agent,
          activity: currentWorkStartedAt
            ? {
                state: "working",
                startedAt: currentWorkStartedAt.toISOString(),
              }
            : { state: "idle" },
          usage: { windowDays: AGENT_USAGE_WINDOW_DAYS, ...usage },
        };
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
        status: agents.status,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .innerJoin(manager, eq(manager.id, agents.managerUserId))
      .innerJoin(computers, eq(computers.id, agents.computerId))
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
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
    const result = await this.#database.transaction(async (transaction) => {
      const scope = await this.#lockAgentScopeForMutation(transaction, callerUserId, agentId);
      this.#requireManagePermission(scope);
      if (scope.agent.revision !== input.expectedRevision) {
        throw new AgentServiceError(
          "AGENT_REVISION_CONFLICT",
          "deterministic",
          "The Agent changed since it was read",
          409,
        );
      }
      const now = this.#now();
      if (input.receiveMode !== undefined) {
        const [imBinding] = await transaction
          .select({
            id: imBindings.id,
            provider: imBindings.provider,
            status: imBindings.status,
            lastErrorCode: imBindings.lastErrorCode,
            setupState: imBindings.setupState,
            pendingReceiveMode: imBindings.pendingReceiveMode,
            credentialGeneration: imBindings.credentialGeneration,
            capabilities: imBindings.grantedCapabilities,
          })
          .from(imBindings)
          .where(and(eq(imBindings.agentId, agentId), isNull(imBindings.disabledAt)))
          .limit(1)
          .for("update");
        if (
          input.receiveMode !== scope.agent.receiveMode &&
          input.receiveMode === "all_message" &&
          imBinding?.provider === "feishu"
        ) {
          const missingRequiredCapabilities = !hasRequiredFeishuTenantScopes(imBinding.capabilities);
          if (missingRequiredCapabilities) {
            throw new AgentServiceError(
              "IM_BINDING_SCOPE_REAUTH_REQUIRED",
              "deterministic",
              "The IM binding must be reauthorized before enabling all-message receive mode",
              409,
            );
          }
        }
        if (imBinding?.provider === "slack") {
          const missingHistoryCapabilities = ["channels:history", "groups:history", "mpim:history"].some(
            (capability) => !imBinding.capabilities.includes(capability),
          );
          const scopeUpgradeRequired =
            input.receiveMode !== scope.agent.receiveMode &&
            input.receiveMode === "all_message" &&
            missingHistoryCapabilities &&
            imBinding.credentialGeneration >= 1;
          // Compare against the effective target so a no-op receive-mode save never cancels setup.
          const targetChanged = (imBinding.pendingReceiveMode ?? scope.agent.receiveMode) !== input.receiveMode;
          const cancelActiveSetup =
            targetChanged && (imBinding.setupState === "awaiting_user" || imBinding.setupState === "validating");
          await transaction
            .update(imBindings)
            .set({
              pendingReceiveMode: scopeUpgradeRequired ? input.receiveMode : null,
              lastErrorCode: scopeUpgradeRequired
                ? imBinding.status === "active"
                  ? "IM_BINDING_SCOPE_REAUTH_REQUIRED"
                  : imBinding.lastErrorCode
                : cancelActiveSetup
                  ? "SLACK_SETUP_CANCELED"
                  : imBinding.lastErrorCode === "IM_BINDING_SCOPE_REAUTH_REQUIRED"
                    ? null
                    : imBinding.lastErrorCode,
              ...(cancelActiveSetup
                ? {
                    setupState: "canceled" as const,
                    setupOwnerInstanceId: null,
                    setupOwnerHeartbeatAt: null,
                    encryptedSetupContext: null,
                    setupExpiresAt: null,
                  }
                : {}),
              updatedAt: now,
            })
            .where(eq(imBindings.id, imBinding.id));
          if (scopeUpgradeRequired) return { scopeReauthorizationRequired: true as const };
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
        maxDurationMs:
          input.runtimeConfig?.maxDurationMs !== undefined
            ? input.runtimeConfig.maxDurationMs
            : currentRuntimeProjection.maxDurationMs,
      });
      const runtimeConfigChanged = !runtimeConfigsEqual(currentRuntimeConfig, nextRuntimeConfig);
      const [updated] = await transaction
        .update(agents)
        .set({
          displayName: input.displayName ?? scope.agent.displayName,
          receiveMode: input.receiveMode ?? scope.agent.receiveMode,
          revision: sql`${agents.revision} + 1`,
          updatedAt: now,
        })
        .where(and(eq(agents.id, agentId), ne(agents.status, "deleted"), eq(agents.revision, input.expectedRevision)))
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
        return { config: toAgentAdminConfig(updated, runtimeConfig) };
      }

      const current = await this.#resolveAgentScope(transaction, callerUserId, agentId);
      this.#requireManagePermission(current);
      throw new AgentServiceError(
        "AGENT_REVISION_CONFLICT",
        "deterministic",
        "The Agent changed since it was read",
        409,
      );
    });
    if ("scopeReauthorizationRequired" in result) {
      throw new AgentServiceError(
        "IM_BINDING_SCOPE_REAUTH_REQUIRED",
        "deterministic",
        "The IM binding must be reauthorized before enabling all-message receive mode",
        409,
      );
    }
    return result.config;
  }

  async suspendById(callerUserId: string, agentId: string): Promise<AgentAdminConfig> {
    const result = await this.#database.transaction(async (transaction) => {
      const scope = await this.#lockAgentScopeForMutation(transaction, callerUserId, agentId);
      this.#requireManagePermission(scope);
      if (scope.agent.status !== "active") throw this.#lifecycleConflict("Only an active Agent can be suspended");
      const runtimeConfig = await this.#lockRuntimeConfig(transaction, agentId);
      const targets = await this.#activeSessionTargets(transaction, agentId);
      const now = this.#now();
      const [updated] = await transaction
        .update(agents)
        .set({ status: "suspended", updatedAt: now, revision: sql`${agents.revision} + 1` })
        .where(and(eq(agents.id, agentId), eq(agents.status, "active")))
        .returning();
      if (!updated) throw this.#lifecycleConflict("The Agent lifecycle changed before suspension");
      return { config: toAgentAdminConfig(updated, runtimeConfig), targets };
    });
    await this.#stopSessionsBestEffort(result.targets);
    return result.config;
  }

  async reactivateById(callerUserId: string, agentId: string): Promise<AgentAdminConfig> {
    return this.#database.transaction(async (transaction) => {
      const scope = await this.#lockAgentScopeForMutation(transaction, callerUserId, agentId);
      this.#requireManagePermission(scope);
      if (scope.agent.status !== "suspended") {
        throw this.#lifecycleConflict("Only a suspended Agent can be reactivated");
      }
      const runtimeConfig = await this.#lockRuntimeConfig(transaction, agentId);
      const now = this.#now();
      const [updated] = await transaction
        .update(agents)
        .set({ status: "active", updatedAt: now, revision: sql`${agents.revision} + 1` })
        .where(and(eq(agents.id, agentId), eq(agents.status, "suspended")))
        .returning();
      if (!updated) throw this.#lifecycleConflict("The Agent lifecycle changed before reactivation");
      return toAgentAdminConfig(updated, runtimeConfig);
    });
  }

  async deleteById(callerUserId: string, agentId: string): Promise<void> {
    const targets = await this.#database.transaction(async (transaction) => {
      const scope = await this.#lockAgentScopeForMutation(transaction, callerUserId, agentId);
      this.#requireManagePermission(scope);
      if (scope.agent.status !== "suspended") {
        throw this.#lifecycleConflict("An Agent must be suspended before it can be deleted");
      }

      const now = this.#now();
      const activeTargets = await this.#activeSessionTargets(transaction, agentId);
      const [imBinding] = await transaction
        .select({ id: imBindings.id })
        .from(imBindings)
        .where(and(eq(imBindings.agentId, agentId), ne(imBindings.status, "disabled")))
        .limit(1)
        .for("update");
      if (imBinding) await disableImBindingInTransaction(transaction, imBinding.id, now);
      await transaction.delete(agentRuntimeConfigs).where(eq(agentRuntimeConfigs.agentId, agentId));
      const [deleted] = await transaction
        .update(agents)
        .set({ status: "deleted", updatedAt: now, revision: sql`${agents.revision} + 1` })
        .where(and(eq(agents.id, agentId), eq(agents.status, "suspended")))
        .returning({ id: agents.id });
      if (!deleted) throw this.#lifecycleConflict("The Agent lifecycle changed before deletion");
      return activeTargets;
    });
    await this.#stopSessionsBestEffort(targets);
  }

  async #lockAgentScopeForMutation(
    transaction: DatabaseTransaction,
    callerUserId: string,
    agentId: string,
  ): Promise<AgentScope> {
    const [candidate] = await transaction
      .select({ teamId: agents.teamId })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!candidate) throw resourceNotFound();
    const role = await this.#requireTeamMembershipForMutation(transaction, callerUserId, candidate.teamId);
    const [agent] = await transaction
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1)
      .for("update");
    if (!agent) throw resourceNotFound();
    await this.#afterAgentLocked?.();
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

  async #resolveAgentScope(executor: QueryExecutor, callerUserId: string, agentId: string): Promise<AgentScope> {
    const [agent] = await executor
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
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
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
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

  async #activeSessionTargets(transaction: DatabaseTransaction, agentId: string): Promise<AgentSessionStopTarget[]> {
    return transaction
      .select({
        agentId: imBindings.agentId,
        computerId: sessionPlacements.computerId,
        placementGeneration: sessionPlacements.generation,
        sessionId: sessions.id,
      })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .where(and(eq(imBindings.agentId, agentId), isNull(sessions.endedAt)));
  }

  #lifecycleConflict(message: string): AgentServiceError {
    return new AgentServiceError("AGENT_LIFECYCLE_CONFLICT", "deterministic", message, 409);
  }

  async #stopSessionsBestEffort(targets: AgentSessionStopTarget[]): Promise<void> {
    try {
      await this.#stopSessions(targets);
    } catch {
      this.#onDiagnostic("AGENT_SESSION_STOP_FAILED");
    }
  }
}
