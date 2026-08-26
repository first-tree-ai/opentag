import type { ChannelName } from "@opentag/shared";
import { and, count, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  agents,
  computerConnectCodes,
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

export interface OnboardingResetServiceOptions {
  agents: OnboardingResetAgentLifecycle;
  database: DatabaseClient;
  environment: ChannelName;
  /** The single staging Account this deployment may reset. */
  labAccountId: string;
  now?: () => Date;
  registry?: OnboardingResetConnectionRegistry;
  workspaceAdmins?: WorkspaceAdminAccess;
}

/**
 * Staging-only orchestration that returns one configured Account to a first-run state.
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
  readonly #agents: OnboardingResetAgentLifecycle;
  readonly #database: DatabaseClient;
  readonly #environment: ChannelName;
  readonly #labAccountId: string;
  readonly #now: () => Date;
  readonly #registry: OnboardingResetConnectionRegistry | undefined;
  readonly #workspaceAdmins: WorkspaceAdminAccess;

  constructor(options: OnboardingResetServiceOptions) {
    this.#agents = options.agents;
    this.#database = options.database;
    this.#environment = options.environment;
    this.#labAccountId = options.labAccountId;
    this.#now = options.now ?? (() => new Date());
    this.#registry = options.registry;
    this.#workspaceAdmins = options.workspaceAdmins ?? new WorkspaceAdminAccess(options.database, { now: options.now });
  }

  /** Whether this Account may use the staging Onboarding Lab at all. */
  allows(accountId: string): boolean {
    return this.#environment === "staging" && accountId === this.#labAccountId;
  }

  async resetOnboarding(accountId: string): Promise<void> {
    // Re-confirm the configured environment and Account before any mutation.
    if (!this.allows(accountId)) throw resourceNotFound();
    const scope = await this.#resolveOwnedScope(accountId);

    await this.#deleteOwnedAgents(accountId, scope);
    const enrollmentIds = await this.#revokeComputerAccess(accountId, scope);
    for (const enrollmentId of enrollmentIds) {
      await this.#registry?.closeEnrollment(enrollmentId);
    }
    await this.#verifyCleanedUp(scope);
    await this.#clearSetupCompletion(scope);
  }

  /**
   * Resolves the one resource scope the Account directly owns, and refuses to proceed when that
   * ownership is not exclusive. A shared or missing scope is never reset.
   */
  async #resolveOwnedScope(accountId: string): Promise<{ workspaceId: string }> {
    const owned = await this.#workspaceAdmins.listActiveAdminWorkspaces(accountId);
    const [scope, ...others] = owned;
    if (!scope || others.length > 0) {
      throw new OnboardingResetError(
        "ONBOARDING_RESET_OWNERSHIP_INCONSISTENT",
        409,
        "The Lab Account does not own exactly one active OpenTag resource scope",
      );
    }
    const [{ admins } = { admins: 0 }] = await this.#database
      .select({ admins: count() })
      .from(workspaceAdminGrants)
      .where(and(eq(workspaceAdminGrants.workspaceId, scope.workspaceId), isNull(workspaceAdminGrants.revokedAt)));
    if (admins !== 1) {
      throw new OnboardingResetError(
        "ONBOARDING_RESET_OWNERSHIP_INCONSISTENT",
        409,
        "The Lab Account resource scope is not owned exclusively by the Lab Account",
      );
    }
    return { workspaceId: scope.workspaceId };
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
        .update(workspaceComputers)
        .set({
          revokedByUserId: accountId,
          revokedAt: now,
          currentInstanceId: null,
          connectedAt: null,
          updatedAt: now,
        })
        .where(and(inArray(workspaceComputers.id, enrollmentIds), isNull(workspaceComputers.revokedAt)));
      return enrollmentIds;
    });
  }

  /** Re-reads authoritative facts; a retained historical row must never satisfy an active fact. */
  async #verifyCleanedUp(scope: { workspaceId: string }): Promise<void> {
    const now = this.#now();
    const [remainingAgents, activeBindings, activeEnrollments, activeCredentials, usableCodes] = await Promise.all([
      this.#count(
        this.#database
          .select({ value: count() })
          .from(agents)
          .where(and(eq(agents.workspaceId, scope.workspaceId), ne(agents.status, "deleted"))),
      ),
      this.#count(
        this.#database
          .select({ value: count() })
          .from(imBindings)
          .innerJoin(agents, eq(agents.id, imBindings.agentId))
          .where(and(eq(agents.workspaceId, scope.workspaceId), ne(imBindings.status, "disabled"))),
      ),
      this.#count(
        this.#database
          .select({ value: count() })
          .from(workspaceComputers)
          .where(and(eq(workspaceComputers.workspaceId, scope.workspaceId), isNull(workspaceComputers.revokedAt))),
      ),
      this.#count(
        this.#database
          .select({ value: count() })
          .from(workspaceComputerCredentials)
          .innerJoin(workspaceComputers, eq(workspaceComputers.id, workspaceComputerCredentials.workspaceComputerId))
          .where(
            and(eq(workspaceComputers.workspaceId, scope.workspaceId), isNull(workspaceComputerCredentials.revokedAt)),
          ),
      ),
      this.#count(
        this.#database
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
      ),
    ]);
    if (remainingAgents + activeBindings + activeEnrollments + activeCredentials + usableCodes > 0) {
      throw new OnboardingResetError(
        "ONBOARDING_RESET_UNVERIFIED",
        409,
        "The Account still has active OpenTag resources after cleanup; retry the reset",
      );
    }
  }

  /** The final commit marker: only a verified Account is allowed back into onboarding. */
  async #clearSetupCompletion(scope: { workspaceId: string }): Promise<void> {
    const now = this.#now();
    await this.#database
      .update(workspaces)
      .set({ setupCompletedAt: null, updatedAt: now })
      .where(eq(workspaces.id, scope.workspaceId));
  }

  async #count(query: PromiseLike<{ value: number }[]>): Promise<number> {
    const [row] = await query;
    return row?.value ?? 0;
  }
}

function resourceNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
