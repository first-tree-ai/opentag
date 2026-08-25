import { AuthIdentityProviderSchema, UserDisplayNameSchema } from "@opentag/shared";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { authIdentities, users } from "../../db/schema/index.js";
import { AuthServiceError } from "./errors.js";

const ExternalIdentitySchema = z
  .object({
    provider: AuthIdentityProviderSchema,
    issuer: z.string().url().max(2048),
    subject: z.string().min(1).max(512),
    email: z.string().email(),
    displayName: UserDisplayNameSchema,
  })
  .strict();

export type ExternalIdentity = z.infer<typeof ExternalIdentitySchema>;

export interface ResolvedAccountIdentity {
  accountWasCreated: boolean;
  userId: string;
}

export class AuthIdentityService {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;

  constructor(database: DatabaseClient, options: { now?: () => Date } = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  resolveOrCreate(identity: ExternalIdentity, expectedUserId?: string): Promise<string> {
    return this.#database.transaction(async (transaction) => {
      const resolved = await this.resolveOrCreateInTransaction(transaction, identity, expectedUserId);
      return resolved.userId;
    });
  }

  async resolveOrCreateInTransaction(
    transaction: DatabaseTransaction,
    rawIdentity: ExternalIdentity,
    expectedUserId?: string,
  ): Promise<ResolvedAccountIdentity> {
    const identity = ExternalIdentitySchema.parse(rawIdentity);
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
        identity.provider,
        identity.issuer,
        identity.subject,
      ])}, 0))`,
    );
    const [existing] = await transaction
      .select()
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.provider, identity.provider),
          eq(authIdentities.issuer, identity.issuer),
          eq(authIdentities.subject, identity.subject),
        ),
      )
      .limit(1)
      .for("update");
    const now = this.#now();
    if (existing) {
      if (expectedUserId && existing.userId !== expectedUserId) throw this.#conflict();
      const [user] = await transaction.select().from(users).where(eq(users.id, existing.userId)).limit(1).for("update");
      if (!user) throw this.#conflict();
      if (user.suspendedAt) {
        throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
      }
      await transaction
        .update(authIdentities)
        .set({ email: identity.email, updatedAt: now })
        .where(eq(authIdentities.id, existing.id));
      await transaction.update(users).set({ email: identity.email, updatedAt: now }).where(eq(users.id, user.id));
      return { accountWasCreated: false, userId: user.id };
    }
    if (expectedUserId) {
      const [user] = await transaction.select().from(users).where(eq(users.id, expectedUserId)).limit(1).for("update");
      if (!user || user.suspendedAt) {
        throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
      }
      await transaction.insert(authIdentities).values({
        userId: user.id,
        provider: identity.provider,
        issuer: identity.issuer,
        subject: identity.subject,
        email: identity.email,
        createdAt: now,
        updatedAt: now,
      });
      return { accountWasCreated: false, userId: user.id };
    }
    const [user] = await transaction
      .insert(users)
      .values({ email: identity.email, displayName: identity.displayName, createdAt: now, updatedAt: now })
      .returning({ id: users.id });
    if (!user) throw new Error("User insert did not return a row");
    await transaction.insert(authIdentities).values({
      userId: user.id,
      provider: identity.provider,
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
      createdAt: now,
      updatedAt: now,
    });
    return { accountWasCreated: true, userId: user.id };
  }

  #conflict(): AuthServiceError {
    return new AuthServiceError(
      "AUTH_IDENTITY_CONFLICT",
      "deterministic",
      "The provider identity is already attached to another user",
      409,
    );
  }
}
