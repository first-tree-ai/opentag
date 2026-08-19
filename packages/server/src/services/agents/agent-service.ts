import {
  type Agent,
  type CreateAgentRequest,
  CreateAgentRequestSchema,
  type ListAgentsResponse,
  type UpdateAgentRequest,
  UpdateAgentRequestSchema,
} from "@opentag/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, computers, memberships, users } from "../../db/schema/index.js";
import { AgentServiceError, resourceNotFound } from "./errors.js";

type AgentRow = typeof agents.$inferSelect;
type QueryExecutor = Pick<DatabaseClient, "select">;

interface AgentScope {
  agent: AgentRow;
  canManage: boolean;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    teamId: row.teamId,
    managerUserId: row.managerUserId,
    computerId: row.computerId,
    name: row.name,
    displayName: row.displayName,
    runtimeProvider: row.runtimeProvider,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
  readonly #database: DatabaseClient;
  readonly #now: () => Date;

  constructor(database: DatabaseClient, options: { now?: () => Date } = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  async createForTeam(callerUserId: string, teamId: string, rawInput: CreateAgentRequest): Promise<Agent> {
    const input = CreateAgentRequestSchema.parse(rawInput);
    try {
      return await this.#database.transaction(async (transaction) => {
        await this.#requireTeamMembership(transaction, callerUserId, teamId);
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
        return toAgent(created);
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
    const rows = await this.#database
      .select({ agent: agents })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(agents, and(eq(agents.teamId, memberships.teamId), isNull(agents.deletedAt)))
      .where(
        and(
          eq(memberships.teamId, teamId),
          eq(memberships.userId, callerUserId),
          isNull(memberships.leftAt),
          isNull(users.suspendedAt),
        ),
      )
      .orderBy(asc(agents.name), asc(agents.id));
    if (rows.length === 0) throw resourceNotFound();
    return { agents: rows.flatMap(({ agent }) => (agent ? [toAgent(agent)] : [])) };
  }

  async getById(callerUserId: string, agentId: string): Promise<Agent> {
    return toAgent((await this.#resolveAgentScope(this.#database, callerUserId, agentId, false)).agent);
  }

  async updateById(callerUserId: string, agentId: string, rawInput: UpdateAgentRequest): Promise<Agent> {
    const input = UpdateAgentRequestSchema.parse(rawInput);
    return this.#database.transaction(async (transaction) => {
      const scope = await this.#resolveAgentScope(transaction, callerUserId, agentId, false);
      this.#requireManagePermission(scope);
      const [updated] = await transaction
        .update(agents)
        .set({
          displayName: input.displayName,
          revision: sql`${agents.revision} + 1`,
          updatedAt: this.#now(),
        })
        .where(and(eq(agents.id, agentId), isNull(agents.deletedAt), eq(agents.revision, input.expectedRevision)))
        .returning();
      if (updated) return toAgent(updated);

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
      const [row] = await transaction.select().from(agents).where(eq(agents.id, agentId)).limit(1).for("update");
      if (!row) throw resourceNotFound();
      const role = await this.#requireTeamMembership(transaction, callerUserId, row.teamId);
      const scope = { agent: row, canManage: row.managerUserId === callerUserId || role === "admin" };
      if (row.deletedAt) {
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
          isNull(memberships.leftAt),
          isNull(users.suspendedAt),
        ),
      )
      .limit(1);
    if (!membership) throw resourceNotFound();
    return membership.role;
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
    return { agent, canManage: agent.managerUserId === callerUserId || role === "admin" };
  }

  #requireManagePermission(scope: AgentScope): void {
    if (!scope.canManage) {
      throw new AgentServiceError("AGENT_FORBIDDEN", "deterministic", "The caller cannot manage this Agent", 403);
    }
  }
}
