import { connect as connectSocket, createServer, type Server, type Socket } from "node:net";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql as drizzleSql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { DatabaseQueryTimeoutError } from "../../db/query-deadline.js";
import { createDedicatedDatabaseReadinessProbe } from "../../db/readiness-probe.js";
import { startPostgresTestContainer } from "./postgres-test-container.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const deadlineErrorOf = (error: unknown): unknown => {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if (current instanceof DatabaseQueryTimeoutError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return current;
};

/**
 * TCP proxy in front of PostgreSQL. `goDark()` stops forwarding without closing anything, so both
 * peers stay open: the client can still write, and no answer ever comes back. That is the black hole
 * the deadline exists for; a closed socket would unblock the client all by itself.
 */
async function startBlackholeProxy(target: string) {
  const targetUrl = new URL(target);
  const sockets = new Set<Socket>();
  let dark = false;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const server: Server = createServer((incoming) => {
    const client = track(incoming);
    const upstream = track(connectSocket({ host: targetUrl.hostname, port: Number(targetUrl.port) }));
    if (dark) {
      client.pause();
      upstream.pause();
      return;
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return {
    url: url.toString(),
    goDark() {
      dark = true;
      for (const socket of sockets) socket.pause();
    },
    /** Stops forwarding and comes back, like a network blip that heals after the deadline fired. */
    heal() {
      dark = false;
      for (const socket of sockets) socket.resume();
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

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

  it("unblocks a transaction whose rollback cannot reach the server", async () => {
    const proxy = await startBlackholeProxy(url);
    const { database, sql } = createDatabaseClient(proxy.url, {
      max: 1,
      statementTimeoutMs: 10_000,
      queryTimeoutMs: 1_500,
    });
    try {
      await database.execute(drizzleSql`select 1`);
      const startedAt = performance.now();
      const failure = await database
        .transaction(async (tx) => {
          await tx.execute(drizzleSql`select 1`);
          proxy.goDark();
          // The transaction is open when the connection goes silent, so the rollback postgres.js
          // runs after this rejection is queued behind a socket that never answers.
          await tx.execute(drizzleSql`select 1`);
        })
        .catch((error: unknown) => error);
      const elapsedMs = performance.now() - startedAt;

      expect(deadlineErrorOf(failure)).toBeInstanceOf(DatabaseQueryTimeoutError);
      expect(elapsedMs).toBeLessThan(6_000);
    } finally {
      await sql.end({ timeout: 1 });
      await proxy.stop();
    }
  });

  it("unblocks a transaction whose commit cannot reach the server", async () => {
    const proxy = await startBlackholeProxy(url);
    const { database, sql } = createDatabaseClient(proxy.url, {
      max: 1,
      statementTimeoutMs: 10_000,
      queryTimeoutMs: 1_500,
    });
    try {
      await database.execute(drizzleSql`select 1`);
      const startedAt = performance.now();
      const failure = await database
        .transaction(async (tx) => {
          await tx.execute(drizzleSql`select 1`);
          proxy.goDark();
          return "committed";
        })
        .catch((error: unknown) => error);
      const elapsedMs = performance.now() - startedAt;

      expect(failure).toBeInstanceOf(DatabaseQueryTimeoutError);
      expect(elapsedMs).toBeLessThan(6_000);
    } finally {
      await sql.end({ timeout: 1 });
      await proxy.stop();
    }
  });

  it("unblocks a nested transaction whose opening savepoint cannot reach the server", async () => {
    const proxy = await startBlackholeProxy(url);
    const { database, sql } = createDatabaseClient(proxy.url, {
      max: 1,
      statementTimeoutMs: 10_000,
      queryTimeoutMs: 1_500,
    });
    try {
      await database.execute(drizzleSql`select 1`);
      const startedAt = performance.now();
      const failure = await database
        .transaction(async (tx) => {
          await tx.execute(drizzleSql`select 1`);
          proxy.goDark();
          // drizzle opens the nested transaction with `savepoint <name>` before it enters the
          // callback, so a silent connection there holds the whole chain open.
          await tx.transaction(async (inner) => {
            await inner.execute(drizzleSql`select 1`);
          });
        })
        .catch((error: unknown) => error);
      const elapsedMs = performance.now() - startedAt;

      expect(deadlineErrorOf(failure)).toBeInstanceOf(DatabaseQueryTimeoutError);
      expect(elapsedMs).toBeLessThan(6_000);
    } finally {
      await sql.end({ timeout: 1 });
      await proxy.stop();
    }
  });

  it("never runs a nested callback that a healed connection delivers after the deadline", async () => {
    const proxy = await startBlackholeProxy(url);
    const { database, sql } = createDatabaseClient(proxy.url, {
      max: 1,
      statementTimeoutMs: 10_000,
      queryTimeoutMs: 1_500,
    });
    const observer = createDatabaseClient(url, { max: 1 });
    try {
      await observer.database.execute(drizzleSql`drop table if exists pr999_ghost`);
      await observer.database.execute(drizzleSql`create table pr999_ghost (v text)`);
      await database.execute(drizzleSql`select 1`);

      let innerRan = false;
      const failure = await database
        .transaction(async (tx) => {
          await tx.execute(drizzleSql`select 1`);
          proxy.goDark();
          await tx.transaction(async (inner) => {
            innerRan = true;
            await inner.execute(drizzleSql`insert into pr999_ghost values ('ghost')`);
          });
        })
        .catch((error: unknown) => error);

      expect(deadlineErrorOf(failure)).toBeInstanceOf(DatabaseQueryTimeoutError);
      expect(innerRan).toBe(false);

      // The caller already gave up. Resuming the socket must not let postgres.js enter the nested
      // callback, whose insert would autocommit after the outer rollback was queued.
      proxy.heal();
      await sleep(2_500);
      const [row] = await observer.database.execute<{ count: number }>(
        drizzleSql`select count(*)::int as count from pr999_ghost`,
      );

      expect(innerRan).toBe(false);
      expect(row?.count).toBe(0);
    } finally {
      await sql.end({ timeout: 1 });
      await observer.sql.end({ timeout: 1 });
      await proxy.stop();
    }
  }, 30_000);
});
