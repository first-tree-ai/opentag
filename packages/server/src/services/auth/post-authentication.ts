import { eq } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { AuthServiceError } from "./errors.js";

export interface PostAuthenticationResult {
  userId: string;
}

export class PostAuthenticationService {
  readonly #database: DatabaseClient;

  constructor(database: DatabaseClient) {
    this.#database = database;
  }

  complete(userId: string, _accountWasCreated: boolean): Promise<PostAuthenticationResult> {
    return this.#database.transaction((transaction) => this.completeInTransaction(transaction, userId));
  }

  /**
   * Locks the Account and refuses a suspended caller. Management Workspace and grant provisioning
   * are not part of Account onboarding.
   */
  async ensureAccountReady(userId: string): Promise<PostAuthenticationResult> {
    return this.#database.transaction((transaction) => this.completeInTransaction(transaction, userId));
  }

  async completeInTransaction(
    transaction: DatabaseTransaction,
    userId: string,
    _accountWasCreated?: boolean,
  ): Promise<PostAuthenticationResult> {
    const [user] = await transaction.select().from(users).where(eq(users.id, userId)).limit(1).for("update");
    if (!user || user.suspendedAt) {
      throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
    }
    return { userId };
  }
}
