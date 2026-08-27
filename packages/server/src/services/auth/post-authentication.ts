import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { users, workspaceAdminGrants } from "../../db/schema/index.js";
import type { WorkspaceAdminAccess } from "../workspace-admin-access/index.js";
import { AuthServiceError } from "./errors.js";

export interface PostAuthenticationResult {
  userId: string;
}

export class PostAuthenticationService {
  readonly #database: DatabaseClient;
  readonly #workspaceAdmins: WorkspaceAdminAccess;

  constructor(database: DatabaseClient, workspaceAdmins: WorkspaceAdminAccess) {
    this.#database = database;
    this.#workspaceAdmins = workspaceAdmins;
  }

  complete(userId: string, accountWasCreated: boolean): Promise<PostAuthenticationResult> {
    return this.#database.transaction((transaction) =>
      this.completeInTransaction(transaction, userId, accountWasCreated),
    );
  }

  /**
   * The same guarantees as {@link complete}, for a caller that does not know whether the Account was just created.
   *
   * Better Auth owns account creation on its own sign-in paths, so nothing there can tell us. Deriving it from the
   * absence of a grant is equivalent for this purpose and makes the call idempotent: a returning Account is a no-op,
   * and one that never received its grant — or lost it — gets one before any session exists.
   */
  async ensureAccountReady(userId: string): Promise<PostAuthenticationResult> {
    return this.#database.transaction(async (transaction) => {
      const [user] = await transaction.select().from(users).where(eq(users.id, userId)).limit(1).for("update");
      if (!user || user.suspendedAt) {
        throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
      }
      const [grant] = await transaction
        .select({ workspaceId: workspaceAdminGrants.workspaceId })
        .from(workspaceAdminGrants)
        .where(and(eq(workspaceAdminGrants.userId, userId), isNull(workspaceAdminGrants.revokedAt)))
        .limit(1);
      if (!grant) {
        await this.#workspaceAdmins.establishDefaultWorkspaceForNewAccount(transaction, user, true);
      }
      return { userId };
    });
  }

  async completeInTransaction(
    transaction: DatabaseTransaction,
    userId: string,
    accountWasCreated: boolean,
  ): Promise<PostAuthenticationResult> {
    const [user] = await transaction.select().from(users).where(eq(users.id, userId)).limit(1).for("update");
    if (!user || user.suspendedAt) {
      throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
    }
    await this.#workspaceAdmins.establishDefaultWorkspaceForNewAccount(transaction, user, accountWasCreated);
    return { userId };
  }
}
