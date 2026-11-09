import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql as query } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { BootstrapReadiness } from "../../bootstrap-readiness.js";
import { createDatabaseClient } from "../../db/client.js";
import { applyQueryDeadline, DatabaseQueryTimeoutError } from "../../db/query-deadline.js";
import {
  createApplicationDatabaseReadinessProbe,
  createDedicatedDatabaseReadinessProbe,
} from "../../db/readiness-probe.js";
import { startPostgresTestContainer } from "./postgres-test-container.js";
import { startDatabaseFaultProxy } from "./support/postgres-fault-proxy.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function deadlineOf(error: unknown): unknown {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
    if (cause instanceof DatabaseQueryTimeoutError) return cause;
    cause = (cause as { cause?: unknown }).cause;
  }
  return cause;
}

function isolateClosingTraffic(proxy: Awaited<ReturnType<typeof startDatabaseFaultProxy>>, mode: string) {
  if (mode === "blocked-query") {
    proxy.freeze();
    return;
  }
  for (const connection of proxy.connections) connection.blockClose = true;
}

describe("database availability after transport failure", () => {
  let container: StartedPostgreSqlContainer;
  beforeAll(async () => {
    container = await startPostgresTestContainer();
  }, 120_000);
  afterAll(async () => {
    await container?.stop();
  });

  it("reclaims all 20 application slots while the old TCP sessions remain black-holed", async () => {
    const proxy = await startDatabaseFaultProxy(container.getConnectionUri());
    const client = createDatabaseClient(proxy.url, { statementTimeoutMs: 1000, queryTimeoutMs: 2500 });
    const warmed = deferred(),
      release = deferred();
    const pids = new Set<number>();
    let callbacks = 0;
    const holding = Promise.all(
      Array.from({ length: 20 }, () =>
        client.database.transaction(async (tx) => {
          const [row] = await tx.execute<{ pid: number }>(query`select pg_backend_pid() as pid`);
          if (!row) throw new Error("Missing backend PID");
          pids.add(row.pid);
          if (pids.size === 20) warmed.resolve();
          await release.promise;
        }),
      ),
    );
    try {
      await warmed.promise;
      release.resolve();
      await holding;
      expect(pids.size).toBe(20);
      const frozen = proxy.freeze();
      expect(frozen).toHaveLength(20);
      const outcomes = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          client.database.transaction(async () => {
            callbacks++;
          }),
        ),
      );
      expect(
        outcomes.every(
          (outcome) => outcome.status === "rejected" && deadlineOf(outcome.reason) instanceof DatabaseQueryTimeoutError,
        ),
      ).toBe(true);
      expect(callbacks).toBe(0);
      const [replacement] = await client.database.execute<{ pid: number }>(query`select pg_backend_pid() as pid`);
      expect(pids.has(replacement?.pid ?? 0)).toBe(false);
      await expect.poll(() => frozen.every((connection) => connection.clientEnded)).toBe(true);
      expect(callbacks).toBe(0);
    } finally {
      release.resolve();
      await holding.catch(() => undefined);
      await client.sql.end({ timeout: 1 });
      await proxy.close();
    }
  }, 15_000);

  it("reclaims initialization after a multi-host deadline without replaying the expired write", async () => {
    const proxy = await startDatabaseFaultProxy(container.getConnectionUri(), true);
    const url = new URL(proxy.url);
    const multiHostUrl = proxy.url.replace(url.host, `${url.host},${url.host}`);
    const observer = createDatabaseClient(container.getConnectionUri());
    const client = createDatabaseClient(multiHostUrl, { max: 1, queryTimeoutMs: 300 });
    try {
      expect(client.sql.options.host).toEqual([url.hostname, url.hostname]);
      expect(client.sql.options.port).toEqual([Number(url.port), Number(url.port)]);
      await observer.sql`create table availability_multihost (value int)`;
      const failure = await client.database.execute(query`insert into availability_multihost values (1)`).then(
        () => undefined,
        (error) => error,
      );
      expect(deadlineOf(failure)).toBeInstanceOf(DatabaseQueryTimeoutError);
      await expect(client.database.execute(query`select 1`)).resolves.toBeDefined();
      const [row] = await observer.sql`select count(*)::int as count from availability_multihost`;
      expect(row?.count).toBe(0);
    } finally {
      await client.sql.end({ timeout: 1 });
      await observer.sql.end({ timeout: 1 });
      await proxy.close();
    }
  });

  it("retains normal multi-host failover while a query is still within its deadline", async () => {
    const proxy = await startDatabaseFaultProxy(container.getConnectionUri());
    const url = new URL(proxy.url);
    const multiHostUrl = proxy.url.replace(url.host, `${url.host},${url.host}`);
    proxy.refuseNextConnection();
    const client = createDatabaseClient(multiHostUrl, { max: 1, queryTimeoutMs: 2000 });
    try {
      expect(client.sql.options.host).toEqual([url.hostname, url.hostname]);
      expect(client.sql.options.port).toEqual([Number(url.port), Number(url.port)]);
      await expect(client.database.execute(query`select 1`)).resolves.toBeDefined();
    } finally {
      await client.sql.end({ timeout: 1 });
      await proxy.close();
    }
  });

  it("removes expired queued writes and BEGIN without destroying a healthy holder", async () => {
    const client = createDatabaseClient(container.getConnectionUri(), { max: 1, queryTimeoutMs: 250 });
    const held = deferred(),
      release = deferred();
    await client.sql`create table availability_queued (value int)`;
    let pid = 0,
      callbacks = 0;
    const holder = client.database.transaction(async (tx) => {
      const [row] = await tx.execute<{ pid: number }>(query`select pg_backend_pid() as pid`);
      if (!row) throw new Error("Missing backend PID");
      pid = row.pid;
      held.resolve();
      await release.promise;
    });
    try {
      await held.promise;
      const outcomes = await Promise.allSettled([
        client.database.execute(query`insert into availability_queued values (1)`),
        client.database.transaction(async () => {
          callbacks++;
        }),
      ]);
      expect(
        outcomes.every(
          (outcome) => outcome.status === "rejected" && deadlineOf(outcome.reason) instanceof DatabaseQueryTimeoutError,
        ),
      ).toBe(true);
      release.resolve();
      await holder;
      const [after] =
        await client.sql`select pg_backend_pid() as pid, (select count(*)::int from availability_queued) as count`;
      expect(after).toMatchObject({ pid, count: 0 });
      expect(callbacks).toBe(0);
    } finally {
      release.resolve();
      await holder.catch(() => undefined);
      await client.sql.end({ timeout: 1 });
    }
  });

  it("settles queued work on graceful close while an admitted transaction commits", async () => {
    const client = createDatabaseClient(container.getConnectionUri(), { max: 1 });
    const observer = createDatabaseClient(container.getConnectionUri());
    const held = deferred(),
      release = deferred();
    await observer.sql`create table availability_graceful (value int)`;
    const holder = client.database.transaction(async (tx) => {
      await tx.execute(query`insert into availability_graceful values (1)`);
      held.resolve();
      await release.promise;
    });
    try {
      await held.promise;
      let queuedFailure: unknown;
      const queued = client.database.execute(query`insert into availability_graceful values (2)`).catch((error) => {
        queuedFailure = error;
      });
      await Promise.resolve();
      await Promise.resolve();
      const closing = client.sql.end({ timeout: 0.5 });
      release.resolve();
      await holder;
      await closing;
      expect(
        (queuedFailure as { cause?: { code?: string } })?.cause?.code ?? (queuedFailure as { code?: string })?.code,
      ).toBe("CONNECTION_ENDED");
      await queued;
      const rows = await observer.sql`select value from availability_graceful`;
      expect(rows.map((row) => row.value)).toEqual([1]);
    } finally {
      release.resolve();
      await holder.catch(() => undefined);
      await client.sql.end({ timeout: 0.5 });
      await observer.sql.end({ timeout: 1 });
    }
  });

  it("leaves a committed write unrepeated when only its COMMIT acknowledgement is lost", async () => {
    const proxy = await startDatabaseFaultProxy(container.getConnectionUri());
    const client = createDatabaseClient(proxy.url, { max: 1, queryTimeoutMs: 500 });
    const observer = createDatabaseClient(container.getConnectionUri());
    await observer.sql`create table availability_commit (value int)`;
    let callbacks = 0;
    try {
      const failure = await client.database
        .transaction(async (tx) => {
          callbacks++;
          await tx.execute(query`insert into availability_commit values (1)`);
          for (const connection of proxy.connections) connection.blockServer = true;
        })
        .then(
          () => undefined,
          (error) => error,
        );
      expect(deadlineOf(failure)).toBeInstanceOf(DatabaseQueryTimeoutError);
      expect(callbacks).toBe(1);
      const [committed] = await observer.sql`select count(*)::int as count from availability_commit`;
      expect(committed?.count).toBe(1);
      await expect(client.database.execute(query`select 1`)).resolves.toBeDefined();
      const [unchanged] = await observer.sql`select count(*)::int as count from availability_commit`;
      expect(unchanged?.count).toBe(1);
    } finally {
      await client.sql.end({ timeout: 1 });
      await observer.sql.end({ timeout: 1 });
      await proxy.close();
    }
  });

  it("reports an exhausted application pool as unready while the dedicated probe is healthy", async () => {
    const client = createDatabaseClient(container.getConnectionUri(), { max: 1 });
    const probe = createDedicatedDatabaseReadinessProbe(container.getConnectionUri(), { deadlineMs: 1000 });
    const readiness = new BootstrapReadiness();
    for (const stage of ["configuration", "migration", "application", "listen"] as const) readiness.complete(stage);
    const app = createApp({
      readiness,
      loggerLevel: "silent",
      databaseReadinessProbe: createApplicationDatabaseReadinessProbe(client.sql, probe, 100),
    });
    const held = deferred(),
      release = deferred();
    const holder = client.database.transaction(async (tx) => {
      await tx.execute(query`select 1`);
      held.resolve();
      await release.promise;
    });
    try {
      await held.promise;
      await probe.run();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => app.inject({ method: "GET", url: "/readyz" })),
      );
      expect(responses.map((response) => response.statusCode)).toEqual([503, 503, 503, 503, 503]);
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      release.resolve();
      await holder;
      expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    } finally {
      release.resolve();
      await holder.catch(() => undefined);
      await app.close();
      await probe.close();
      await client.sql.end({ timeout: 1 });
    }
  });

  for (const queuedBehindHolder of [false, true]) {
    it(`does not pipeline readiness behind a healthy slow query (queued=${queuedBehindHolder})`, async () => {
      const client = createDatabaseClient(container.getConnectionUri(), {
        max: 1,
        queryTimeoutMs: 6000,
        statementTimeoutMs: 5000,
      });
      const probe = createDedicatedDatabaseReadinessProbe(container.getConnectionUri(), { deadlineMs: 1000 });
      const held = deferred(),
        release = deferred();
      const [before] = await client.sql`select pg_backend_pid() as pid`;
      const holder = queuedBehindHolder
        ? client.sql.begin(async () => {
            held.resolve();
            await release.promise;
          })
        : Promise.resolve();
      try {
        if (queuedBehindHolder) await held.promise;
        const healthy = client.sql`select pg_sleep(0.5)`.execute();
        const healthyResult = Promise.resolve(healthy);
        const run = createApplicationDatabaseReadinessProbe(client.sql, probe, 100);
        const readiness = run();
        const outcome = readiness.catch((error) => error);
        if (queuedBehindHolder) {
          await Promise.resolve();
          await Promise.resolve();
          release.resolve();
        }
        expect(await outcome).toMatchObject({ message: "Application database pool readiness failed" });
        await expect(healthyResult).resolves.toBeDefined();
        await holder;
        const [after] = await client.sql`select pg_backend_pid() as pid`;
        expect(after?.pid).toBe(before?.pid);
      } finally {
        release.resolve();
        await holder.catch(() => undefined);
        await probe.close();
        await client.sql.end({ timeout: 1 });
      }
    });
  }

  it("disposes a late socket factory result without closing the replacement session", async () => {
    const target = new URL(container.getConnectionUri());
    const release = deferred(),
      connected = deferred(),
      oldClosed = deferred();
    let created = 0;
    const options = {
      max: 1,
      socket: () =>
        new Promise<Socket>((resolve, reject) => {
          const socket = connect({ host: target.hostname, port: Number(target.port) });
          const original = created++ === 0;
          socket.once("error", reject);
          socket.once("connect", () => {
            if (original) {
              socket.once("close", oldClosed.resolve);
              connected.resolve();
              void release.promise.then(() => resolve(socket));
            } else resolve(socket);
          });
        }),
    };
    const sql = postgres(container.getConnectionUri(), options);
    applyQueryDeadline(sql, { timeoutMs: 100 });
    try {
      const expired = sql`select 1`.then(
        () => undefined,
        (error) => error,
      );
      await connected.promise;
      expect(await expired).toBeInstanceOf(DatabaseQueryTimeoutError);
      applyQueryDeadline(sql, { timeoutMs: 1000 });
      const [before] = await sql`select pg_backend_pid() as pid`;
      release.resolve();
      await oldClosed.promise;
      const [after] = await sql`select pg_backend_pid() as pid`;
      expect(after?.pid).toBe(before?.pid);
      expect(created).toBe(2);
    } finally {
      release.resolve();
      await sql.end({ timeout: 1 });
    }
  });

  for (const mode of ["blocked-query", "withheld-fin"]) {
    it(`removes ${mode} socket handles so a bounded-close child process can exit`, async () => {
      const proxy = await startDatabaseFaultProxy(container.getConnectionUri());
      let exited = false,
        requestedClose = false;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", fileURLToPath(new URL("./support/database-close-child.ts", import.meta.url)), mode],
        {
          env: { ...process.env, OPENTAG_CLOSE_TEST_URL: proxy.url },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        },
      );
      let stdout = "",
        stderr = "";
      const closed = new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (bytes) => {
          stdout += bytes;
          if (!requestedClose && stdout.includes("ready\n")) {
            requestedClose = true;
            isolateClosingTraffic(proxy, mode);
            child.stdin.end("close\n");
          }
        });
        child.stderr.on("data", (bytes) => {
          stderr += bytes;
        });
        child.on("error", reject);
        child.on("close", (code, signal) => {
          exited = true;
          if (code === 0 && signal === null) resolve();
          else reject(new Error(`close child failed: ${code} ${signal} ${stderr}`));
        });
      });
      try {
        await closed;
        expect(stdout).toContain("closed\n");
        expect(stderr).toBe("");
      } finally {
        if (!exited) child.kill();
        await proxy.close();
      }
    }, 7000);
  }
});
