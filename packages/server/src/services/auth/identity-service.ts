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
    // Normalized here so every write below inherits it; `users.email` carries a case-insensitive unique index.
    email: z.string().trim().toLowerCase().email(),
    /**
     * Whether the provider asserted this address belongs to the person signing in. Only a verified address may
     * attach an identity to an Account that already exists, because that decision hands over an existing Account.
     */
    emailVerified: z.boolean(),
    displayName: UserDisplayNameSchema,
  })
  .strict();

export type ExternalIdentity = z.infer<typeof ExternalIdentitySchema>;

export interface ResolvedAccountIdentity {
  accountWasCreated: boolean;
  userId: string;
}

/** PostgreSQL unique violation, raised when a concurrent insert wins the race for an email. */
const UNIQUE_VIOLATION = "23505";

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
      const user = await this.#lockActiveUser(transaction, existing.userId);
      if (!user) throw this.#conflict();
      await transaction
        .update(authIdentities)
        .set({ email: identity.email, updatedAt: now })
        .where(eq(authIdentities.id, existing.id));
      await this.#applyAccountEmail(transaction, user, identity, now);
      return { accountWasCreated: false, userId: user.id };
    }
    if (expectedUserId) {
      const user = await this.#lockActiveUser(transaction, expectedUserId);
      if (!user) throw this.#suspended();
      await this.#insertIdentity(transaction, user.id, identity, now);
      await this.#applyAccountEmail(transaction, user, identity, now);
      return { accountWasCreated: false, userId: user.id };
    }

    /*
     * An Account may already exist for this address without carrying this identity: the bootstrap Account is created
     * from an email alone, and a person can sign in with a second provider. Resolving it here is what keeps a verified
     * address mapped to exactly one Account. Without it the insert below would race the `users_email_unique` index and
     * surface a raw unique violation as an opaque 500.
     */
    const owner = await this.#lockAccountByEmail(transaction, identity.email);
    if (owner) {
      if (!identity.emailVerified) throw this.#emailConflict();
      if (owner.suspendedAt) throw this.#suspended();
      await this.#insertIdentity(transaction, owner.id, identity, now);
      await this.#applyAccountEmail(transaction, owner, identity, now);
      return { accountWasCreated: false, userId: owner.id };
    }

    const user = await this.#insertAccount(transaction, identity, now);
    await this.#insertIdentity(transaction, user.id, identity, now);
    return { accountWasCreated: true, userId: user.id };
  }

  async #lockActiveUser(transaction: DatabaseTransaction, userId: string) {
    const [user] = await transaction.select().from(users).where(eq(users.id, userId)).limit(1).for("update");
    if (user?.suspendedAt) throw this.#suspended();
    return user;
  }

  async #lockAccountByEmail(transaction: DatabaseTransaction, email: string) {
    const [user] = await transaction
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1)
      .for("update");
    return user;
  }

  /**
   * Keeps `users.email` and `users.email_verified` describing the same address. The flag is only ever raised for the
   * address actually stored on the Account, so it can never claim verification for some other provider's address.
   */
  async #applyAccountEmail(
    transaction: DatabaseTransaction,
    user: { email: string; emailVerified: boolean; id: string },
    identity: ExternalIdentity,
    now: Date,
  ): Promise<void> {
    if (user.email === identity.email) {
      if (user.emailVerified || !identity.emailVerified) return;
      await transaction.update(users).set({ emailVerified: true, updatedAt: now }).where(eq(users.id, user.id));
      return;
    }
    if (!identity.emailVerified) return;
    const owner = await this.#lockAccountByEmail(transaction, identity.email);
    if (owner && owner.id !== user.id) throw this.#emailConflict();
    await transaction
      .update(users)
      .set({ email: identity.email, emailVerified: true, updatedAt: now })
      .where(eq(users.id, user.id));
  }

  async #insertAccount(transaction: DatabaseTransaction, identity: ExternalIdentity, now: Date) {
    try {
      const [user] = await transaction
        .insert(users)
        .values({
          email: identity.email,
          emailVerified: identity.emailVerified,
          displayName: identity.displayName,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: users.id });
      if (!user) throw new Error("User insert did not return a row");
      return user;
    } catch (error) {
      // The row lock above cannot serialize two inserts of an address that does not exist yet; the index does.
      if (isUniqueViolation(error)) throw this.#emailConflict();
      throw error;
    }
  }

  async #insertIdentity(
    transaction: DatabaseTransaction,
    userId: string,
    identity: ExternalIdentity,
    now: Date,
  ): Promise<void> {
    await transaction.insert(authIdentities).values({
      userId,
      provider: identity.provider,
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
      createdAt: now,
      updatedAt: now,
    });
  }

  #conflict(): AuthServiceError {
    return new AuthServiceError(
      "AUTH_IDENTITY_CONFLICT",
      "deterministic",
      "The provider identity is already attached to another user",
      409,
    );
  }

  #emailConflict(): AuthServiceError {
    return new AuthServiceError(
      "AUTH_EMAIL_CONFLICT",
      "deterministic",
      "The email address is already attached to another Account",
      409,
    );
  }

  #suspended(): AuthServiceError {
    return new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === UNIQUE_VIOLATION;
}
