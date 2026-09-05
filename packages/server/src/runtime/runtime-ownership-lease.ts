import type { Sql } from "postgres";

/** A stable namespace for the process-local runtime ownership contract. */
export const RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID = 8_621_303_412;

export type RuntimeOwnershipState = {
  mode: "single";
  status: "owned" | "not_owned";
  instanceId?: string;
};

export class RuntimeOwnershipLeaseError extends Error {
  readonly code = "RUNTIME_OWNER_LEASE_HELD" as const;

  constructor(instanceId: string) {
    super(
      `The OpenTag runtime ownership lease is already held by another live instance; instance ${instanceId} cannot start. ` +
        "Run this deployment with one Server replica, or design cross-instance owner routing before enabling replicas.",
    );
    this.name = "RuntimeOwnershipLeaseError";
  }
}

export interface RuntimeOwnershipLease {
  readonly instanceId: string;
  readonly state: RuntimeOwnershipState;
  release(): Promise<void>;
}

/**
 * Claim the process-local runtime owner on a dedicated PostgreSQL session.
 *
 * Advisory locks are session scoped. Reserving one connection prevents the normal pool from
 * moving the lock query to another session while the Server is running.
 */
export async function acquireRuntimeOwnershipLease(sql: Sql, instanceId: string): Promise<RuntimeOwnershipLease> {
  const connection = await sql.reserve();
  let acquired = false;
  try {
    const [result] = await connection<{ acquired: boolean }[]>`
      select pg_try_advisory_lock(${RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID}) as acquired
    `;
    acquired = result?.acquired === true;
    if (!acquired) throw new RuntimeOwnershipLeaseError(instanceId);

    let released = false;
    return {
      instanceId,
      state: { mode: "single", status: "owned", instanceId },
      async release() {
        if (released) return;
        released = true;
        try {
          await connection`
            select pg_advisory_unlock(${RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID})
          `;
        } finally {
          connection.release();
        }
      },
    };
  } catch (error) {
    if (acquired) {
      await connection`select pg_advisory_unlock(${RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID})`.catch(() => undefined);
    }
    connection.release();
    throw error;
  }
}
