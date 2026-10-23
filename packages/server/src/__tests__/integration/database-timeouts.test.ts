import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql as drizzleSql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { DatabaseQueryTimeoutError } from "../../db/query-deadline.js";
import { createDedicatedDatabaseReadinessProbe } from "../../db/readiness-probe.js";
import { startPostgresTestContainer } from "./postgres-test-container.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("database timeouts", () => {
  let container: StartedPostgreSqlContainer;
  let url: string;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    url = container.getConnectionUri();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("applies the configured session timeouts to every pool connection", async () => {
    const { sql } = createDatabaseClient(url, {
      statementTimeoutMs: 4_000,
      queryTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 6_000,
    });
    try {
      const [statement] = await sql`show statement_timeout`;
      const [idle] = await sql`show idle_in_transaction_session_timeout`;
      expect(statement?.statement_timeout).toBe("4s");
      expect(idle?.idle_in_transaction_session_timeout).toBe("6s");
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("lets the server cancel a statement that exceeds statement_timeout", async () => {
    const { database, sql } = createDatabaseClient(url, { statementTimeoutMs: 1_000, queryTimeoutMs: 5_000 });
    try {
      await expect(database.execute(drizzleSql`select pg_sleep(3)`)).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "57014" }),
      });
      await expect(database.execute(drizzleSql`select 1 as ok`)).resolves.toBeDefined();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rejects at the client deadline and keeps the pool usable", async () => {
    const timeouts: number[] = [];
    const { database, sql } = createDatabaseClient(url, {
      max: 2,
      statementTimeoutMs: 10_000,
      queryTimeoutMs: 1_500,
      onQueryTimeout: ({ timeoutMs }) => timeouts.push(timeoutMs),
    });
    try {
      const startedAt = performance.now();
      const failure = await database.execute(drizzleSql`select pg_sleep(5)`).catch((error: unknown) => error);
      const elapsedMs = performance.now() - startedAt;

      const deadlineError =
        failure instanceof DatabaseQueryTimeoutError ? failure : (failure as { cause?: unknown }).cause;
      expect(deadlineError).toBeInstanceOf(DatabaseQueryTimeoutError);
      expect(elapsedMs).toBeLessThan(4_000);
      expect(timeouts).toEqual([1_500]);
      await expect(database.execute(drizzleSql`select 1 as ok`)).resolves.toBeDefined();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("bounds queries inside a drizzle transaction", async () => {
    const { database, sql } = createDatabaseClient(url, { statementTimeoutMs: 10_000, queryTimeoutMs: 1_500 });
    try {
      const failure = await database
        .transaction(async (tx) => {
          await tx.execute(drizzleSql`select pg_sleep(5)`);
        })
        .catch((error: unknown) => error);

      const deadlineError =
        failure instanceof DatabaseQueryTimeoutError ? failure : (failure as { cause?: unknown }).cause;
      expect(deadlineError).toBeInstanceOf(DatabaseQueryTimeoutError);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("terminates a session left idle inside a transaction", async () => {
    const { sql } = createDatabaseClient(url, { max: 1, idleInTransactionTimeoutMs: 1_000 });
    try {
      const failure = await sql
        .begin(async (tx) => {
          await tx`select 1`;
          await sleep(2_500);
          await tx`select 2`;
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      await expect(sql`select 1 as ok`).resolves.toHaveLength(1);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("probes readiness on its own connection", async () => {
    const probe = createDedicatedDatabaseReadinessProbe(url, { deadlineMs: 1_000 });
    try {
      await expect(probe.run()).resolves.toBeUndefined();
      await expect(probe.run()).resolves.toBeUndefined();
    } finally {
      await probe.close();
    }
  });
});
