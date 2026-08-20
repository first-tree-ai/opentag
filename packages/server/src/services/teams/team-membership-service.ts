import {
  type ListTeamComputersConfigResponse,
  type ListTeamComputersResponse,
  type ListTeamMembersConfigResponse,
  type ListTeamMembersResponse,
  type MembershipRole,
  MembershipRoleSchema,
  type TeamComputerAdminConfig,
  type TeamComputerSummary,
  type TeamMemberAdminConfig,
} from "@opentag/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, computers, memberships, teams, users } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";

type QueryExecutor = Pick<DatabaseClient, "select">;

export class TeamMembershipService {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #presenceTimeoutMs: number;

  constructor(database: DatabaseClient, options: { now?: () => Date; presenceTimeoutMs?: number } = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#presenceTimeoutMs = options.presenceTimeoutMs ?? 90_000;
  }

  async requireActiveMembership(
    executor: QueryExecutor,
    userId: string,
    teamId: string,
    requiredRole?: "admin",
  ): Promise<"admin" | "member"> {
    const [membership] = await executor
      .select({ role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.teamId, teamId),
          eq(memberships.userId, userId),
          eq(memberships.status, "active"),
          isNull(users.suspendedAt),
        ),
      )
      .limit(1);
    if (!membership) throw this.#notFound();
    if (requiredRole === "admin" && membership.role !== "admin") {
      throw new AuthServiceError("MEMBERSHIP_FORBIDDEN", "deterministic", "Team admin access is required", 403);
    }
    return membership.role;
  }

  async lockTeamForMutation(transaction: DatabaseTransaction, teamId: string): Promise<void> {
    const [team] = await transaction
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1)
      .for("update");
    if (!team) throw new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The Team was not found", 404);
  }

  async requireActiveMembershipForMutation(
    transaction: DatabaseTransaction,
    userId: string,
    teamId: string,
    requiredRole?: "admin",
  ): Promise<"admin" | "member"> {
    await this.lockTeamForMutation(transaction, teamId);
    return (await this.#requireLockedActiveMembership(transaction, userId, teamId, requiredRole)).role;
  }

  async joinWithInvitationInTransaction(
    transaction: DatabaseTransaction,
    userId: string,
    teamId: string,
    role: MembershipRole,
  ): Promise<typeof memberships.$inferSelect> {
    await this.lockTeamForMutation(transaction, teamId);
    const [user] = await transaction.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || user.suspendedAt) {
      throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
    }
    const [existing] = await transaction
      .select()
      .from(memberships)
      .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, userId)))
      .limit(1)
      .for("update");
    if (existing?.status === "removed") {
      throw new AuthServiceError(
        "MEMBERSHIP_FORBIDDEN",
        "deterministic",
        "A Team admin must restore this removed membership",
        403,
      );
    }
    if (existing?.status === "active") return existing;
    const now = this.#now();
    const [membership] = existing
      ? await transaction
          .update(memberships)
          .set({ status: "active", role, updatedAt: now })
          .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, userId)))
          .returning()
      : await transaction
          .insert(memberships)
          .values({ teamId, userId, role, status: "active", createdAt: now, updatedAt: now })
          .returning();
    if (!membership) throw new Error("Invitation redemption did not return a membership");
    return membership;
  }

  async bootstrapAdminInTransaction(transaction: DatabaseTransaction, userId: string, teamId: string): Promise<void> {
    await this.lockTeamForMutation(transaction, teamId);
    const [existing] = await transaction
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, userId)))
      .limit(1)
      .for("update");
    if (existing) throw new Error("The initial Team admin membership already exists");
    const now = this.#now();
    await transaction.insert(memberships).values({
      teamId,
      userId,
      role: "admin",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }

  async listMembers(callerUserId: string, teamId: string): Promise<ListTeamMembersResponse> {
    await this.requireActiveMembership(this.#database, callerUserId, teamId);
    const rows = await this.#database
      .select({ userId: users.id, displayName: users.displayName, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.teamId, teamId), eq(memberships.status, "active"), isNull(users.suspendedAt)))
      .orderBy(asc(users.displayName), asc(users.id));
    return { members: rows };
  }

  async listMembersConfig(callerUserId: string, teamId: string): Promise<ListTeamMembersConfigResponse> {
    await this.requireActiveMembership(this.#database, callerUserId, teamId, "admin");
    const rows = await this.#database
      .select({ membership: memberships, user: users })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.teamId, teamId))
      .orderBy(asc(users.displayName), asc(users.id));
    return {
      members: rows.map(
        ({ membership, user }): TeamMemberAdminConfig => ({
          teamId,
          userId: user.id,
          email: user.email,
          displayName: user.displayName,
          role: membership.role,
          status: membership.status,
          createdAt: membership.createdAt.toISOString(),
          updatedAt: membership.updatedAt.toISOString(),
        }),
      ),
    };
  }

  async changeRole(
    callerUserId: string,
    teamId: string,
    userId: string,
    role: unknown,
  ): Promise<TeamMemberAdminConfig> {
    const parsedRole = MembershipRoleSchema.parse(role);
    return this.#database.transaction(async (transaction) => {
      await this.requireActiveMembershipForMutation(transaction, callerUserId, teamId, "admin");
      const activeAdmins = await this.#lockActiveAdmins(transaction, teamId);
      const target = await this.#lockMembership(transaction, teamId, userId);
      if (target.status !== "active") throw this.#notFound();
      if (target.role === "admin" && parsedRole === "member") this.#requireAnotherAdmin(activeAdmins, userId);
      const now = this.#now();
      const [updated] = await transaction
        .update(memberships)
        .set({ role: parsedRole, updatedAt: now })
        .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, userId)))
        .returning();
      if (!updated) throw this.#notFound();
      return this.#memberProjection(transaction, updated);
    });
  }

  async leave(callerUserId: string, teamId: string): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await this.requireActiveMembershipForMutation(transaction, callerUserId, teamId);
      const activeAdmins = await this.#lockActiveAdmins(transaction, teamId);
      const target = await this.#lockMembership(transaction, teamId, callerUserId);
      if (target.status !== "active") throw this.#notFound();
      await this.#guardDeparture(transaction, teamId, callerUserId, target.role, activeAdmins);
      await transaction
        .update(memberships)
        .set({ status: "left", updatedAt: this.#now() })
        .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, callerUserId)));
    });
  }

  async remove(callerUserId: string, teamId: string, userId: string): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await this.requireActiveMembershipForMutation(transaction, callerUserId, teamId, "admin");
      const activeAdmins = await this.#lockActiveAdmins(transaction, teamId);
      const target = await this.#lockMembership(transaction, teamId, userId);
      if (target.status !== "active") throw this.#notFound();
      await this.#guardDeparture(transaction, teamId, userId, target.role, activeAdmins);
      await transaction
        .update(memberships)
        .set({ status: "removed", updatedAt: this.#now() })
        .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, userId)));
    });
  }

  async restore(callerUserId: string, teamId: string, userId: string, role: unknown): Promise<TeamMemberAdminConfig> {
    const parsedRole = MembershipRoleSchema.parse(role);
    return this.#database.transaction(async (transaction) => {
      await this.requireActiveMembershipForMutation(transaction, callerUserId, teamId, "admin");
      const target = await this.#lockMembership(transaction, teamId, userId);
      if (target.status === "active") {
        throw new AuthServiceError("MEMBERSHIP_FORBIDDEN", "deterministic", "The Team member is already active", 409);
      }
      const [updated] = await transaction
        .update(memberships)
        .set({ status: "active", role: parsedRole, updatedAt: this.#now() })
        .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, userId)))
        .returning();
      if (!updated) throw this.#notFound();
      return this.#memberProjection(transaction, updated);
    });
  }

  /**
   * Lists every Computer owned by an active, non-suspended Team member.
   * Agent bindings decorate the Computer projection; they do not determine membership in it.
   */
  async listComputers(callerUserId: string, teamId: string): Promise<ListTeamComputersResponse> {
    await this.requireActiveMembership(this.#database, callerUserId, teamId);
    const rows = await this.#listComputerRows(teamId);
    const observedAt = this.#now();
    const cutoff = observedAt.getTime() - this.#presenceTimeoutMs;
    const byId = new Map<string, TeamComputerSummary>();
    for (const row of rows) {
      const existing = byId.get(row.computer.id);
      if (existing) {
        if (row.agentId) existing.agentIds.push(row.agentId);
        continue;
      }
      byId.set(row.computer.id, {
        id: row.computer.id,
        ownerUserId: row.computer.ownerUserId,
        ownerDisplayName: row.ownerDisplayName,
        displayName: row.computer.displayName,
        platform: row.computer.platform,
        connectionStatus:
          row.computer.currentInstanceId !== null && row.computer.lastSeenAt.getTime() >= cutoff ? "online" : "offline",
        connectedAt: row.computer.connectedAt?.toISOString() ?? null,
        lastSeenAt: row.computer.lastSeenAt.toISOString(),
        observedAt: observedAt.toISOString(),
        agentIds: row.agentId ? [row.agentId] : [],
      });
    }
    return { computers: [...byId.values()] };
  }

  async listComputersConfig(callerUserId: string, teamId: string): Promise<ListTeamComputersConfigResponse> {
    await this.requireActiveMembership(this.#database, callerUserId, teamId, "admin");
    const rows = await this.#listComputerRows(teamId);
    const observedAt = this.#now();
    const cutoff = observedAt.getTime() - this.#presenceTimeoutMs;
    const byId = new Map<string, TeamComputerAdminConfig>();
    for (const row of rows) {
      const existing = byId.get(row.computer.id);
      if (existing) {
        if (row.agentId) existing.agentIds.push(row.agentId);
        continue;
      }
      byId.set(row.computer.id, {
        id: row.computer.id,
        ownerUserId: row.computer.ownerUserId,
        ownerDisplayName: row.ownerDisplayName,
        displayName: row.computer.displayName,
        platform: row.computer.platform,
        arch: row.computer.arch,
        clientVersion: row.computer.clientVersion,
        connectionStatus:
          row.computer.currentInstanceId !== null && row.computer.lastSeenAt.getTime() >= cutoff ? "online" : "offline",
        connectedAt: row.computer.connectedAt?.toISOString() ?? null,
        lastSeenAt: row.computer.lastSeenAt.toISOString(),
        observedAt: observedAt.toISOString(),
        agentIds: row.agentId ? [row.agentId] : [],
      });
    }
    return { computers: [...byId.values()] };
  }

  #listComputerRows(teamId: string) {
    return this.#database
      .select({ agentId: agents.id, computer: computers, ownerDisplayName: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(computers, eq(computers.ownerUserId, memberships.userId))
      .leftJoin(
        agents,
        and(eq(agents.teamId, memberships.teamId), eq(agents.computerId, computers.id), isNull(agents.deletedAt)),
      )
      .where(and(eq(memberships.teamId, teamId), eq(memberships.status, "active"), isNull(users.suspendedAt)))
      .orderBy(asc(computers.displayName), asc(computers.id), asc(agents.id));
  }

  async #lockMembership(transaction: DatabaseTransaction, teamId: string, userId: string) {
    const [target] = await transaction
      .select()
      .from(memberships)
      .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, userId)))
      .for("update");
    if (!target) throw this.#notFound();
    return target;
  }

  async #requireLockedActiveMembership(
    transaction: DatabaseTransaction,
    userId: string,
    teamId: string,
    requiredRole?: "admin",
  ) {
    const membership = await this.#lockMembership(transaction, teamId, userId);
    const [user] = await transaction
      .select({ suspendedAt: users.suspendedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (membership.status !== "active" || !user || user.suspendedAt) throw this.#notFound();
    if (requiredRole === "admin" && membership.role !== "admin") {
      throw new AuthServiceError("MEMBERSHIP_FORBIDDEN", "deterministic", "Team admin access is required", 403);
    }
    return membership;
  }

  async #guardDeparture(
    transaction: DatabaseTransaction,
    teamId: string,
    userId: string,
    role: "admin" | "member",
    activeAdmins: string[],
  ): Promise<void> {
    const [activeAgent] = await transaction
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.teamId, teamId), eq(agents.managerUserId, userId), isNull(agents.deletedAt)))
      .limit(1);
    if (activeAgent) {
      throw new AuthServiceError(
        "MEMBERSHIP_ACTIVE_AGENTS",
        "deterministic",
        "Delete the member's active Agents before removing the Team membership",
        409,
      );
    }
    if (role === "admin") this.#requireAnotherAdmin(activeAdmins, userId);
  }

  async #lockActiveAdmins(transaction: DatabaseTransaction, teamId: string): Promise<string[]> {
    const admins = await transaction
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.teamId, teamId), eq(memberships.status, "active"), eq(memberships.role, "admin")))
      .orderBy(asc(memberships.userId))
      .for("update");
    return admins.map((admin) => admin.userId);
  }

  #requireAnotherAdmin(activeAdmins: string[], excludedUserId: string): void {
    if (!activeAdmins.some((userId) => userId !== excludedUserId)) {
      throw new AuthServiceError(
        "MEMBERSHIP_LAST_ADMIN",
        "deterministic",
        "The last active Team admin cannot leave, be removed, or be demoted",
        409,
      );
    }
  }

  async #memberProjection(
    transaction: DatabaseTransaction,
    membership: typeof memberships.$inferSelect,
  ): Promise<TeamMemberAdminConfig> {
    const [user] = await transaction.select().from(users).where(eq(users.id, membership.userId)).limit(1);
    if (!user) throw this.#notFound();
    return {
      teamId: membership.teamId,
      userId: membership.userId,
      email: user.email,
      displayName: user.displayName,
      role: membership.role,
      status: membership.status,
      createdAt: membership.createdAt.toISOString(),
      updatedAt: membership.updatedAt.toISOString(),
    } satisfies TeamMemberAdminConfig;
  }

  #notFound(): AuthServiceError {
    return new AuthServiceError("MEMBERSHIP_NOT_FOUND", "deterministic", "The Team membership was not found", 404);
  }
}
