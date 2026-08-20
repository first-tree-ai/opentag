import { eq } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import type { InvitationAuditContext, InvitationService } from "../invitations/index.js";
import type { TeamMembershipService } from "../teams/index.js";
import { AuthServiceError } from "./errors.js";

export interface PostAuthenticationResult {
  selectedTeamId?: string;
  userId: string;
}

export class PostAuthenticationService {
  readonly #database: DatabaseClient;
  readonly #invitations: InvitationService;
  readonly #teams: TeamMembershipService;

  constructor(database: DatabaseClient, invitations: InvitationService, teams: TeamMembershipService) {
    this.#database = database;
    this.#invitations = invitations;
    this.#teams = teams;
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
    const selectedTeamId = await this.#teams.establishPersonalTeamForLockedUserInTransaction(transaction, user);
    return { userId, ...(selectedTeamId ? { selectedTeamId } : {}) };
  }
}
