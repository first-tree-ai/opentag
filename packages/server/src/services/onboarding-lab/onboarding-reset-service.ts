import type { ChannelName } from "@opentag/shared";
import { and, count, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  accountComputers,
  agents,
  computerConnectCodes,
  computerCredentials,
  imBindings,
  workspaceAdminGrants,
  workspaceComputerCredentials,
  workspaceComputers,
  workspaces,
} from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
import { WorkspaceAdminAccess } from "../workspace-admin-access/index.js";

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

/** The live Computer connection registry seam used to close revoked enrollments. */
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
  workspaceAdmins?: WorkspaceAdminAccess;
}

/**
 * Staging-only orchestration that returns the authenticated Account to a first-run state.
 *
 * It is deliberately separate from the production setup-completion module, whose transition
 * stays one-way. Every step is idempotent: a failed reset can simply be run again and continues
 * from current facts. Setup completion is cleared last, so the Account never enters onboarding
 * before active resource cleanup has been verified.
 *
 * Phase 1 compatibility: an Account still owns its resources through exactly one internal
 * Workspace scope, so ownership is resolved here and nowhere else. The interface is already
 * Account-native; the direct Account-ownership cutover replaces only `#resolveOwnedScope`.
 */
export class OnboardingResetService {
  readonly #afterCleanup?: () => Promise<void>;
  readonly #afterVerified?: () => Promise<void>;
  readonly #agents: OnboardingResetAgentLifecycle;
  readonly #database: DatabaseClient;
  readonly #environment: ChannelName;
  readonly #now: () => Date;
  readonly #registry: OnboardingResetConnectionRegistry | undefined;
  readonly #workspaceAdmins: WorkspaceAdminAccess;

  constructor(options: OnboardingResetServiceOptions) {
    this.#afterCleanup = options.afterCleanup;
    this.#afterVerified = options.afterVerified;
    this.#agents = options.agents;
    this.#database = options.database;
    this.#environment = options.environment;
    this.#now = options.now ?? (() => new Date());
    this.#registry = options.registry;
    this.#workspaceAdmins = options.workspaceAdmins ?? new WorkspaceAdminAccess(options.database, { now: options.now });
  }

  /**
   * Whether this deployment offers the Lab at all. The environment is re-confirmed here rather than
   * trusted from route registration, so a misconfigured deployment outside staging still exposes
   * nothing — not even the read-only Scenario Preview.
   *
   * Staging offers the reset to every authenticated Account, because the operation only ever acts on
   * the Account that asks: the caller is the authenticated Account, no Account may be named by a
   * client, and `#resolveOwnedScope` refuses unless that Account owns exactly one active resource
   * scope, exclusively. A tester returns their own onboarding to a first-run state without a shared
   * Account to take turns on, and without reaching anything of anyone else's.
   */
  get enabled(): boolean {
    return this.#environment === "staging";
  }

  async resetOnboarding(accountId: string): Promise<void> {
    // Re-confirm the environment before any mutation rather than trusting route registration.
    if (!this.enabled) throw resourceNotFound();
    const scope = await this.#resolveOwnedScope(accountId);

    await this.#deleteOwnedAgents(accountId, scope);
    const enrollmentIds = await this.#revokeComputerAccess(accountId, scope);
    for (const enrollmentId of enrollmentIds) {
      await this.#registry?.closeEnrollment(enrollmentId);
    }
    await this.#afterCleanup?.();
    await this.#commitFirstRunState(accountId, scope);
  }

  /**
   * Selects the scope through the one canonical compatibility seam, so reset can never target a
   * different Workspace than the rest of the Account-native surface, and the Account-ownership
   * cutover replaces one selection rule rather than two.
   *
   * Selection alone is not enough for a destructive staging reset, so two fail-closed checks stay
   * on top of it: the Lab Account must have exactly one active scope, and that scope must have
   * exactly one active admin. Neither check picks a scope; both only refuse.
   */
  async #resolveOwnedScope(accountId: string): Promise<{ workspaceId: string }> {
    const workspaceId = await this.#selectScope(accountId);
    const owned = await this.#workspaceAdmins.listActiveAdminWorkspaces(accountId);
    if (owned.length !== 1) {
      throw ownershipInconsistent("The Lab Account does not own exactly one active OpenTag resource scope");
    }
    const [{ admins } = { admins: 0 }] = await this.#database
      .select({ admins: count() })
      .from(workspaceAdminGrants)
      .where(and(eq(workspaceAdminGrants.workspaceId, workspaceId), isNull(workspaceAdminGrants.revokedAt)));
    if (admins !== 1) {
      throw ownershipInconsistent("The Lab Account resource scope is not owned exclusively by the Lab Account");
    }
    return { workspaceId };
  }

  /**
   * The canonical resolver reports "this Account has no scope" as a non-disclosing 404, which is
   * right for ordinary management: the caller may not be entitled to know. The Lab has already
   * identified this Account as its own, so the same fact is a retryable ownership inconsistency
   * rather than a missing page. Only that outcome is translated; every other failure propagates.
   */
  async #selectScope(accountId: string): Promise<string> {
    try {
      return await this.#workspaceAdmins.resolveCompatibilityWorkspaceId(accountId);
    } catch (error) {
      if (error instanceof AuthServiceError && error.code === "RESOURCE_NOT_FOUND" && error.statusCode === 404) {
        throw ownershipInconsistent("The Lab Account does not own exactly one active OpenTag resource scope");
      }
      throw error;
    }
  }

  /**
   * Suspends then deletes every non-deleted Agent through the existing lifecycle, which disables
   * IM bindings, clears encrypted IM and setup credentials, ends Sessions and removes runtime
   * configuration. Already suspended Agents skip straight to deletion.
   */
  async #deleteOwnedAgents(accountId: string, scope: { workspaceId: string }): Promise<void> {
    const owned = await this.#database
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.workspaceId, scope.workspaceId), ne(agents.status, "deleted")));
    for (const agent of owned) {
      if (agent.status === "active") await this.#agents.suspendById(accountId, agent.id);
      await this.#agents.deleteById(accountId, agent.id);
    }
  }

  /**
   * Revokes outstanding connect codes, enrollment credentials and enrollments in one transaction,
   * and reports every enrollment whose live connection must still be closed.
   */
  async #revokeComputerAccess(accountId: string, scope: { workspaceId: string }): Promise<readonly string[]> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      await this.#workspaceAdmins.requireAdminForMutation(transaction, accountId, scope.workspaceId);
      await transaction
        .update(computerConnectCodes)
        .set({ revokedByUserId: accountId, revokedAt: now })
        .where(
          and(
            eq(computerConnectCodes.workspaceId, scope.workspaceId),
            isNull(computerConnectCodes.consumedAt),
            isNull(computerConnectCodes.revokedAt),
          ),
        );

      const enrollments = await transaction
        .select({ id: workspaceComputers.id })
        .from(workspaceComputers)
        .where(eq(workspaceComputers.workspaceId, scope.workspaceId))
        .for("update");
      const enrollmentIds = enrollments.map((enrollment) => enrollment.id);
      if (enrollmentIds.length === 0) return [];

      await transaction
        .update(workspaceComputerCredentials)
        .set({ revokedByUserId: accountId, revokedAt: now })
        .where(
          and(
            inArray(workspaceComputerCredentials.workspaceComputerId, enrollmentIds),
            isNull(workspaceComputerCredentials.revokedAt),
          ),
        );
      await transaction
        .update(computerCredentials)
        .set({ revokedByUserId: accountId, revokedAt: now })
        .where(and(inArray(computerCredentials.computerId, enrollmentIds), isNull(computerCredentials.revokedAt)));
      await transaction
        .update(workspaceComputers)
        .set({
          revokedByUserId: accountId,
          revokedAt: now,
          currentInstanceId: null,
          connectedAt: null,
          updatedAt: now,
        })
        .where(and(inArray(workspaceComputers.id, enrollmentIds), isNull(workspaceComputers.revokedAt)));
      await transaction
        .update(accountComputers)
        .set({
          currentInstanceId: null,
          connectedAt: null,
          updatedAt: now,
        })
        .where(inArray(accountComputers.id, enrollmentIds));
      return enrollmentIds;
    });
  }

  /**
   * Verification and the setup marker share one locked commit boundary. Every ordinary Agent,
   * enrollment and connect-code mutation locks this scope first, so re-checking and clearing under
   * the same lock is what makes a 204 mean the Account really entered onboarding with no active
   * resource. Verifying outside it would let a concurrent writer slip in between the two steps.
   */
  async #commitFirstRunState(accountId: string, scope: { workspaceId: string }): Promise<void> {
    const now = this.#now();
    await this.#database.transaction(async (transaction) => {
      await this.#workspaceAdmins.requireAdminForMutation(transaction, accountId, scope.workspaceId);
      await this.#verifyCleanedUp(transaction, scope, now);
      await this.#afterVerified?.();
      await transaction
        .update(workspaces)
        .set({ setupCompletedAt: null, updatedAt: now })
        .where(eq(workspaces.id, scope.workspaceId));
    });
  }

  /**
   * Re-reads authoritative facts; a retained historical row must never satisfy an active fact.
   * The reads run in sequence because they share the caller's single transaction connection.
   */
  async #verifyCleanedUp(executor: QueryExecutor, scope: { workspaceId: string }, now: Date): Promise<void> {
    const remainingAgents = await this.#count(
      executor
        .select({ value: count() })
        .from(agents)
        .where(and(eq(agents.workspaceId, scope.workspaceId), ne(agents.status, "deleted"))),
    );
    const activeBindings = await this.#count(
      executor
        .select({ value: count() })
        .from(imBindings)
        .innerJoin(agents, eq(agents.id, imBindings.agentId))
        .where(and(eq(agents.workspaceId, scope.workspaceId), ne(imBindings.status, "disabled"))),
    );
    const activeEnrollments = await this.#count(
      executor
        .select({ value: count() })
        .from(workspaceComputers)
        .where(and(eq(workspaceComputers.workspaceId, scope.workspaceId), isNull(workspaceComputers.revokedAt))),
    );
    const activeCredentials = await this.#count(
      executor
        .select({ value: count() })
        .from(workspaceComputerCredentials)
        .innerJoin(workspaceComputers, eq(workspaceComputers.id, workspaceComputerCredentials.workspaceComputerId))
        .where(
          and(eq(workspaceComputers.workspaceId, scope.workspaceId), isNull(workspaceComputerCredentials.revokedAt)),
        ),
    );
    const usableCodes = await this.#count(
      executor
        .select({ value: count() })
        .from(computerConnectCodes)
        .where(
          and(
            eq(computerConnectCodes.workspaceId, scope.workspaceId),
            isNull(computerConnectCodes.consumedAt),
            isNull(computerConnectCodes.revokedAt),
            gt(computerConnectCodes.expiresAt, now),
          ),
        ),
    );
    if (remainingAgents + activeBindings + activeEnrollments + activeCredentials + usableCodes > 0) {
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

function ownershipInconsistent(message: string): OnboardingResetError {
  return new OnboardingResetError("ONBOARDING_RESET_OWNERSHIP_INCONSISTENT", 409, message);
}

function resourceNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
