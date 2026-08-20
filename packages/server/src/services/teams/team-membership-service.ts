import {
  type CreateTeamRequest,
  CreateTeamRequestSchema,
  type CreateTeamResponse,
  type ListTeamComputersConfigResponse,
  type ListTeamComputersResponse,
  type ListTeamMembersConfigResponse,
  type ListTeamMembersResponse,
  type MembershipRole,
  MembershipRoleSchema,
  type TeamComputerAdminConfig,
  type TeamComputerSummary,
  type TeamMemberAdminConfig,
  type TeamProfile,
  type UpdateTeamProfileRequest,
  UpdateTeamProfileRequestSchema,
} from "@opentag/shared";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, computers, memberships, teams, users } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
import { type ProviderReadinessSource, projectComputerProviderReadiness } from "../computers/provider-readiness.js";

type QueryExecutor = Pick<DatabaseClient, "select">;

/**
 * The one invariant: a user holds at most this many active memberships. Every writer that can raise the
 * count — creation, invitation redemption and admin restore — checks it under a lock on the affected
 * user's row, so concurrent writers cannot both pass. It bounds the membership fan-out that
 * `#resolveActiveUser` re-reads on every authenticated request.
 *
 * It is deliberately NOT a durable quota on Team creation: a creator who promotes another admin may leave,
 * which frees a slot while the Team and its canonical name persist. Bounding self-serve creation itself
 * needs a durable record of authorship, which the schema does not carry.
 */
export const TEAM_MEMBERSHIP_LIMIT = 50;

function isTeamNameConflict(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      current.constraint_name === "teams_name_unique"
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export class TeamMembershipService {
  readonly #database: DatabaseClient;
  readonly #afterMembershipUserLocked: (() => Promise<void>) | undefined;
  readonly #afterTeamProfileAuthorityLocked: (() => Promise<void>) | undefined;
  readonly #now: () => Date;
  readonly #presenceTimeoutMs: number;
  readonly #providerReadiness?: ProviderReadinessSource;

  constructor(
    database: DatabaseClient,
    options: {
      afterMembershipUserLocked?: () => Promise<void>;
      afterTeamProfileAuthorityLocked?: () => Promise<void>;
      now?: () => Date;
      presenceTimeoutMs?: number;
      providerReadiness?: ProviderReadinessSource;
    } = {},
  ) {
    this.#database = database;
    this.#afterMembershipUserLocked = options.afterMembershipUserLocked;
    this.#afterTeamProfileAuthorityLocked = options.afterTeamProfileAuthorityLocked;
    this.#now = options.now ?? (() => new Date());
    this.#presenceTimeoutMs = options.presenceTimeoutMs ?? 90_000;
    this.#providerReadiness = options.providerReadiness;
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
  ): Promise<{ membership: typeof memberships.$inferSelect; transitioned: boolean }> {
    await this.lockUserForMembershipWrite(transaction, userId);
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
    if (existing?.status === "active") return { membership: existing, transitioned: false };
    await this.#requireMembershipHeadroom(transaction, userId);
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
    return { membership, transitioned: true };
  }

  /**
   * Takes the membership-write lock on a user. Every path that can change how many Teams a user belongs to
   * takes this BEFORE any Team lock, so the two never invert: post-authentication redemption already locks
   * the user first, and a path that locked the Team first would deadlock against it. Re-taking it inside one
   * transaction is a no-op.
   */
  async lockUserForMembershipWrite(transaction: DatabaseTransaction, userId: string): Promise<void> {
    await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1).for("update");
    await this.#afterMembershipUserLocked?.();
  }

  /** Refuses the write that would take the user past TEAM_MEMBERSHIP_LIMIT; the caller holds the user lock. */
  async #requireMembershipHeadroom(transaction: DatabaseTransaction, userId: string): Promise<void> {
    const held = await transaction
      .select({ teamId: memberships.teamId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")));
    if (held.length >= TEAM_MEMBERSHIP_LIMIT) {
      throw new AuthServiceError(
        "TEAM_LIMIT_REACHED",
        "deterministic",
        `A user can hold at most ${TEAM_MEMBERSHIP_LIMIT} active Team memberships`,
        409,
      );
    }
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

  /**
   * Creates a Team and installs its creator as the first admin in one transaction.
   * Team creation is always an explicit user action; no caller may provision a Team implicitly.
   */
  async createTeam(callerUserId: string, rawInput: CreateTeamRequest): Promise<CreateTeamResponse> {
    const input = CreateTeamRequestSchema.parse(rawInput);
    try {
      return await this.#database.transaction(async (transaction) => {
        const [user] = await transaction
          .select({ suspendedAt: users.suspendedAt })
          .from(users)
          .where(eq(users.id, callerUserId))
          .limit(1)
          .for("update");
        if (!user) throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "The token is invalid", 401);
        if (user.suspendedAt) {
          throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
        }
        await this.#requireMembershipHeadroom(transaction, callerUserId);
        const now = this.#now();
        const [team] = await transaction
          .insert(teams)
          .values({ name: input.name, displayName: input.displayName, createdAt: now, updatedAt: now })
          .returning();
        if (!team) throw new Error("Team insert did not return a row");
        await this.bootstrapAdminInTransaction(transaction, callerUserId, team.id);
        return {
          id: team.id,
          name: team.name,
          displayName: team.displayName,
          role: "admin",
          createdAt: team.createdAt.toISOString(),
          updatedAt: team.updatedAt.toISOString(),
        };
      });
    } catch (error) {
      if (isTeamNameConflict(error)) {
        throw new AuthServiceError(
          "TEAM_NAME_CONFLICT",
          "deterministic",
          "Another Team already uses this canonical name",
          409,
        );
      }
      throw error;
    }
  }

  async updateTeamProfile(
    callerUserId: string,
    teamId: string,
    rawInput: UpdateTeamProfileRequest,
  ): Promise<TeamProfile> {
    const input = UpdateTeamProfileRequestSchema.parse(rawInput);
    try {
      return await this.#database.transaction(async (transaction) => {
        await this.requireActiveMembershipForMutation(transaction, callerUserId, teamId, "admin");
        await this.#afterTeamProfileAuthorityLocked?.();
        const updatedAt = this.#now();
        const [updated] = await transaction
          .update(teams)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
            updatedAt,
          })
          .where(eq(teams.id, teamId))
          .returning({
            id: teams.id,
            name: teams.name,
            displayName: teams.displayName,
            updatedAt: teams.updatedAt,
          });
        if (!updated) throw this.#notFound();
        return {
          id: updated.id,
          name: updated.name,
          displayName: updated.displayName,
          updatedAt: updated.updatedAt.toISOString(),
        };
      });
    } catch (error) {
      if (isTeamNameConflict(error)) {
        throw new AuthServiceError(
          "TEAM_NAME_CONFLICT",
          "deterministic",
          "Another Team already uses this canonical name",
          409,
        );
      }
      throw error;
    }
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
      await this.lockUserForMembershipWrite(transaction, userId);
      await this.requireActiveMembershipForMutation(transaction, callerUserId, teamId, "admin");
      const target = await this.#lockMembership(transaction, teamId, userId);
      if (target.status === "active") {
        throw new AuthServiceError("MEMBERSHIP_FORBIDDEN", "deterministic", "The Team member is already active", 409);
      }
      await this.#requireMembershipHeadroom(transaction, userId);
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
      const connectionStatus =
        row.computer.currentInstanceId !== null && row.computer.lastSeenAt.getTime() >= cutoff ? "online" : "offline";
      byId.set(row.computer.id, {
        id: row.computer.id,
        ownerUserId: row.computer.ownerUserId,
        ownerDisplayName: row.ownerDisplayName,
        displayName: row.computer.displayName,
        platform: row.computer.platform,
        connectionStatus,
        providerReadiness: projectComputerProviderReadiness(
          row.computer.id,
          connectionStatus,
          observedAt,
          this.#providerReadiness,
        ),
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
      const connectionStatus =
        row.computer.currentInstanceId !== null && row.computer.lastSeenAt.getTime() >= cutoff ? "online" : "offline";
      byId.set(row.computer.id, {
        id: row.computer.id,
        ownerUserId: row.computer.ownerUserId,
        ownerDisplayName: row.ownerDisplayName,
        displayName: row.computer.displayName,
        platform: row.computer.platform,
        arch: row.computer.arch,
        clientVersion: row.computer.clientVersion,
        connectionStatus,
        providerReadiness: projectComputerProviderReadiness(
          row.computer.id,
          connectionStatus,
          observedAt,
          this.#providerReadiness,
        ),
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
        and(eq(agents.teamId, memberships.teamId), eq(agents.computerId, computers.id), ne(agents.status, "deleted")),
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
      .where(and(eq(agents.teamId, teamId), eq(agents.managerUserId, userId), ne(agents.status, "deleted")))
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
