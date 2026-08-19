import { and, eq } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { memberships, teams, users } from "../../db/schema/index.js";
import type { InvitationAuditContext, InvitationService } from "../invitations/index.js";
import { TeamMembershipService } from "../teams/index.js";
import { AuthServiceError } from "./errors.js";

export interface PostAuthenticationResult {
  selectedTeamId?: string;
  userId: string;
}

export class PostAuthenticationService {
  readonly #database: DatabaseClient;
  readonly #invitations: InvitationService;
  readonly #memberships: TeamMembershipService;
  readonly #now: () => Date;

  constructor(
    database: DatabaseClient,
    invitations: InvitationService,
    options: { membershipService?: TeamMembershipService; now?: () => Date } = {},
  ) {
    this.#database = database;
    this.#invitations = invitations;
    this.#memberships = options.membershipService ?? new TeamMembershipService(database, { now: options.now });
    this.#now = options.now ?? (() => new Date());
  }

  complete(
    userId: string,
    invitationToken?: string,
    audit: InvitationAuditContext = {},
  ): Promise<PostAuthenticationResult> {
    return this.#database.transaction((transaction) =>
      this.completeInTransaction(transaction, userId, invitationToken, audit),
    );
  }

  async completeInTransaction(
    transaction: DatabaseTransaction,
    userId: string,
    invitationToken?: string,
    audit: InvitationAuditContext = {},
  ): Promise<PostAuthenticationResult> {
    const [user] = await transaction.select().from(users).where(eq(users.id, userId)).limit(1).for("update");
    if (!user || user.suspendedAt) {
      throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
    }
    if (invitationToken) {
      const redemption = await this.#invitations.redeemInTransaction(transaction, userId, invitationToken, audit);
      return { userId, selectedTeamId: redemption.membership.teamId };
    }

    const [activeMembership] = await transaction
      .select({ teamId: memberships.teamId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")))
      .limit(1);
    if (activeMembership) return { userId };

    const now = this.#now();
    const name = await this.#allocateTeamName(transaction, user.displayName, user.id);
    const [team] = await transaction
      .insert(teams)
      .values({ name, displayName: `${user.displayName}'s Team`, createdAt: now, updatedAt: now })
      .returning();
    if (!team) throw new Error("Personal Team insert did not return a row");
    await this.#memberships.bootstrapAdminInTransaction(transaction, userId, team.id);
    return { userId, selectedTeamId: team.id };
  }

  async #allocateTeamName(transaction: DatabaseTransaction, displayName: string, userId: string): Promise<string> {
    const seed =
      displayName
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 36) || "personal";
    const suffix = userId.replaceAll("-", "").slice(0, 8);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = `${seed}-${suffix}${attempt === 0 ? "" : `-${attempt}`}`;
      const [existing] = await transaction
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.name, candidate))
        .limit(1);
      if (!existing) return candidate;
    }
    throw new Error("A unique personal Team name could not be allocated");
  }
}
