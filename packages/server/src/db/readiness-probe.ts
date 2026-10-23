/**
 * Readiness probe on its own PostgreSQL connection.
 *
 * Invariant: every `run()` settles within `deadlineMs`, and the work behind it settles too. On the
 * deadline the probe connection is destroyed (`end({ timeout: 0 })`), which rejects the pending
 * `select 1`, and the next `run()` opens a fresh connection. A wedged socket therefore cannot hold a
 * probe attempt open, and probes never queue behind a saturated application pool.
 */
import postgres, { type Sql } from "postgres";

/** The `/readyz` deadline. The dedicated probe uses the same bound so each attempt settles inside it. */
export const DATABASE_READINESS_TIMEOUT_MS = 1_000;

export class DatabaseProbeTimeoutError extends Error {
  constructor(deadlineMs: number) {
    super(`Database readiness probe exceeded ${deadlineMs}ms`);
    this.name = "DatabaseProbeTimeoutError";
  }
}

export interface DedicatedReadinessProbeOptions {
  deadlineMs: number;
  log?: { debug: (fields: Record<string, unknown>, message: string) => void };
  /** Test seam; production uses postgres.js. */
  connect?: (databaseUrl: string, deadlineMs: number) => Sql;
}

export interface DedicatedReadinessProbe {
  run(): Promise<void>;
  close(): Promise<void>;
}

const PROBE_KEEP_ALIVE_SECONDS = 5;
const PROBE_IDLE_TIMEOUT_SECONDS = 30;

function connectProbe(databaseUrl: string, deadlineMs: number): Sql {
  return postgres(databaseUrl, {
    max: 1,
    // postgres.js takes whole seconds; one second is its smallest bound.
    connect_timeout: Math.max(1, Math.ceil(deadlineMs / 1_000)),
    idle_timeout: PROBE_IDLE_TIMEOUT_SECONDS,
    keep_alive: PROBE_KEEP_ALIVE_SECONDS,
    connection: { statement_timeout: deadlineMs },
    onnotice: () => undefined,
  });
}

export function createDedicatedDatabaseReadinessProbe(
  databaseUrl: string,
  options: DedicatedReadinessProbeOptions,
): DedicatedReadinessProbe {
  const connect = options.connect ?? connectProbe;
  let client: Sql | undefined;
  let closed = false;

  const destroy = (stale: Sql, reason: string) => {
    if (client === stale) client = undefined;
    options.log?.debug({ check: "database", reason }, "Destroying readiness probe connection");
    stale.end({ timeout: 0 }).catch(() => undefined);
  };

  return {
    async run() {
      if (closed) throw new Error("Database readiness probe is closed");
      if (!client) {
        client = connect(databaseUrl, options.deadlineMs);
        options.log?.debug({ check: "database" }, "Opened readiness probe connection");
      }
      const current = client;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          destroy(current, "deadline");
          reject(new DatabaseProbeTimeoutError(options.deadlineMs));
        }, options.deadlineMs);
      });
      const query = Promise.resolve(current`select 1`);
      try {
        await Promise.race([query, deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // The losing side of the race must not surface as an unhandled rejection.
        query.catch(() => undefined);
      }
    },
    async close() {
      closed = true;
      const current = client;
      client = undefined;
      if (current) await current.end({ timeout: 1 });
    },
  };
}
