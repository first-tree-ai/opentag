import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../db/migrate.js";
import {
  acquireRuntimeOwnershipLease,
  RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID,
} from "../../runtime/runtime-ownership-lease.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const webDistRoot = fileURLToPath(new URL("../../../../../apps/web/dist", import.meta.url));
const webIndexPath = join(webDistRoot, "index.html");
let createdWebIndex = false;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local test port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function serverEnvironment(databaseUrl: string, port: number, timeoutMs: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BETTER_AUTH_SECRET: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    OPENTAG_AUTO_MIGRATE: "false",
    OPENTAG_DATABASE_URL: databaseUrl,
    OPENTAG_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    OPENTAG_ENV: "dev",
    OPENTAG_HOST: "127.0.0.1",
    OPENTAG_JWT_SECRET: "jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj",
    OPENTAG_PORT: String(port),
    OPENTAG_PUBLIC_URL: `http://127.0.0.1:${port}`,
    OPENTAG_RUNTIME_REPLICA_ACQUIRE_TIMEOUT_MS: String(timeoutMs),
    OPENTAG_RUNTIME_REPLICA_MODE: "single",
  };
}

async function waitForReady(
  port: number,
  child: ReturnType<typeof spawn>,
  output: () => string = () => "",
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before becoming ready: ${child.exitCode}; output: ${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.status === 200) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The test server did not become ready");
}

async function waitForStatus(port: number, child: ReturnType<typeof spawn>, status: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited while waiting for HTTP ${status}: ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.status === status) return;
    } catch {
      // The listener may be restarting its connection state.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`The test server did not return HTTP ${status}`);
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 20_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The test server did not exit within the deadline"));
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function leaseBackendPid(observer: ReturnType<typeof postgres>): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [connection] = await observer<{ pid: number }[]>`
      select pid::int
      from pg_stat_activity
      where application_name = 'opentag-runtime-ownership'
        and pid <> pg_backend_pid()
      order by pid
      limit 1
    `;
    if (connection?.pid !== undefined) return connection.pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The runtime ownership backend was not visible in pg_stat_activity");
}

describe("runtime ownership advisory lease", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    if (!existsSync(webIndexPath)) {
      mkdirSync(webDistRoot, { recursive: true });
      writeFileSync(webIndexPath, "<!doctype html><html><body>test</body></html>\n");
      createdWebIndex = true;
    }
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
    if (createdWebIndex) rmSync(webIndexPath, { force: true });
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

  it("fences traffic while a dropped lease waits, then resumes after transient recovery", async () => {
    const databaseUrl = container.getConnectionUri();
    await migrateDatabase(databaseUrl, migrationsFolder);
    const port = await freePort();
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "packages/server/src/index.ts"], {
      cwd: repositoryRoot,
      env: serverEnvironment(databaseUrl, port, 3_000),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const observer = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    const blocker = postgres(databaseUrl, { max: 1, onnotice: () => undefined });

    try {
      await waitForReady(port, child, () => output);
      const pid = await leaseBackendPid(observer);
      const blockerLock = blocker`select pg_advisory_lock(${RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID})`;
      await observer`select pg_terminate_backend(${pid})`;
      await blockerLock;
      await waitForStatus(port, child, 503);

      await blocker`select pg_advisory_unlock(${RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID})`;
      await waitForReady(port, child, () => output);
      expect(output).toContain("Runtime ownership lease recovered");
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child).catch(() => undefined);
      await blocker.end();
      await observer.end();
    }
  }, 120_000);

  it("fences and exits non-zero when lease recovery expires, with no leaked lease client", async () => {
    const databaseUrl = container.getConnectionUri();
    await migrateDatabase(databaseUrl, migrationsFolder);
    const port = await freePort();
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "packages/server/src/index.ts"], {
      cwd: repositoryRoot,
      env: serverEnvironment(databaseUrl, port, 1_000),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const observer = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    const blocker = postgres(databaseUrl, { max: 1, onnotice: () => undefined });

    try {
      await waitForReady(port, child, () => output);
      const pid = await leaseBackendPid(observer);
      const blockerLock = blocker`select pg_advisory_lock(${RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID})`;
      await observer`select pg_terminate_backend(${pid})`;
      await blockerLock;

      const result = await waitForExit(child, 20_000);
      expect(result.signal).toBeNull();
      expect(result.code).toBe(1);
      expect(output).toContain("Runtime ownership lease recovery failed");

      const [observerBackend] = await observer<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
      const [blockerBackend] = await blocker<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
      if (!observerBackend || !blockerBackend) throw new Error("Could not identify test PostgreSQL backends");
      const [activity] = await observer<{ count: number }[]>`
        select count(*)::int
        from pg_stat_activity
          where datname = current_database()
          and pid not in (${observerBackend.pid}, ${blockerBackend.pid})
      `;
      expect(activity?.count).toBe(0);
    } finally {
      await blocker`select pg_advisory_unlock(${RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID})`.catch(() => undefined);
      await blocker.end();
      await observer.end();
      if (child.exitCode === null) child.kill("SIGKILL");
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
