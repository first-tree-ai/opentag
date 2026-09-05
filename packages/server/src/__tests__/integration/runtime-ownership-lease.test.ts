import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../db/migrate.js";
import { acquireRuntimeOwnershipLease } from "../../runtime/runtime-ownership-lease.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../..", import.meta.url));

describe("runtime ownership advisory lease", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("waits for a holder to exit before a rolling restart acquires the lease", async () => {
    const databaseUrl = container.getConnectionUri();
    const firstLease = await acquireRuntimeOwnershipLease(databaseUrl, "11111111-1111-4111-8111-111111111111");
    const startedAt = Date.now();
    const secondLeasePromise = acquireRuntimeOwnershipLease(databaseUrl, "22222222-2222-4222-8222-222222222222", {
      timeoutMs: 5_000,
      retryDelayMs: 20,
    });
    const releaseTimer = setTimeout(() => {
      void firstLease.release();
    }, 150);

    try {
      const secondLease = await secondLeasePromise;
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
      expect(secondLease.state).toMatchObject({ status: "owned" });
      await secondLease.release();
    } finally {
      clearTimeout(releaseTimer);
      await firstLease.release();
    }
  }, 120_000);

  it("stops reporting ownership when PostgreSQL terminates the lease connection", async () => {
    const databaseUrl = container.getConnectionUri();
    const lease = await acquireRuntimeOwnershipLease(databaseUrl, "33333333-3333-4333-8333-333333333333");
    const observer = postgres(databaseUrl, { max: 1, onnotice: () => undefined });

    try {
      const [connection] = await observer<{ pid: number }[]>`
        select pid::int
        from pg_stat_activity
        where application_name = 'opentag-runtime-ownership'
          and pid <> pg_backend_pid()
        limit 1
      `;
      const pid = connection?.pid;
      expect(pid).toBeDefined();
      if (pid === undefined) throw new Error("The lease connection was not visible in pg_stat_activity");
      await observer`select pg_terminate_backend(${pid})`;

      for (let attempt = 0; attempt < 20 && lease.state.status === "owned"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(lease.state).toEqual({ mode: "single", status: "not_owned" });
    } finally {
      await lease.release();
      await observer.end();
    }
  }, 120_000);

  it("exits non-zero and closes all PostgreSQL connections when startup is refused", async () => {
    const databaseUrl = container.getConnectionUri();
    await migrateDatabase(databaseUrl, migrationsFolder);
    const holder = await acquireRuntimeOwnershipLease(databaseUrl, "44444444-4444-4444-8444-444444444444");
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "packages/server/src/index.ts"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        BETTER_AUTH_SECRET: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        OPENTAG_AUTO_MIGRATE: "false",
        OPENTAG_DATABASE_URL: databaseUrl,
        OPENTAG_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        OPENTAG_ENV: "dev",
        OPENTAG_HOST: "127.0.0.1",
        OPENTAG_JWT_SECRET: "jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj",
        OPENTAG_PORT: "8000",
        OPENTAG_PUBLIC_URL: "http://127.0.0.1:8000",
        OPENTAG_RUNTIME_REPLICA_ACQUIRE_TIMEOUT_MS: "1000",
        OPENTAG_RUNTIME_REPLICA_MODE: "single",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("The refused server process did not exit within the test deadline"));
        }, 20_000);
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      });
      expect(result.signal).toBeNull();
      expect(result.code).toBe(1);
      expect(output).toContain("could not start after waiting 1000 ms");

      const observer = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        const [activity] = await observer<{ count: number }[]>`
          select count(*)::int
          from pg_stat_activity
          where application_name = 'opentag-runtime-ownership'
            and pid <> pg_backend_pid()
        `;
        expect(activity?.count).toBe(1);
      } finally {
        await observer.end();
      }
    } finally {
      await holder.release();
    }
  }, 120_000);
});
