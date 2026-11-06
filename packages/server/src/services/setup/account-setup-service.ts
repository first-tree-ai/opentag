import type { AccountSetupCompletion } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, users } from "../../db/schema/index.js";
import { DomainServiceError } from "../domain-service-error.js";

export class AccountSetupServiceError extends DomainServiceError<
  "ACCOUNT_SETUP_AGENT_NOT_FOUND",
  "deterministic",
  404
> {
  constructor(code: "ACCOUNT_SETUP_AGENT_NOT_FOUND", statusCode: 404, message: string) {
    super({ code, category: "deterministic", message, statusCode });
    this.name = "AccountSetupServiceError";
  }
}

/**
 * Owns the one-way transition from first-time setup into normal operations.
 *
 * The legal target is an active Agent owned by the Account — and it may be unbound: adopting it
 * opens normal app access on its own, with no handoff or runtime readiness gate. Foreign,
 * inactive, and missing targets are indistinguishable and all fail closed as not found.
 */
export class AccountSetupService {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;

  constructor(database: DatabaseClient, options: { now?: () => Date } = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  async completeForAccount(callerUserId: string, agentId: string): Promise<AccountSetupCompletion> {
    const current = await this.#existingCompletion(callerUserId);
    if (current) return current;

    return this.#database.transaction(async (transaction) => {
      const [lockedUser] = await transaction
        .select({ setupCompletedAt: users.setupCompletedAt })
        .from(users)
        .where(eq(users.id, callerUserId))
        .limit(1)
        .for("update");
      if (!lockedUser) {
        throw new AccountSetupServiceError(
          "ACCOUNT_SETUP_AGENT_NOT_FOUND",
          404,
          "The active setup Agent was not found",
        );
      }
      if (lockedUser.setupCompletedAt) return this.#projection(lockedUser.setupCompletedAt);

      const [lockedAgent] = await transaction
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, callerUserId), eq(agents.status, "active")))
        .limit(1)
        .for("update");
      if (!lockedAgent) {
        throw new AccountSetupServiceError(
          "ACCOUNT_SETUP_AGENT_NOT_FOUND",
          404,
          "The active setup Agent was not found",
        );
      }

      const completedAt = this.#now();
      const [completed] = await transaction
        .update(users)
        .set({ setupCompletedAt: completedAt, updatedAt: completedAt })
        .where(eq(users.id, callerUserId))
        .returning({ setupCompletedAt: users.setupCompletedAt });
      if (!completed?.setupCompletedAt) throw new Error("Account setup completion did not return a timestamp");
      return this.#projection(completed.setupCompletedAt);
    });
  }

  async #existingCompletion(callerUserId: string): Promise<AccountSetupCompletion | undefined> {
    const [row] = await this.#database
      .select({ setupCompletedAt: users.setupCompletedAt })
      .from(users)
      .where(eq(users.id, callerUserId))
      .limit(1);
    return row?.setupCompletedAt ? this.#projection(row.setupCompletedAt) : undefined;
  }

  #projection(setupCompletedAt: Date): AccountSetupCompletion {
    return { setupCompletedAt: setupCompletedAt.toISOString() };
  }
}
