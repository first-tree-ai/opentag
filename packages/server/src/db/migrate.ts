import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { applyQueryDeadline } from "./query-deadline.js";
import { DATABASE_CLOSE_TIMEOUT_SECONDS, MIGRATION_TIMEOUTS, MIGRATION_VERIFICATION_TIMEOUT_MS } from "./timeouts.js";

export const MIGRATION_ADVISORY_LOCK_ID = 8_621_303_411;

export type MigrationVerificationReason = "behind" | "diverged" | "empty" | "unreachable";

export class MigrationVerificationError extends Error {
  constructor(
    readonly reason: MigrationVerificationReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationVerificationError";
  }
}

export class DatabaseStartupTimeoutError extends Error {
  constructor(
    readonly operation: "migration" | "verification",
    readonly timeoutMs: number,
  ) {
    super(`Database ${operation} exceeded the ${timeoutMs}ms startup budget`);
    this.name = "DatabaseStartupTimeoutError";
  }
}

async function withStartupConnection<T>(
  databaseUrl: string,
  operation: "migration" | "verification",
  run: (sql: Sql) => Promise<T>,
): Promise<T> {
  let closing = false;
  const connection = {
    statement_timeout: MIGRATION_TIMEOUTS.statementMs,
    lock_timeout: MIGRATION_TIMEOUTS.lockMs,
    idle_in_transaction_session_timeout: MIGRATION_TIMEOUTS.transactionMs,
    idle_session_timeout: MIGRATION_TIMEOUTS.operationMs,
  };
  const startupUrl = new URL(databaseUrl);
  for (const parameter of [...Object.keys(connection), "transaction_timeout"])
    startupUrl.searchParams.delete(parameter);
  const sql = postgres(startupUrl.toString(), {
    max: 1,
    connect_timeout: MIGRATION_TIMEOUTS.connectSeconds,
    connection,
    onnotice: () => undefined,
    // A replacement session cannot inherit the migration's advisory lock.
    onclose: () => {
      if (!closing) void sql.end({ timeout: 0 });
    },
  });
  applyQueryDeadline(sql, { timeoutMs: MIGRATION_TIMEOUTS.statementMs + 1_000 });
  let timeoutMs: number =
    operation === "migration" ? MIGRATION_TIMEOUTS.operationMs : MIGRATION_VERIFICATION_TIMEOUT_MS;
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire!: () => void;
  const armDeadline = () => {
    clearTimeout(timer);
    timer = setTimeout(expire, Math.max(0, timeoutMs - (performance.now() - startedAt)));
  };
  const deadline = new Promise<never>((_, reject) => {
    expire = () => {
      closing = true;
      void sql.end({ timeout: 0 });
      reject(new DatabaseStartupTimeoutError(operation, timeoutMs));
    };
    armDeadline();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const [version] = await sql<{ server_version_num: string }[]>`show server_version_num`;
        if (Number(version?.server_version_num) >= 170000) {
          await sql`select set_config('transaction_timeout', ${String(MIGRATION_TIMEOUTS.transactionMs)}, false)`;
        } else {
          timeoutMs = Math.min(timeoutMs, MIGRATION_TIMEOUTS.transactionMs);
          armDeadline();
        }
        return run(sql);
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    closing = true;
    await sql.end({ timeout: DATABASE_CLOSE_TIMEOUT_SECONDS });
  }
}

export async function withMigrationLock<T>(sql: Sql, operation: () => Promise<T>): Promise<T> {
  await sql`select pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    result = { ok: true, value: await operation() };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    await sql`select pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
  } catch (error) {
    if (!result.ok) {
      throw new AggregateError([result.error, error], "Migration failed and its lock could not be released", {
        cause: result.error,
      });
    }
    throw error;
  }
  if (!result.ok) throw result.error;
  return result.value;
}

export async function migrateDatabase(databaseUrl: string, migrationsFolder: string): Promise<void> {
  await withStartupConnection(databaseUrl, "migration", async (sql) => {
    const database = drizzle(sql);
    await withMigrationLock(sql, async () => {
      await migrate(database, { migrationsFolder });
    });
  });
}

export async function verifyDatabaseMigrations(databaseUrl: string, migrationsFolder: string): Promise<void> {
  const expectedMigrations = readMigrationFiles({ migrationsFolder });
  try {
    await withStartupConnection(databaseUrl, "verification", async (sql) => {
      await sql`select 1`;
      const [relation] = await sql<{ migration_table: string | null }[]>`
      select to_regclass('drizzle.__drizzle_migrations')::text as migration_table
    `;
      if (!relation?.migration_table) {
        throw new MigrationVerificationError("empty", "The database has not been migrated");
      }

      const appliedMigrations = await sql<{ created_at: string; hash: string }[]>`
      select hash, created_at
      from drizzle.__drizzle_migrations
      order by created_at asc
    `;
      if (appliedMigrations.length < expectedMigrations.length) {
        throw new MigrationVerificationError("behind", "The database is behind the checked-in migrations");
      }
      if (appliedMigrations.length > expectedMigrations.length) {
        throw new MigrationVerificationError("diverged", "The database has migrations unknown to this server build");
      }

      const mismatch = expectedMigrations.some((expected, index) => {
        const applied = appliedMigrations[index];
        return !applied || applied.hash !== expected.hash || Number(applied.created_at) !== expected.folderMillis;
      });
      if (mismatch) {
        throw new MigrationVerificationError("diverged", "The database migration history does not match this build");
      }
    });
  } catch (error) {
    if (error instanceof MigrationVerificationError) {
      throw error;
    }
    throw new MigrationVerificationError("unreachable", "The database migration state could not be verified", {
      cause: error,
    });
  }
}
