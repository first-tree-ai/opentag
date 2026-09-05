import postgres, { type Sql } from "postgres";

/** A stable namespace for the process-local runtime ownership contract. */
export const RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID = 8_621_303_412;
export const DEFAULT_RUNTIME_OWNERSHIP_ACQUIRE_TIMEOUT_MS = 30_000;

const DEFAULT_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 1_000;
const RUNTIME_OWNERSHIP_APPLICATION_NAME = "opentag-runtime-ownership";

type RuntimeOwnershipConnection = Awaited<ReturnType<Sql["reserve"]>>;
type RuntimeOwnershipClient = ReturnType<typeof postgres>;

type RuntimeOwnershipContext = {
  state: RuntimeOwnershipState;
  connectionLost: boolean;
  acquired: boolean;
};

export type RuntimeOwnershipState = {
  mode: "single";
  status: "owned" | "not_owned";
  instanceId?: string;
};

export interface RuntimeOwnershipLeaseOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
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
  };
  const client = createLeaseClient(databaseUrl, context);
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
        context.state = { mode: "single", status: "not_owned" };
        const failure = await closeLeaseResources(client, connection, context, true);
        if (failure) throw failure;
      },
    };
  } catch (error) {
    context.state = { mode: "single", status: "not_owned" };
    await closeLeaseResources(client, connection, context, true);
    throw error;
  }
}

function resolveLeaseOptions(options: RuntimeOwnershipLeaseOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_OWNERSHIP_ACQUIRE_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("The runtime ownership acquisition timeout must be a non-negative integer");
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new RangeError("The runtime ownership retry delay must be a non-negative integer");
  }
  return {
    timeoutMs,
    retryDelayMs,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? defaultSleep,
  };
}

function createLeaseClient(databaseUrl: string, context: RuntimeOwnershipContext): RuntimeOwnershipClient {
  return postgres(databaseUrl, {
    max: 1,
    onnotice: () => undefined,
    onclose: () => {
      context.connectionLost = true;
      context.state = { mode: "single", status: "not_owned" };
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
): Promise<unknown> {
  let failure: unknown;
  if (connection) {
    if (unlock && context.acquired && !context.connectionLost) {
      try {
        await connection`select pg_advisory_unlock(${RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID})`;
      } catch (error) {
        failure = error;
      }
    }
    try {
      connection.release();
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    await client.end();
  } catch (error) {
    failure ??= error;
  }
  return failure;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
