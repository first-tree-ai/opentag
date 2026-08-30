import type { ChannelName } from "@opentag/shared";
import { and, count, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  accountComputers,
  agents,
  computerConnectCodes,
  computerCredentials,
  imBindings,
  users,
} from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";

export type OnboardingResetErrorCode = "ONBOARDING_RESET_OWNERSHIP_INCONSISTENT" | "ONBOARDING_RESET_UNVERIFIED";

export class OnboardingResetError extends Error {
  readonly category = "deterministic" as const;

  constructor(
    readonly code: OnboardingResetErrorCode,
    readonly statusCode: 409,
    message: string,
  ) {
    super(message);
    this.name = "OnboardingResetError";
  }
}

/** The Agent lifecycle the reset reuses; it must not reimplement Agent, IM-binding or Session invariants. */
export interface OnboardingResetAgentLifecycle {
  suspendById(callerUserId: string, agentId: string): Promise<unknown>;
  deleteById(callerUserId: string, agentId: string): Promise<void>;
}

/** The live Computer connection registry seam used to close revoked Computers. */
export interface OnboardingResetConnectionRegistry {
  closeEnrollment(enrollmentId: string): Promise<boolean>;
}

type QueryExecutor = Pick<DatabaseClient, "select">;

export interface OnboardingResetServiceOptions {
  /** Test seam: runs after cleanup and before the locked commit boundary, to interleave a writer. */
  afterCleanup?: () => Promise<void>;
  /** Test seam: runs inside the locked commit, between verification and the setup marker. */
  afterVerified?: () => Promise<void>;
  agents: OnboardingResetAgentLifecycle;
  database: DatabaseClient;
  environment: ChannelName;
  now?: () => Date;
  registry?: OnboardingResetConnectionRegistry;
}

/**
 * Staging-only orchestration that returns the authenticated Account to a first-run state.
 *
 * It is deliberately separate from the production setup-completion module, whose transition
 * stays one-way. Every step is idempotent: a failed reset can simply be run again and continues
 * from current facts. Setup completion is cleared last, so the Account never enters onboarding
 * before active resource cleanup has been verified.
 *
 * Reset acts only on Agents this Account created and Computers it owns. It never writes
 * management Workspace persistence.
 */
export class OnboardingResetService {
  readonly #afterCleanup?: () => Promise<void>;
  readonly #afterVerified?: () => Promise<void>;
  readonly #agents: OnboardingResetAgentLifecycle;
  readonly #database: DatabaseClient;
  readonly #environment: ChannelName;
  readonly #now: () => Date;
  readonly #registry: OnboardingResetConnectionRegistry | undefined;

  constructor(options: OnboardingResetServiceOptions) {
    this.#afterCleanup = options.afterCleanup;
    this.#afterVerified = options.afterVerified;
    this.#agents = options.agents;
    this.#database = options.database;
    this.#environment = options.environment;
    this.#now = options.now ?? (() => new Date());
    this.#registry = options.registry;
  }

  get enabled(): boolean {
    return this.#environment === "staging";
  }

  async resetOnboarding(accountId: string): Promise<void> {
    if (!this.enabled) throw resourceNotFound();
    await this.#deleteOwnedAgents(accountId);
    const computerIds = await this.#revokeComputerAccess(accountId);
    for (const computerId of computerIds) {
      await this.#registry?.closeEnrollment(computerId);
    }
    await this.#afterCleanup?.();
    await this.#commitFirstRunState(accountId);
  }

  async #deleteOwnedAgents(accountId: string): Promise<void> {
    const owned = await this.#database
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.createdByUserId, accountId), ne(agents.status, "deleted")));
    for (const agent of owned) {
      if (agent.status === "active") await this.#agents.suspendById(accountId, agent.id);
      await this.#agents.deleteById(accountId, agent.id);
    }
  }

  async #revokeComputerAccess(accountId: string): Promise<readonly string[]> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      await lockActiveAccount(transaction, accountId);
      await transaction
        .update(computerConnectCodes)
        .set({ revokedByUserId: accountId, revokedAt: now })
        .where(
          and(
            eq(computerConnectCodes.issuedByAccountId, accountId),
            isNull(computerConnectCodes.consumedAt),
            isNull(computerConnectCodes.revokedAt),
          ),
        );

      const owned = await transaction
        .select({ id: accountComputers.id })
        .from(accountComputers)
        .where(eq(accountComputers.ownerAccountId, accountId))
        .for("update");
      const computerIds = owned.map((computer) => computer.id);
      if (computerIds.length === 0) return [];

      await transaction
        .update(computerCredentials)
        .set({ revokedByUserId: accountId, revokedAt: now })
        .where(and(inArray(computerCredentials.computerId, computerIds), isNull(computerCredentials.revokedAt)));
      await transaction
        .update(accountComputers)
        .set({
          currentInstanceId: null,
          connectedAt: null,
          updatedAt: now,
        })
        .where(inArray(accountComputers.id, computerIds));
      return computerIds;
    });
  }

  async #commitFirstRunState(accountId: string): Promise<void> {
    const now = this.#now();
    await this.#database.transaction(async (transaction) => {
      await lockActiveAccount(transaction, accountId);
      await this.#verifyCleanedUp(transaction, accountId, now);
      await this.#afterVerified?.();
      await transaction.update(users).set({ setupCompletedAt: null, updatedAt: now }).where(eq(users.id, accountId));
    });
  }

  async #verifyCleanedUp(executor: QueryExecutor, accountId: string, now: Date): Promise<void> {
    const remainingAgents = await this.#count(
      executor
        .select({ value: count() })
        .from(agents)
        .where(and(eq(agents.createdByUserId, accountId), ne(agents.status, "deleted"))),
    );
    const activeBindings = await this.#count(
      executor
        .select({ value: count() })
        .from(imBindings)
        .innerJoin(agents, eq(agents.id, imBindings.agentId))
        .where(and(eq(agents.createdByUserId, accountId), ne(imBindings.status, "disabled"))),
    );
    const activeCredentials = await this.#count(
      executor
        .select({ value: count() })
        .from(computerCredentials)
        .innerJoin(accountComputers, eq(accountComputers.id, computerCredentials.computerId))
        .where(and(eq(accountComputers.ownerAccountId, accountId), isNull(computerCredentials.revokedAt))),
    );
    const usableCodes = await this.#count(
      executor
        .select({ value: count() })
        .from(computerConnectCodes)
        .where(
          and(
            eq(computerConnectCodes.issuedByAccountId, accountId),
            isNull(computerConnectCodes.consumedAt),
            isNull(computerConnectCodes.revokedAt),
            gt(computerConnectCodes.expiresAt, now),
          ),
        ),
    );
    if (remainingAgents + activeBindings + activeCredentials + usableCodes > 0) {
      throw new OnboardingResetError(
        "ONBOARDING_RESET_UNVERIFIED",
        409,
        "The Account still has active OpenTag resources after cleanup; retry the reset",
      );
    }
  }

  async #count(query: PromiseLike<{ value: number }[]>): Promise<number> {
    const [row] = await query;
    return row?.value ?? 0;
  }
}

async function lockActiveAccount(transaction: DatabaseTransaction, accountId: string): Promise<void> {
  const [user] = await transaction
    .select({ id: users.id, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1)
    .for("update");
  if (!user || user.suspendedAt) {
    throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
  }
}

function resourceNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
