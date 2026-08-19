import {
  type InvitationPreview,
  type InvitationRedemptionResponse,
  InvitationTokenSchema,
  type TeamInvitation,
} from "@opentag/shared";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { invitationRedemptions, invitations, teams } from "../../db/schema/index.js";
import { AuthServiceError, generateSecret, hashSecret } from "../auth/index.js";
import type { ApplicationCipher } from "../crypto.js";
import type { TeamMembershipService } from "../teams/index.js";

export interface InvitationAuditContext {
  ip?: string;
  userAgent?: string;
}

export class InvitationService {
  readonly #cipher: ApplicationCipher;
  readonly #database: DatabaseClient;
  readonly #membershipService: TeamMembershipService;
  readonly #now: () => Date;
  readonly #publicUrl: URL;
  readonly #ttlMs: number;

  constructor(
    database: DatabaseClient,
    membershipService: TeamMembershipService,
    cipher: ApplicationCipher,
    publicUrl: string,
    options: { now?: () => Date; ttlMs?: number } = {},
  ) {
    this.#database = database;
    this.#membershipService = membershipService;
    this.#cipher = cipher;
    this.#publicUrl = new URL(publicUrl);
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  async getOrCreate(callerUserId: string, teamId: string): Promise<TeamInvitation> {
    return this.#database.transaction(async (transaction) => {
      await this.#membershipService.requireActiveMembershipForMutation(transaction, callerUserId, teamId);
      const now = this.#now();
      await transaction
        .update(invitations)
        .set({ revokedAt: now })
        .where(and(eq(invitations.teamId, teamId), isNull(invitations.revokedAt), lte(invitations.expiresAt, now)));
      const [current] = await transaction
        .select()
        .from(invitations)
        .where(and(eq(invitations.teamId, teamId), isNull(invitations.revokedAt)))
        .limit(1)
        .for("update");
      return current ? this.#toInvitation(current) : this.#create(transaction, callerUserId, teamId, now);
    });
  }

  async rotate(callerUserId: string, teamId: string): Promise<TeamInvitation> {
    return this.#database.transaction(async (transaction) => {
      await this.#membershipService.requireActiveMembershipForMutation(transaction, callerUserId, teamId, "admin");
      const now = this.#now();
      await transaction
        .update(invitations)
        .set({ revokedAt: now })
        .where(and(eq(invitations.teamId, teamId), isNull(invitations.revokedAt)));
      return this.#create(transaction, callerUserId, teamId, now);
    });
  }

  async preview(rawToken: string): Promise<InvitationPreview> {
    const token = this.#parseToken(rawToken);
    const now = this.#now();
    const [row] = await this.#database
      .select({ invitation: invitations, teamDisplayName: teams.displayName })
      .from(invitations)
      .innerJoin(teams, eq(teams.id, invitations.teamId))
      .where(
        and(
          eq(invitations.tokenHash, hashSecret(token)),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, now),
        ),
      )
      .limit(1);
    if (!row) throw this.#invalid();
    return {
      teamDisplayName: row.teamDisplayName,
      role: row.invitation.role,
      expiresAt: row.invitation.expiresAt.toISOString(),
    };
  }

  redeem(userId: string, rawToken: string, audit: InvitationAuditContext = {}): Promise<InvitationRedemptionResponse> {
    return this.#database.transaction((transaction) => this.redeemInTransaction(transaction, userId, rawToken, audit));
  }

  async redeemInTransaction(
    transaction: DatabaseTransaction,
    userId: string,
    rawToken: string,
    audit: InvitationAuditContext = {},
  ): Promise<InvitationRedemptionResponse> {
    const token = this.#parseToken(rawToken);
    const tokenHash = hashSecret(token);
    const [candidate] = await transaction
      .select({ teamId: invitations.teamId })
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1);
    if (!candidate) throw this.#invalid();
    await this.#membershipService.lockTeamForMutation(transaction, candidate.teamId);
    const [invitation] = await transaction
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1)
      .for("update");
    const now = this.#now();
    if (!invitation || invitation.revokedAt || invitation.expiresAt <= now) throw this.#invalid();

    const membership = await this.#membershipService.joinWithInvitationInTransaction(
      transaction,
      userId,
      invitation.teamId,
      invitation.role,
    );

    await transaction.insert(invitationRedemptions).values({
      invitationId: invitation.id,
      userId,
      redeemedAt: now,
      ip: audit.ip,
      userAgent: audit.userAgent,
    });
    const [team] = await transaction.select().from(teams).where(eq(teams.id, invitation.teamId)).limit(1);
    if (!team) throw this.#invalid();
    return {
      membership: {
        teamId: team.id,
        teamName: team.name,
        teamDisplayName: team.displayName,
        role: membership.role,
      },
    };
  }

  async #create(
    transaction: DatabaseTransaction,
    callerUserId: string,
    teamId: string,
    now: Date,
  ): Promise<TeamInvitation> {
    const token = generateSecret(32);
    const [created] = await transaction
      .insert(invitations)
      .values({
        teamId,
        tokenHash: hashSecret(token),
        tokenCiphertext: this.#cipher.encrypt(token),
        role: "member",
        expiresAt: new Date(now.getTime() + this.#ttlMs),
        createdBy: callerUserId,
        createdAt: now,
      })
      .returning();
    if (!created) throw new Error("Invitation insert did not return a row");
    return this.#toInvitation(created);
  }

  #toInvitation(row: typeof invitations.$inferSelect): TeamInvitation {
    let token: string;
    try {
      token = this.#parseToken(this.#cipher.decrypt(row.tokenCiphertext));
    } catch {
      throw new AuthServiceError(
        "INVITATION_CORRUPT",
        "deterministic",
        "The current Team invitation cannot be decrypted; rotate it to create a replacement",
        409,
      );
    }
    return {
      token,
      inviteUrl: new URL(`/invite/${encodeURIComponent(token)}`, this.#publicUrl).toString(),
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  #parseToken(value: string): string {
    const parsed = InvitationTokenSchema.safeParse(value);
    if (!parsed.success) throw this.#invalid();
    return parsed.data;
  }

  #invalid(): AuthServiceError {
    return new AuthServiceError("INVITATION_INVALID", "credential", "The invitation is invalid or expired", 404);
  }
}
