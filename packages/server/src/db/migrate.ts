import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

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

export async function withMigrationLock<T>(sql: Sql, operation: () => Promise<T>): Promise<T> {
  await sql`select pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;
  try {
    return await operation();
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
  }
}

export async function migrateDatabase(databaseUrl: string, migrationsFolder: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const database = drizzle(sql);

  try {
    await withMigrationLock(sql, async () => {
      await migrate(database, { migrationsFolder });
    });
  } finally {
    await sql.end();
  }
}

export async function verifyDatabaseMigrations(databaseUrl: string, migrationsFolder: string): Promise<void> {
  const expectedMigrations = readMigrationFiles({ migrationsFolder });
  const sql = postgres(databaseUrl, { connect_timeout: 5, max: 1, onnotice: () => undefined });

  try {
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
  } catch (error) {
    if (error instanceof MigrationVerificationError) {
      throw error;
    }
    throw new MigrationVerificationError("unreachable", "The database migration state could not be verified", {
      cause: error,
    });
  } finally {
    await sql.end();
  }
}
