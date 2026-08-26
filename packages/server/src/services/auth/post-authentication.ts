import { eq } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import type { WorkspaceAdminAccess } from "../workspace-admin-access/index.js";
import { AuthServiceError } from "./errors.js";

export interface PostAuthenticationResult {
  selectedWorkspaceId?: string;
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

  async completeInTransaction(
    transaction: DatabaseTransaction,
    userId: string,
    accountWasCreated: boolean,
  ): Promise<PostAuthenticationResult> {
    const [user] = await transaction.select().from(users).where(eq(users.id, userId)).limit(1).for("update");
    if (!user || user.suspendedAt) {
      throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
    }
    const selectedWorkspaceId = await this.#workspaceAdmins.establishDefaultWorkspaceForNewAccount(
      transaction,
      user,
      accountWasCreated,
    );
    return { userId, ...(selectedWorkspaceId ? { selectedWorkspaceId } : {}) };
  }
}
