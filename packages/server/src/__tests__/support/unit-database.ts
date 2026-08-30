/**
 * An in-process PostgreSQL for unit tests.
 *
 * The services in `src/services` and `src/runtime` speak Drizzle against a real PostgreSQL dialect:
 * CTEs, `on conflict`, partial indexes, `for update`, transaction rollback. Faking that surface with
 * hand-rolled query-builder stubs tests the stub rather than the service, so these suites run against
 * PGlite instead — the genuine PostgreSQL engine compiled to WebAssembly, embedded in the test
 * process. It needs no Docker daemon, no listening port, and no external service, which keeps unit
 * tests inside the constraint that they must not depend on a running PostgreSQL instance.
 *
 * The checked-in Drizzle migrations are the schema source of truth here, exactly as in production, so
 * a migration that has not been generated fails these tests instead of silently diverging.
 *
 * Booting an instance and replaying every migration costs a few seconds, so a suite should create one
 * database in `beforeAll` and call `reset()` between tests rather than creating one per test.
 */

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DatabaseClient } from "../../db/client.js";
import * as schema from "../../db/schema/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

export interface UnitDatabase {
  /**
   * A Drizzle client over the embedded engine, typed as the `postgres-js` client the services accept.
   *
   * The two drivers expose the same query-builder surface; they differ only in the connection they
   * carry, which no service touches. The cast keeps every service callable from a test without
   * widening its production signature to accommodate a test driver.
   */
  readonly database: DatabaseClient;
  /** The raw engine, for the rare assertion that needs SQL the query builder cannot express. */
  readonly engine: PGlite;
  /** Truncates every application table and restarts identity sequences. Keeps the migration ledger. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createUnitDatabase(): Promise<UnitDatabase> {
  const engine = new PGlite();
  const database = drizzle(engine, { schema });

  try {
    await migrate(database, { migrationsFolder });
  } catch (error) {
    await engine.close();
    throw error;
  }

  return {
    close: () => engine.close(),
    database: database as unknown as DatabaseClient,
    engine,
    reset: () => truncateApplicationTables(engine),
  };
}

/**
 * `drizzle.__drizzle_migrations` lives outside `public`, so truncating `public` alone leaves the
 * ledger intact and the database stays migrated across resets.
 */
async function truncateApplicationTables(engine: PGlite): Promise<void> {
  await engine.exec(`
    do $$
    declare
      table_list text;
    begin
      select string_agg(format('%I.%I', schemaname, tablename), ', ')
      into table_list
      from pg_tables
      where schemaname = 'public';

      if table_list is not null then
        execute 'truncate table ' || table_list || ' restart identity cascade';
      end if;
    end $$;
  `);
}
