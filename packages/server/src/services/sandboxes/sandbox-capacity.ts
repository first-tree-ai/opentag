import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, computers, imBindings, sandboxes, sessions } from "../../db/schema/index.js";

/**
 * E9 resource admission for Cloud Runner allocations: per-Account and platform-wide ceilings on
 * occupied Instances, charged exactly once per brand-new generation reservation inside
 * `startForAccount`'s reservation transaction. Logical Agent/Session/Sandbox counts stay unlimited.
 */

/** Lifecycles that physically occupy one Instance slot until verified absence. */
export const CLOUD_CAPACITY_OCCUPIED_LIFECYCLES = ["preparing", "ready", "releasing"] as const;

export interface CloudCapacityLimits {
  /** Maximum occupied Instances for one Account. */
  accountLimit: number;
  /** Maximum occupied Instances for the whole platform (this deployment's project/region). */
  platformLimit: number;
}

/** Conservative initial operating parameters (a parent task plus two children in parallel). */
export const DEFAULT_CLOUD_CAPACITY_LIMITS: CloudCapacityLimits = { accountLimit: 3, platformLimit: 20 };

/** Validate configured ceilings; a misconfigured deployment fails closed at construction time. */
export function normalizeCloudCapacityLimits(input?: CloudCapacityLimits): CloudCapacityLimits {
  const limits = input ?? DEFAULT_CLOUD_CAPACITY_LIMITS;
  if (!Number.isSafeInteger(limits.accountLimit) || limits.accountLimit < 1) {
    throw new Error("SandboxRunnerService requires a positive capacity accountLimit");
  }
  if (!Number.isSafeInteger(limits.platformLimit) || limits.platformLimit < 1) {
    throw new Error("SandboxRunnerService requires a positive capacity platformLimit");
  }
  return { accountLimit: limits.accountLimit, platformLimit: limits.platformLimit };
}

/**
 * One occupied slot. The schema has no constraint equating lifecycle and resource identity, so a
 * tracked resource reference OR an occupied lifecycle each retain the slot on their own.
 */
export const occupiedSandbox: SQL<boolean> = sql<boolean>`(${sandboxes.currentResourceName} is not null or ${inArray(
  sandboxes.lifecycle,
  [...CLOUD_CAPACITY_OCCUPIED_LIFECYCLES],
)})`;

/** Transaction-scoped admission lock key; released automatically at commit/rollback. */
const CAPACITY_ADVISORY_LOCK_KEY = "opentag:cloud-runner-capacity";

/** Serialize every new physical reservation; MUST be the reservation transaction's first lock. */
export async function lockCloudCapacityAdmission(transaction: DatabaseTransaction): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${CAPACITY_ADVISORY_LOCK_KEY}, 0))`);
}

export interface CloudCapacityOccupancy {
  /** Occupied Instances owned by the Account (any authority state, counted until verified absence). */
  accountUsed: number;
  /** Occupied Instances across the whole platform. */
  platformUsed: number;
}

/**
 * The count invariant: every `occupiedSandbox` row holds its slot — committed or unknown create,
 * ready, save-failed and delete-unconfirmed alike, whatever the Agent/Session/Account authority
 * state — and only verified absence frees it. All rows in this database belong to the single
 * configured project/region of this deployment, so the platform scope needs no name filter.
 */
export async function countCloudCapacityOccupancy(
  executor: DatabaseClient | DatabaseTransaction,
  accountId: string,
): Promise<CloudCapacityOccupancy> {
  const [accountRow] = await executor
    .select({ used: sql<number>`count(*)::int` })
    .from(sandboxes)
    .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .innerJoin(computers, eq(computers.id, agents.computerId))
    .where(and(eq(computers.ownerAccountId, accountId), eq(computers.kind, "cloud"), occupiedSandbox));
  const [platformRow] = await executor
    .select({ used: sql<number>`count(*)::int` })
    .from(sandboxes)
    .where(occupiedSandbox);
  return { accountUsed: accountRow?.used ?? 0, platformUsed: platformRow?.used ?? 0 };
}

/** Verdict for ONE new reservation; the Account scope is reported first when both are exhausted. */
export function cloudCapacityAdmission(
  occupancy: CloudCapacityOccupancy,
  limits: CloudCapacityLimits,
): { admitted: true } | { admitted: false; scope: "account" | "platform" } {
  if (occupancy.accountUsed >= limits.accountLimit) return { admitted: false, scope: "account" };
  if (occupancy.platformUsed >= limits.platformLimit) return { admitted: false, scope: "platform" };
  return { admitted: true };
}
