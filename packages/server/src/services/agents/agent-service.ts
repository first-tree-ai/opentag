import { createHash } from "node:crypto";
import {
  AGENT_USAGE_WINDOW_DAYS,
  type AgentAdminConfig,
  type AgentDetail,
  type AgentListActivity,
  type AgentListItem,
  type AgentRuntimeConfig,
  AgentRuntimeConfigSchema,
  type AgentRuntimeProvider,
  type AgentSummary,
  type AgentUsageDetail,
  type AgentUsageWindowDays,
  type CreateAgentRequest,
  CreateAgentRequestSchema,
  type CreateAgentRuntimeConfig,
  hasRequiredFeishuTenantScopes,
  type ListAgentsResponse,
  runtimeUsageTotalTokens,
  type UpdateAgentRequest,
  UpdateAgentRequestSchema,
} from "@opentag/shared";
import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { disableImBindingInTransaction } from "../im-bindings/index.js";
import { resolveAgentRuntimeConfig } from "../runtime-config/index.js";
import { AgentServiceError, resourceNotFound } from "./errors.js";

type AgentRow = typeof agents.$inferSelect;
type AgentRuntimeConfigRow = typeof agentRuntimeConfigs.$inferSelect;
type QueryExecutor = Pick<DatabaseClient, "select">;

interface AgentScope {
  agent: AgentRow;
  canManage: boolean;
  computerId: string | null;
}

interface AgentComputer {
  computerId: string;
  displayName: string;
  ownerAccountId: string;
  platform: "darwin" | "linux" | "win32";
}

interface AgentSafeRow {
  id: string;
  createdByUserId: string;
  creatorDisplayName: string;
  computer: AgentComputer | null;
  name: string;
  displayName: string;
  runtimeProvider: "codex" | "claude-code";
  receiveMode: "all_message" | "mention_only";
  status: AgentRow["status"];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Separates the two ways a joined Computer can be absent. `agentComputerId` is null while the Agent
 * has no Computer, which is a normal state the reader must see; a bound Agent whose Computer row did
 * not join is a broken record and stays an error rather than being reported as unbound.
 */
function toAgentComputer(row: {
  agentComputerId: string | null;
  computerId: string | null;
  computerDisplayName: string | null;
  computerOwnerAccountId: string | null;
  computerPlatform: "darwin" | "linux" | "win32" | null;
}): AgentComputer | null {
  if (row.agentComputerId === null) return null;
  if (!row.computerId || !row.computerDisplayName || !row.computerPlatform || !row.computerOwnerAccountId) {
    throw new Error("Active Agent is missing its bound Computer");
  }
  return {
    computerId: row.computerId,
    displayName: row.computerDisplayName,
    ownerAccountId: row.computerOwnerAccountId,
    platform: row.computerPlatform,
  };
}

interface AgentActivityEvidence {
  acceptedAt: Date | null;
  agentId: string;
  bindingStatus: string;
  reportedAt: Date | null;
  sessionEndedAt: Date | null;
  state: string;
}

function projectActivityByAgent(rows: readonly AgentActivityEvidence[]): Map<string, AgentListActivity> {
  const workingStartedAt = new Map<string, Date>();
  for (const row of rows) {
    if (
      row.state !== "accepted" ||
      row.reportedAt !== null ||
      !row.acceptedAt ||
      row.bindingStatus !== "active" ||
      row.sessionEndedAt !== null
    ) {
      continue;
    }
    const current = workingStartedAt.get(row.agentId);
    if (!current || row.acceptedAt > current) workingStartedAt.set(row.agentId, row.acceptedAt);
  }
  return new Map(
    [...workingStartedAt].map(([agentId, startedAt]) => [
      agentId,
      { state: "working", startedAt: startedAt.toISOString() },
    ]),
  );
}

export interface AgentSessionStopTarget {
  agentId: string;
  computerId: string;
  installationId: string;
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

function toAgentAdminConfig(
  row: AgentRow,
  runtimeConfig: AgentRuntimeConfigRow,
  computerId: string | null,
): AgentAdminConfig {
  if (row.status === "deleted") throw new Error("Deleted Agent cannot be projected as an admin config");
  return {
    id: row.id,
    createdByUserId: row.createdByUserId,
    computerId,
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
    createdBy: { userId: row.createdByUserId, displayName: row.creatorDisplayName },
    computer: row.computer
      ? {
          computerId: row.computer.computerId,
          displayName: row.computer.displayName,
          platform: row.computer.platform,
        }
      : null,
    name: row.name,
    displayName: row.displayName,
    runtimeProvider: row.runtimeProvider,
    receiveMode: row.receiveMode,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.computer && row.computer.ownerAccountId !== row.createdByUserId ? { requiresComputerRebind: true } : {}),
  };
}

interface UsageTokenCounts {
  cachedInputTokens: number;
  inputTokens: number;
  measured: boolean;
  outputTokens: number;
  tokens: number;
}

function deliveryUsageTokenCounts(
  provider: AgentRuntimeProvider,
  inputTokens: string | null,
  cachedInputTokens: string | null,
  outputTokens: string | null,
): UsageTokenCounts {
  const parse = (value: string | null): number | undefined => {
    if (value === null) return undefined;
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new Error("Agent usage contains an invalid token count");
    }
    return result;
  };
  const usage = {
    inputTokens: parse(inputTokens),
    cachedInputTokens: parse(cachedInputTokens),
    outputTokens: parse(outputTokens),
  };
  const normalizedInputTokens =
    (usage.inputTokens ?? 0) + (provider === "claude-code" ? (usage.cachedInputTokens ?? 0) : 0);
  return {
    inputTokens: normalizedInputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    tokens: runtimeUsageTotalTokens(provider, usage),
    measured: Object.values(usage).some((value) => value !== undefined),
  };
}

function addUsageTokenCounts(
  target: Pick<AgentUsageDetail, "cachedInputTokens" | "inputTokens" | "outputTokens" | "tokens">,
  value: UsageTokenCounts,
): void {
  target.inputTokens += value.inputTokens;
  target.cachedInputTokens += value.cachedInputTokens;
  target.outputTokens += value.outputTokens;
  target.tokens += value.tokens;
  if (![target.inputTokens, target.cachedInputTokens, target.outputTokens, target.tokens].every(Number.isSafeInteger)) {
    throw new Error("Agent usage token total exceeds the safe integer range");
  }
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
  readonly #now: () => Date;
  readonly #onDiagnostic: (code: string) => void;
  readonly #onProviderCliPlacementChanged?:
    | ((input: { agentId: string; previousComputerId?: string; computerId?: string }) => Promise<void> | void)
    | undefined;
  readonly #stopSessions: (targets: AgentSessionStopTarget[]) => Promise<void>;

  constructor(
    database: DatabaseClient,
    options: {
      afterAgentLocked?: () => Promise<void>;
      afterMembershipLocked?: () => Promise<void>;
      now?: () => Date;
      onDiagnostic?: (code: string) => void;
      onProviderCliPlacementChanged?: (input: {
        agentId: string;
        previousComputerId?: string;
        computerId?: string;
      }) => Promise<void> | void;
      stopSessions?: (targets: AgentSessionStopTarget[]) => Promise<void>;
    } = {},
  ) {
    this.#afterAgentLocked = options.afterAgentLocked;
    this.#afterMembershipLocked = options.afterMembershipLocked;
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#onProviderCliPlacementChanged = options.onProviderCliPlacementChanged;
    this.#stopSessions = options.stopSessions ?? (async () => undefined);
  }

  async createForAccount(callerUserId: string, rawInput: CreateAgentRequest): Promise<AgentAdminConfig> {
    const input = CreateAgentRequestSchema.parse(rawInput);
    return this.#create(callerUserId, input);
  }

  /**
   * Reconciles one exact creation id without replaying its write. A foreign, deleted, or suspended
   * result is indistinguishable from one that has not completed, and no namesake can satisfy it.
   */
  async getCreationIntentResultForAccount(
    callerUserId: string,
    creationIntentId: string,
  ): Promise<{ kind: "found"; agentId: string } | { kind: "not-found" }> {
    const [result] = await this.#database
      .select({ agentId: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.createdByUserId, callerUserId), eq(agents.creationIntentId, creationIntentId)))
      .limit(1);
    return result?.status === "active" ? { kind: "found", agentId: result.agentId } : { kind: "not-found" };
  }

  async #create(callerUserId: string, input: CreateAgentRequest): Promise<AgentAdminConfig> {
    const runtimeConfig = resolveAgentRuntimeConfig(input.runtimeConfig);
    const intentFingerprint = input.creationIntentId ? creationIntentFingerprint(input) : undefined;
    try {
      return await this.#database.transaction(async (transaction) => {
        await this.#afterMembershipLocked?.();
        const computer = input.computerId
          ? await this.#lockOwnedComputer(transaction, callerUserId, input.computerId)
          : undefined;
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`agent-name:${callerUserId}:${input.name}`}, 0))`,
        );
        if (input.creationIntentId && intentFingerprint) {
          const replay = await this.#findCreationIntent(
            transaction,
            callerUserId,
            input.creationIntentId,
            intentFingerprint,
          );
          if (replay) return replay;
        }
        const [nameConflict] = await transaction
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(eq(agents.createdByUserId, callerUserId), eq(agents.name, input.name), ne(agents.status, "deleted")),
          )
          .limit(1);
        if (nameConflict) {
          throw new AgentServiceError(
            "AGENT_NAME_CONFLICT",
            "deterministic",
            "An active Agent with this name already exists for this Account",
            409,
          );
        }

        const now = this.#now();
        const [created] = await transaction
          .insert(agents)
          .values({
            createdByUserId: callerUserId,
            creationIntentId: input.creationIntentId,
            creationIntentFingerprint: intentFingerprint,
            computerId: computer?.id ?? null,
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
        return toAgentAdminConfig(created, createdRuntimeConfig, computer?.id ?? null);
      });
    } catch (error) {
      const constraintName = uniqueConstraintName(error);
      if (constraintName && input.creationIntentId) {
        const replay = await this.#replayCreationIntent(
          callerUserId,
          input.creationIntentId,
          creationIntentFingerprint(input),
        );
        if (replay) return replay;
      }
      if (constraintName === "agents_workspace_name_active_unique") {
        throw new AgentServiceError(
          "AGENT_NAME_CONFLICT",
          "deterministic",
          "An active Agent with this name already exists for this Account",
          409,
        );
      }
      throw error;
    }
  }

  async #replayCreationIntent(
    callerUserId: string,
    creationIntentId: string,
    intentFingerprint: string,
  ): Promise<AgentAdminConfig | undefined> {
    return this.#database.transaction(async (transaction) => {
      return this.#findCreationIntent(transaction, callerUserId, creationIntentId, intentFingerprint);
    });
  }

  async #findCreationIntent(
    executor: QueryExecutor,
    callerUserId: string,
    creationIntentId: string,
    intentFingerprint: string,
  ): Promise<AgentAdminConfig | undefined> {
    const [row] = await executor
      .select({ agent: agents, computerId: agents.computerId, runtimeConfig: agentRuntimeConfigs })
      .from(agents)
      .leftJoin(agentRuntimeConfigs, eq(agentRuntimeConfigs.agentId, agents.id))
      .where(and(eq(agents.createdByUserId, callerUserId), eq(agents.creationIntentId, creationIntentId)))
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
    return toAgentAdminConfig(row.agent, row.runtimeConfig, row.computerId);
  }

  async listForAccount(callerUserId: string): Promise<ListAgentsResponse> {
    const creator = alias(users, "agent_creator");
    const rows = await this.#database
      .select({
        id: agents.id,
        createdByUserId: agents.createdByUserId,
        creatorDisplayName: creator.displayName,
        agentComputerId: agents.computerId,
        computerId: computers.id,
        computerDisplayName: computers.displayName,
        computerPlatform: computers.platform,
        computerOwnerAccountId: computers.ownerAccountId,
        name: agents.name,
        displayName: agents.displayName,
        runtimeProvider: agents.runtimeProvider,
        receiveMode: agents.receiveMode,
        status: agents.status,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .innerJoin(creator, eq(creator.id, agents.createdByUserId))
      .leftJoin(computers, eq(computers.id, agents.computerId))
      .where(and(eq(agents.createdByUserId, callerUserId), ne(agents.status, "deleted")))
      .orderBy(asc(agents.name), asc(agents.id));
    const summaries = rows.flatMap((row) => {
      if (!row.id) return [];
      if (!row.creatorDisplayName) throw new Error("Active Agent is missing its creator audit record");
      return [toAgentSummary({ ...row, computer: toAgentComputer(row) })];
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
    const activityByAgent = projectActivityByAgent(activityRows);
    const runtimeProviderByAgent = new Map(summaries.map((agent) => [agent.id, agent.runtimeProvider]));
    for (const row of activityRows) {
      if (!row.acceptedAt || row.acceptedAt < usageStartedAt) continue;
      const usage = usageByAgent.get(row.agentId) ?? { failed: 0, tasks: 0, tokens: 0 };
      usage.tasks += 1;
      if (row.outcome === "failed") usage.failed += 1;
      const runtimeProvider = runtimeProviderByAgent.get(row.agentId);
      if (!runtimeProvider) throw new Error("Agent usage is missing its runtime Provider");
      usage.tokens += deliveryUsageTokenCounts(
        runtimeProvider,
        row.inputTokens,
        row.cachedInputTokens,
        row.outputTokens,
      ).tokens;
      if (!Number.isSafeInteger(usage.tokens))
        throw new Error("Agent usage token total exceeds the safe integer range");
      usageByAgent.set(row.agentId, usage);
    }

    return {
      agents: summaries.map((agent): AgentListItem => {
        const usage = usageByAgent.get(agent.id) ?? { failed: 0, tasks: 0, tokens: 0 };
        return {
          ...agent,
          activity: activityByAgent.get(agent.id) ?? { state: "idle" },
          usage: { windowDays: AGENT_USAGE_WINDOW_DAYS, ...usage },
        };
      }),
    };
  }

  async getById(callerUserId: string, agentId: string): Promise<AgentDetail> {
    const creator = alias(users, "agent_creator");
    const [row] = await this.#database
      .select({
        id: agents.id,
        createdByUserId: agents.createdByUserId,
        creatorDisplayName: creator.displayName,
        agentComputerId: agents.computerId,
        computerId: computers.id,
        computerDisplayName: computers.displayName,
        computerPlatform: computers.platform,
        computerOwnerAccountId: computers.ownerAccountId,
        name: agents.name,
        displayName: agents.displayName,
        runtimeProvider: agents.runtimeProvider,
        receiveMode: agents.receiveMode,
        status: agents.status,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .innerJoin(creator, eq(creator.id, agents.createdByUserId))
      .leftJoin(computers, eq(computers.id, agents.computerId))
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!row || row.createdByUserId !== callerUserId) throw resourceNotFound();
    const activityRows = await this.#database
      .select({
        acceptedAt: imMessageDeliveries.acceptedAt,
        agentId: imBindings.agentId,
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
          eq(imBindings.agentId, agentId),
          eq(imMessageDeliveries.state, "accepted"),
          isNull(imMessageDeliveries.reportedAt),
        ),
      );
    return {
      ...toAgentSummary({ ...row, computer: toAgentComputer(row) }),
      activity: projectActivityByAgent(activityRows).get(agentId) ?? { state: "idle" },
    };
  }

  async getUsageById(
    callerUserId: string,
    agentId: string,
    windowDays: AgentUsageWindowDays,
  ): Promise<AgentUsageDetail> {
    const { agent } = await this.#resolveAgentScope(this.#database, callerUserId, agentId);
    const usageEndedAt = this.#now();
    const usageStartedAt = new Date(usageEndedAt.getTime() - windowDays * 24 * 60 * 60 * 1_000);
    const rows = await this.#database
      .select({
        acceptedAt: imMessageDeliveries.acceptedAt,
        cachedInputTokens: sql<string | null>`${imMessageDeliveries.turnReport} #>> '{usage,cachedInputTokens}'`,
        inputTokens: sql<string | null>`${imMessageDeliveries.turnReport} #>> '{usage,inputTokens}'`,
        outcome: sql<string | null>`${imMessageDeliveries.turnReport} ->> 'outcome'`,
        outputTokens: sql<string | null>`${imMessageDeliveries.turnReport} #>> '{usage,outputTokens}'`,
      })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .where(
        and(
          eq(imBindings.agentId, agentId),
          gte(imMessageDeliveries.acceptedAt, usageStartedAt),
          lte(imMessageDeliveries.acceptedAt, usageEndedAt),
        ),
      )
      .orderBy(asc(imMessageDeliveries.acceptedAt), asc(imMessageDeliveries.id));

    const result: AgentUsageDetail = {
      windowDays,
      startedAt: usageStartedAt.toISOString(),
      endedAt: usageEndedAt.toISOString(),
      tasks: 0,
      measuredTasks: 0,
      failed: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      tokens: 0,
      daily: [],
    };
    const daily = new Map<string, AgentUsageDetail["daily"][number]>();
    const firstDate = Date.UTC(
      usageStartedAt.getUTCFullYear(),
      usageStartedAt.getUTCMonth(),
      usageStartedAt.getUTCDate(),
    );
    const lastDate = Date.UTC(usageEndedAt.getUTCFullYear(), usageEndedAt.getUTCMonth(), usageEndedAt.getUTCDate());
    for (let timestamp = firstDate; timestamp <= lastDate; timestamp += 24 * 60 * 60 * 1_000) {
      const date = new Date(timestamp).toISOString().slice(0, 10);
      daily.set(date, {
        date,
        tasks: 0,
        measuredTasks: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        tokens: 0,
      });
    }
    for (const row of rows) {
      if (!row.acceptedAt) continue;
      result.tasks += 1;
      if (row.outcome === "failed") result.failed += 1;
      const tokenCounts = deliveryUsageTokenCounts(
        agent.runtimeProvider,
        row.inputTokens,
        row.cachedInputTokens,
        row.outputTokens,
      );
      if (tokenCounts.measured) result.measuredTasks += 1;
      addUsageTokenCounts(result, tokenCounts);

      const date = row.acceptedAt.toISOString().slice(0, 10);
      const point = daily.get(date);
      if (!point) throw new Error("Agent usage date falls outside the requested window");
      point.tasks += 1;
      if (tokenCounts.measured) point.measuredTasks += 1;
      addUsageTokenCounts(point, tokenCounts);
      daily.set(date, point);
    }
    result.daily = [...daily.values()];
    return result;
  }

  async getConfigById(callerUserId: string, agentId: string): Promise<AgentAdminConfig> {
    const scope = await this.#resolveAgentDetailScope(this.#database, callerUserId, agentId);
    this.#requireManagePermission(scope);
    return toAgentAdminConfig(scope.agent, scope.runtimeConfig, scope.computerId);
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
            provider: imBindings.provider,
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
        return { config: toAgentAdminConfig(updated, runtimeConfig, scope.computerId) };
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
      return {
        config: toAgentAdminConfig(updated, runtimeConfig, scope.computerId),
        computerId: scope.computerId,
        targets,
      };
    });
    await this.#notifyProviderCliPlacement({
      agentId,
      previousComputerId: result.computerId ?? undefined,
    });
    await this.#stopSessionsBestEffort(result.targets);
    return result.config;
  }

  async reactivateById(callerUserId: string, agentId: string): Promise<AgentAdminConfig> {
    const result = await this.#database.transaction(async (transaction) => {
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
      return { computerId: scope.computerId, config: toAgentAdminConfig(updated, runtimeConfig, scope.computerId) };
    });
    await this.#notifyProviderCliPlacement({ agentId, computerId: result.computerId ?? undefined });
    return result.config;
  }

  async rebindById(callerUserId: string, agentId: string, computerId: string): Promise<AgentAdminConfig> {
    const result = await this.#database.transaction(async (transaction) => {
      const scope = await this.#lockAgentScopeForMutation(transaction, callerUserId, agentId);
      this.#requireManagePermission(scope);
      const target = await this.#lockOwnedComputer(transaction, callerUserId, computerId);
      const active = await transaction
        .select({
          endedAt: sessions.endedAt,
          generation: sessionPlacements.generation,
          sessionId: sessions.id,
          computerId: sessionPlacements.computerId,
        })
        .from(sessions)
        .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
        .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
        .where(and(eq(imBindings.agentId, agentId), isNull(sessions.endedAt)))
        .orderBy(asc(sessions.id))
        .for("update", { of: sessionPlacements });
      const runtimeConfig = await this.#lockRuntimeConfig(transaction, agentId);
      const changesAgent = scope.agent.computerId !== target.id;
      const changesPlacement = active.some(({ computerId }) => computerId !== target.id);
      if (!changesAgent && !changesPlacement) {
        return {
          changedComputer: false,
          computerId: target.id,
          config: toAgentAdminConfig(scope.agent, runtimeConfig, target.id),
          previousComputerId: scope.computerId,
        };
      }
      const sessionIds = active.map((row) => row.sessionId);
      if (sessionIds.length > 0) {
        const deliveries = await transaction
          .select({
            dispatchRequestId: imMessageDeliveries.dispatchRequestId,
            placementGeneration: imMessageDeliveries.placementGeneration,
            reportedAt: imMessageDeliveries.reportedAt,
            sessionId: imMessageDeliveries.sessionId,
            state: imMessageDeliveries.state,
          })
          .from(imMessageDeliveries)
          .where(inArray(imMessageDeliveries.sessionId, sessionIds));
        const blocked = deliveries.some(
          (delivery) =>
            delivery.state === "pending" ||
            (delivery.state === "accepted" && delivery.reportedAt === null) ||
            (delivery.state === "expired" && delivery.dispatchRequestId !== null),
        );
        if (blocked) {
          throw new AgentServiceError(
            "AGENT_REBIND_BLOCKED",
            "deterministic",
            "The Agent cannot rebind while Sessions have pending delivery, unreported Turns, or uncertain custody",
            409,
          );
        }
      }
      const now = this.#now();
      let updated = scope.agent;
      if (changesAgent) {
        const [changed] = await transaction
          .update(agents)
          .set({
            computerId: target.id,
            revision: sql`${agents.revision} + 1`,
            updatedAt: now,
          })
          .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
          .returning();
        if (!changed) throw resourceNotFound();
        updated = changed;
      }
      for (const row of active) {
        if (row.computerId === target.id) continue;
        const [moved] = await transaction
          .update(sessionPlacements)
          .set({
            computerId: target.id,
            generation: row.generation + 1,
            updatedAt: now,
          })
          .where(eq(sessionPlacements.sessionId, row.sessionId))
          .returning({ sessionId: sessionPlacements.sessionId });
        if (!moved) {
          throw new AgentServiceError(
            "AGENT_REBIND_BLOCKED",
            "deterministic",
            "The Agent cannot rebind while Sessions have pending delivery, unreported Turns, or uncertain custody",
            409,
          );
        }
      }
      return {
        changedComputer: changesAgent,
        computerId: target.id,
        config: toAgentAdminConfig(updated, runtimeConfig, target.id),
        previousComputerId: scope.computerId,
      };
    });
    if (result.changedComputer) {
      await this.#notifyProviderCliPlacement({
        agentId,
        previousComputerId: result.previousComputerId ?? undefined,
        computerId: result.computerId,
      });
    }
    return result.config;
  }

  async deleteById(callerUserId: string, agentId: string): Promise<void> {
    const result = await this.#database.transaction(async (transaction) => {
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
      return { computerId: scope.computerId, targets: activeTargets };
    });
    await this.#notifyProviderCliPlacement({
      agentId,
      previousComputerId: result.computerId ?? undefined,
    });
    await this.#stopSessionsBestEffort(result.targets);
  }

  async #lockAgentScopeForMutation(
    transaction: DatabaseTransaction,
    callerUserId: string,
    agentId: string,
  ): Promise<AgentScope> {
    const [row] = await transaction
      .select({ agent: agents, computerId: agents.computerId })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1)
      .for("update");
    if (!row || row.agent.createdByUserId !== callerUserId) throw resourceNotFound();
    await this.#afterAgentLocked?.();
    return { agent: row.agent, canManage: true, computerId: row.computerId };
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

  async #lockOwnedComputer(
    transaction: DatabaseTransaction,
    accountId: string,
    computerId: string,
  ): Promise<{ id: string }> {
    const [computer] = await transaction
      .select({ id: computers.id })
      .from(computers)
      .where(and(eq(computers.id, computerId), eq(computers.ownerAccountId, accountId)))
      .limit(1)
      .for("update");
    if (!computer) {
      throw new AgentServiceError("COMPUTER_NOT_FOUND", "deterministic", "The requested Computer was not found", 404);
    }
    return computer;
  }

  async #resolveAgentScope(executor: QueryExecutor, callerUserId: string, agentId: string): Promise<AgentScope> {
    const [row] = await executor
      .select({ agent: agents, computerId: agents.computerId })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!row || row.agent.createdByUserId !== callerUserId) throw resourceNotFound();
    return { agent: row.agent, canManage: true, computerId: row.computerId };
  }

  async #resolveAgentDetailScope(
    executor: QueryExecutor,
    callerUserId: string,
    agentId: string,
  ): Promise<AgentScope & { runtimeConfig: AgentRuntimeConfigRow }> {
    const [row] = await executor
      .select({ agent: agents, computerId: agents.computerId, runtimeConfig: agentRuntimeConfigs })
      .from(agents)
      .innerJoin(agentRuntimeConfigs, eq(agentRuntimeConfigs.agentId, agents.id))
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!row || row.agent.createdByUserId !== callerUserId) throw resourceNotFound();
    return {
      agent: row.agent,
      computerId: row.computerId,
      runtimeConfig: row.runtimeConfig,
      canManage: true,
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
        installationId: computers.currentInstallationId,
        computerId: sessionPlacements.computerId,
        placementGeneration: sessionPlacements.generation,
        sessionId: sessions.id,
      })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
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

  async #notifyProviderCliPlacement(input: {
    agentId: string;
    previousComputerId?: string;
    computerId?: string;
  }): Promise<void> {
    if (!this.#onProviderCliPlacementChanged) return;
    try {
      await this.#onProviderCliPlacementChanged(input);
    } catch {
      this.#onDiagnostic("PROVIDER_CLI_PLACEMENT_NOTIFY_FAILED");
    }
  }
}
