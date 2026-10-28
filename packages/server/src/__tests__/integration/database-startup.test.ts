import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_ADVISORY_LOCK_ID, migrateDatabase, verifyDatabaseMigrations } from "../../db/migrate.js";
import { DatabaseQueryTimeoutError } from "../../db/query-deadline.js";
import { startPostgresTestContainer } from "./postgres-test-container.js";
import { startDatabaseFaultProxy } from "./support/postgres-fault-proxy.js";

function causeWith(error: unknown, key: string, value: unknown): unknown {
  let current = error;
  for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
    if ((current as Record<string, unknown>)[key] === value) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.each([17, 16])("PostgreSQL %i startup migration budgets", (version) => {
  let container: StartedPostgreSqlContainer;
  let admin: ReturnType<typeof postgres>;
  let folder: string;
  const migrations = fileURLToPath(new URL("../../../drizzle", import.meta.url));
  beforeAll(async () => {
    container = await startPostgresTestContainer(`postgres:${version}-alpine`);
    admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => undefined });
    folder = await mkdtemp(join(tmpdir(), "opentag-startup-budget-"));
    await mkdir(join(folder, "meta"));
    await writeFile(
      join(folder, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1, tag: "0000_budget", breakpoints: true }],
      }),
    );
  }, 120_000);
  beforeEach(async () => {
    await admin`drop schema if exists drizzle cascade`;
  });
  afterAll(async () => {
    await admin?.end({ timeout: 1 });
    await container?.stop();
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  it("applies the short native limits even if URL parameters try to disable them", async () => {
    await writeFile(
      join(folder, "0000_budget.sql"),
      `create table startup_settings as select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock, current_setting('transaction_timeout', true) as transaction, current_setting('idle_in_transaction_session_timeout') as idle`,
    );
    const url = new URL(container.getConnectionUri());
    for (const parameter of [
      "statement_timeout",
      "lock_timeout",
      "transaction_timeout",
      "idle_in_transaction_session_timeout",
    ])
      url.searchParams.set(parameter, "0");
    await migrateDatabase(url.toString(), folder);
    const [row] = await admin`select * from startup_settings`;
    expect(row).toEqual({ statement: "5s", lock: "2s", transaction: version >= 17 ? "10s" : null, idle: "10s" });
    await verifyDatabaseMigrations(container.getConnectionUri(), folder);
  });

  it("fails within the short advisory-lock wait without running migration SQL", async () => {
    await admin`select pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;
    const started = performance.now();
    try {
      const failure = await migrateDatabase(container.getConnectionUri(), migrations).then(
        () => undefined,
        (error) => error,
      );
      expect(causeWith(failure, "code", "55P03")).toBeDefined();
      expect(performance.now() - started).toBeLessThan(4000);
      const [row] = await admin`select to_regclass('drizzle.__drizzle_migrations') as ledger`;
      expect(row?.ledger).toBeNull();
    } finally {
      await admin`select pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
    }
  }, 5000);

  it("cancels a slow statement and rolls back its preceding schema change", async () => {
    await writeFile(
      join(folder, "0000_budget.sql"),
      "create table startup_statement_rollback (value int);--> statement-breakpoint\nselect pg_sleep(20)",
    );
    const started = performance.now();
    const failure = await migrateDatabase(container.getConnectionUri(), folder).then(
      () => undefined,
      (error) => error,
    );
    expect(causeWith(failure, "code", "57014")).toBeDefined();
    expect(performance.now() - started).toBeLessThan(7000);
    const [row] = await admin`select to_regclass('startup_statement_rollback') as relation`;
    expect(row?.relation).toBeNull();
  }, 8000);

  it("caps the entire transaction even when each individual statement is short", async () => {
    await writeFile(
      join(folder, "0000_budget.sql"),
      "create table startup_transaction_rollback (value int);--> statement-breakpoint\n" +
        Array(4).fill("select pg_sleep(3)").join(";--> statement-breakpoint\n"),
    );
    const started = performance.now();
    await expect(migrateDatabase(container.getConnectionUri(), folder)).rejects.toBeDefined();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThan(9000);
    expect(elapsed).toBeLessThan(13000);
    const [row] = await admin`select to_regclass('startup_transaction_rollback') as relation`;
    expect(row?.relation).toBeNull();
  }, 15000);

  for (const mode of ["migration", "verification"] as const) {
    it(`reclaims a silent established ${mode} connection without replaying startup work`, async () => {
      const proxy = await startDatabaseFaultProxy(container.getConnectionUri(), true);
      const started = performance.now();
      const outcome = (
        mode === "migration" ? migrateDatabase(proxy.url, migrations) : verifyDatabaseMigrations(proxy.url, migrations)
      ).then(
        () => undefined,
        (error) => error,
      );
      try {
        await proxy.handshake;
        const original = [...proxy.connections];
        expect(original).toHaveLength(1);
        const failure = await outcome;
        expect(causeWith(failure, "name", DatabaseQueryTimeoutError.name)).toBeDefined();
        expect(performance.now() - started).toBeLessThan(8000);
        await expect.poll(() => original[0]?.clientEnded).toBe(true);
        const [row] = await admin`select to_regclass('drizzle.__drizzle_migrations') as ledger`;
        expect(row?.ledger).toBeNull();
        expect([...proxy.connections].every((connection) => original.includes(connection))).toBe(true);
      } finally {
        await proxy.close();
        await outcome;
      }
    }, 10000);
  }
});
