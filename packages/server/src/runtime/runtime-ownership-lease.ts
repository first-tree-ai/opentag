import postgres, { type Sql } from "postgres";

/** A stable namespace for the process-local runtime ownership contract. */
export const RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID = 8_621_303_412;
export const DEFAULT_RUNTIME_OWNERSHIP_ACQUIRE_TIMEOUT_MS = 30_000;
export const DEFAULT_RUNTIME_OWNERSHIP_CLIENT_END_TIMEOUT_MS = 5_000;

const DEFAULT_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 1_000;
const RUNTIME_OWNERSHIP_APPLICATION_NAME = "opentag-runtime-ownership";

type RuntimeOwnershipConnection = Awaited<ReturnType<Sql["reserve"]>>;
type RuntimeOwnershipClient = ReturnType<typeof postgres>;

type RuntimeOwnershipContext = {
  state: RuntimeOwnershipState;
  connectionLost: boolean;
  acquired: boolean;
  released: boolean;
  lossReported: boolean;
};

export type RuntimeOwnershipState = {
  mode: "single";
  status: "owned" | "not_owned";
  instanceId?: string;
};

export interface RuntimeOwnershipLeaseOptions {
  /** Total unlock and client close budget, followed by a 100 ms timer grace period. */
  endTimeoutMs?: number;
  maxLifetimeSeconds?: number | null;
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  onLost?: () => void;
}

export class RuntimeOwnershipLeaseError extends Error {
  readonly code = "RUNTIME_OWNER_LEASE_HELD" as const;

  constructor(instanceId: string, timeoutMs = DEFAULT_RUNTIME_OWNERSHIP_ACQUIRE_TIMEOUT_MS) {
    super(
      `The OpenTag runtime ownership lease is already held by another live instance; instance ${instanceId} ` +
        `could not start after waiting ${timeoutMs} ms. Run this deployment with one Server replica, or design ` +
        "cross-instance owner routing before enabling replicas.",
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
 * Claim the process-local runtime owner on a dedicated PostgreSQL client.
 *
 * Advisory locks are session scoped. This client has exactly one connection and remains separate
 * from the application's pool for the lifetime of the lease, so pool reuse cannot silently drop ownership.
 */
export async function acquireRuntimeOwnershipLease(
  databaseUrl: string,
  instanceId: string,
  options: RuntimeOwnershipLeaseOptions = {},
): Promise<RuntimeOwnershipLease> {
  const acquireOptions = resolveLeaseOptions(options);
  const context: RuntimeOwnershipContext = {
    state: { mode: "single", status: "not_owned" },
    connectionLost: false,
    acquired: false,
    released: false,
    lossReported: false,
  };
  const client = createLeaseClient(databaseUrl, context, options.onLost, acquireOptions.maxLifetimeSeconds);
  let connection: RuntimeOwnershipConnection | undefined;

  try {
    connection = await client.reserve();
    await acquireLeaseOnConnection(connection, instanceId, acquireOptions, context);
    let released = false;
    return {
      instanceId,
      get state() {
        return context.state;
      },
      async release() {
        if (released) return;
        released = true;
        context.released = true;
        context.state = { mode: "single", status: "not_owned" };
        const failure = await closeLeaseResources(client, connection, context, true, acquireOptions.endTimeoutMs);
        if (failure) throw failure;
      },
    };
  } catch (error) {
    context.released = true;
    context.state = { mode: "single", status: "not_owned" };
    await closeLeaseResources(client, connection, context, true, acquireOptions.endTimeoutMs);
    throw error;
  }
}

function resolveLeaseOptions(options: RuntimeOwnershipLeaseOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_OWNERSHIP_ACQUIRE_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const endTimeoutMs = options.endTimeoutMs ?? DEFAULT_RUNTIME_OWNERSHIP_CLIENT_END_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("The runtime ownership acquisition timeout must be a non-negative integer");
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new RangeError("The runtime ownership retry delay must be a non-negative integer");
  }
  if (!Number.isInteger(endTimeoutMs) || endTimeoutMs < 1) {
    throw new RangeError("The runtime ownership client end timeout must be a positive integer");
  }
  const maxLifetimeSeconds = options.maxLifetimeSeconds ?? null;
  if (maxLifetimeSeconds !== null && (!Number.isInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 1)) {
    throw new RangeError("The runtime ownership client max lifetime must be a positive integer or null");
  }
  return {
    endTimeoutMs,
    maxLifetimeSeconds,
    timeoutMs,
    retryDelayMs,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? defaultSleep,
  };
}

function createLeaseClient(
  databaseUrl: string,
  context: RuntimeOwnershipContext,
  onLost?: () => void,
  maxLifetimeSeconds: number | null = null,
): RuntimeOwnershipClient {
  return postgres(databaseUrl, {
    max: 1,
    max_lifetime: maxLifetimeSeconds,
    onnotice: () => undefined,
    onclose: () => {
      if (context.released || context.lossReported) return;
      context.lossReported = true;
      context.connectionLost = true;
      context.state = { mode: "single", status: "not_owned" };
      try {
        onLost?.();
      } catch {
        // A loss notification must not prevent the client from being closed by the owner.
      }
    },
    connection: { application_name: RUNTIME_OWNERSHIP_APPLICATION_NAME },
  });
}

async function acquireLeaseOnConnection(
  connection: RuntimeOwnershipConnection,
  instanceId: string,
  options: ReturnType<typeof resolveLeaseOptions>,
  context: RuntimeOwnershipContext,
): Promise<void> {
  const deadline = options.now() + options.timeoutMs;
  let delayMs = options.retryDelayMs;

  while (true) {
    assertLeaseConnection(context);
    const [result] = await connection<{ acquired: boolean }[]>`
      select pg_try_advisory_lock(${RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID}) as acquired
    `;
    if (result?.acquired === true) {
      assertLeaseConnection(context);
      context.acquired = true;
      context.state = { mode: "single", status: "owned", instanceId };
      return;
    }

    const remainingMs = deadline - options.now();
    if (remainingMs <= 0) throw new RuntimeOwnershipLeaseError(instanceId, options.timeoutMs);
    await options.sleep(Math.min(delayMs, remainingMs));
    delayMs = Math.min(Math.max(delayMs * 2, options.retryDelayMs), MAX_RETRY_DELAY_MS);
  }
}

function assertLeaseConnection(context: RuntimeOwnershipContext): void {
  if (context.connectionLost) {
    throw new Error("The runtime ownership PostgreSQL connection was lost during startup");
  }
}

async function closeLeaseResources(
  client: RuntimeOwnershipClient,
  connection: RuntimeOwnershipConnection | undefined,
  context: RuntimeOwnershipContext,
  unlock: boolean,
  endTimeoutMs: number,
): Promise<unknown> {
  const deadline = performance.now() + endTimeoutMs;
  let failure: unknown;
  if (connection) {
    if (unlock && context.acquired && !context.connectionLost) {
      const unlockFailure = await unlockLeaseConnection(
        connection,
        RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID,
        Math.max(0, deadline - performance.now()),
      );
      failure = unlockFailure;
    }
    try {
      connection.release();
    } catch (error) {
      failure ??= error;
    }
  }
  const endFailure = await endLeaseClient(client, Math.max(0, deadline - performance.now()));
  failure ??= endFailure;
  return failure;
}

async function endLeaseClient(client: RuntimeOwnershipClient, timeoutMs: number): Promise<unknown> {
  // postgres.js accepts fractional seconds. Zero starts its close timeout immediately.
  // Do not round up the remaining budget; let its timer run before the 100 ms grace period ends.
  const timeoutSeconds = timeoutMs / 1_000;
  const waitMs = timeoutMs + 100;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs);
    timer.unref();
  });
  try {
    await Promise.race([client.end({ timeout: timeoutSeconds }), timeout]);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function unlockLeaseConnection(
  connection: RuntimeOwnershipConnection,
  lockId: number,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([connection`select pg_advisory_unlock(${lockId})`, timeout]);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
