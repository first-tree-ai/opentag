/**
 * Production ports of the cancellation-read benchmark (`cancel-benchmark.ts`).
 *
 * Everything here is real: Docker owns a disposable loopback PostgreSQL container, Git supplies the
 * pre-change implementation, and the measurement runs over the same service client the Server uses.
 * Nothing runs on import - every port is a closure- or function-valued field of the object returned by
 * `defaultCancelBenchmarkDeps`, so a unit test can build the wiring and inspect it without starting a
 * container, and can drive the pure decisions (`startDatabaseContainer`, `waitForDatabase`,
 * `ownerOptions`, `explainPlan`) with fakes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDatabaseClient } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import * as schema from "../src/db/schema/index.js";
import { CloudDeliveryOwner } from "../src/services/sandboxes/cloud-delivery-owner.js";
import {
  type BenchmarkAdminPort,
  type BenchmarkSeam,
  type CancelBenchmarkDeps,
  planSql,
  preChangeOwnerClass,
  type QueryRecord,
  TRACKED_RESULTS_PATH,
} from "./cancel-benchmark.js";

const CONTAINER_LABEL = "opentag.benchmark=cancel-deliveries";
const CONTAINER_IMAGE = "postgres:17-alpine";
const SESSION_ID = "00000007-0000-4000-8000-000000000001";
/** The disposable container's local-only credentials; they never reach another database. */
const LOCAL_PASSWORD = "benchmark-local-only";

/**
 * Start the owned container and return its loopback URL. The label and binding assertions reject a
 * container this run did not create or a published address that is not loopback-only.
 *
 * A container whose `docker run` succeeded is this run's container even when the follow-up inspection
 * fails: a failed inspect command, an unexpected label or a non-loopback binding must remove it before
 * the error propagates, or every aborted acquisition leaks a running database. Removal is attempted only
 * after `docker run` returned, so a name this run never created is never removed. When the removal itself
 * fails, both causes are thrown together as an `AggregateError`: the acquisition failure stays the primary
 * error and the cleanup failure is surfaced instead of being swallowed.
 */
export function startDatabaseContainer(docker: (args: readonly string[]) => string, containerName: string): string {
  docker([
    "run",
    "--detach",
    "--name",
    containerName,
    "--label",
    CONTAINER_LABEL,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${LOCAL_PASSWORD}`,
    "--env",
    "POSTGRES_DB=opentag_benchmark",
    CONTAINER_IMAGE,
  ]);
  try {
    const label = docker(["inspect", "--format", '{{index .Config.Labels "opentag.benchmark"}}', containerName]);
    if (label !== "cancel-deliveries") throw new Error(`unexpected container label: ${label}`);
    const binding = docker(["port", containerName, "5432/tcp"]);
    if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error(`unexpected container port binding: ${binding}`);
    return `postgres://postgres:${LOCAL_PASSWORD}@${binding}/opentag_benchmark`;
  } catch (error) {
    let cleanupError: unknown;
    try {
      docker(["rm", "--force", "--volumes", containerName]);
    } catch (caught) {
      cleanupError = caught;
    }
    throw aggregateAcquisitionFailure(
      error,
      cleanupError,
      "benchmark container acquisition failed and its removal also failed",
    );
  }
}

/**
 * The error to throw after a failed acquisition whose cleanup also ran: the primary failure alone when the
 * cleanup succeeded, or an `AggregateError` holding `[primary, cleanup]` when it failed too. Swallowing the
 * cleanup failure would hide a container that may still be running or a driver that may still hold a
 * connection; replacing the primary with it would hide why the run stopped.
 */
export function aggregateAcquisitionFailure(primary: unknown, cleanupError: unknown, message: string): unknown {
  return cleanupError === undefined ? primary : new AggregateError([primary, cleanupError], message);
}

/** Poll a fresh container until it answers; the attempt bound keeps a broken image from hanging. */
export async function waitForDatabase(
  probe: () => Promise<unknown>,
  sleep: (milliseconds: number) => Promise<unknown>,
  attempts = 30,
): Promise<void> {
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      await probe();
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      await sleep(250);
    }
  }
}

/** The options both owners receive: no fence entry and no custody store, so every stop is terminal-free. */
export function ownerOptions(database: unknown) {
  return {
    custody: {} as never,
    database: database as never,
    fence: { connectionForSandbox: () => undefined } as never,
    hub: {} as never,
  };
}

/** Run one reported plan statement and return the plan tree the evidence records. */
export async function explainPlan(
  run: (sql: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>,
  sql: string,
  params: readonly unknown[],
): Promise<unknown> {
  const rows = await run(planSql(sql), params);
  return rows[0]?.["QUERY PLAN"];
}

/** The administrative driver of a benchmark run; injectable so the wiring is testable without a server. */
export type AdminDriver = {
  probe(): Promise<unknown>;
  query(sql: string, params: readonly unknown[]): Promise<unknown[]>;
  end(): Promise<void>;
};

export type AdminConnect = (databaseUrl: string) => AdminDriver;

const connectWithPostgres: AdminConnect = (databaseUrl) => {
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  return {
    end: () => admin.end(),
    probe: () => admin`select 1`,
    query: (sql, params) => admin.unsafe(sql, params as never[]) as Promise<unknown[]>,
  };
};

export async function openAdmin(
  databaseUrl: string,
  connect: AdminConnect = connectWithPostgres,
  sleep: (milliseconds: number) => Promise<unknown> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<BenchmarkAdminPort> {
  const admin = connect(databaseUrl);
  try {
    await waitForDatabase(() => admin.probe(), sleep);
  } catch (error) {
    // A driver whose readiness never arrives must not outlive the failure: close the connection this call
    // created. A failing close joins the readiness error instead of replacing or hiding it.
    let cleanupError: unknown;
    try {
      await admin.end();
    } catch (caught) {
      cleanupError = caught;
    }
    throw aggregateAcquisitionFailure(
      error,
      cleanupError,
      "administrative driver readiness failed and closing it also failed",
    );
  }
  return {
    end: () => admin.end(),
    query: <T>(sql: string, params: readonly unknown[] = []) => admin.query(sql, params) as Promise<T[]>,
  };
}

/** The service client and module loading of a measurement; injectable for the same reason. */
export type SeamDependencies = {
  createClient(databaseUrl: string): {
    sql: { end(): Promise<void>; unsafe(sql: string, params: never[]): Promise<unknown[]> };
    timeouts: unknown;
  };
  createDatabase(sql: unknown, logger: { logQuery(query: string, params: unknown[]): void }): unknown;
  loadModule(file: string): Promise<unknown>;
};

const productionSeamDependencies: SeamDependencies = {
  createClient: (databaseUrl) => createDatabaseClient(databaseUrl),
  createDatabase: (sql, logger) => drizzle(sql as never, { logger, schema }),
  loadModule: (file) => import(pathToFileURL(file).href),
};

export async function openSeam(
  databaseUrl: string,
  beforeModuleFile: string,
  dependencies: SeamDependencies = productionSeamDependencies,
): Promise<BenchmarkSeam> {
  const client = dependencies.createClient(databaseUrl);
  const statements: QueryRecord[] = [];
  const database = dependencies.createDatabase(client.sql, {
    logQuery(query, params) {
      statements.push({ params, query });
    },
  });
  const PreChangeOwner = preChangeOwnerClass(await dependencies.loadModule(beforeModuleFile));
  const options = ownerOptions(database);
  return {
    after: new CloudDeliveryOwner(options),
    before: new PreChangeOwner(options),
    close: () => client.sql.end(),
    explain: (sql, params) =>
      explainPlan(
        async (statement, values) =>
          (await client.sql.unsafe(statement, values as never[])) as Record<string, unknown>[],
        sql,
        params,
      ),
    journal: () => statements,
    resetJournal: () => statements.splice(0, statements.length),
    timeouts: client.timeouts,
  };
}

/** The production wiring: real Docker, real Git, real PostgreSQL, real files. Nothing runs eagerly. */
export function defaultCancelBenchmarkDeps(env: Record<string, string | undefined> = process.env): CancelBenchmarkDeps {
  const sandboxDirectory = fileURLToPath(new URL("../src/services/sandboxes/", import.meta.url));
  const migrationsFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const docker = (args: readonly string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
  const containerName = `opentag-cancel-benchmark-w49-${process.pid}`;
  return {
    clock: { elapsedMs: () => performance.now(), nowIso: () => new Date().toISOString() },
    containerName,
    docker,
    env,
    file: {
      ensureDirectory: (path) => mkdirSync(path, { recursive: true }),
      read: (path) => readFileSync(path, "utf8"),
      remove: (path) => rmSync(path, { force: true }),
      write: (path, value) => writeFileSync(path, value),
    },
    git: (args) => execFileSync("git", args, { encoding: "utf8" }),
    log: (line) => console.log(line),
    migrate: (databaseUrl) => migrateDatabase(databaseUrl, migrationsFolder),
    openAdmin,
    openSeam,
    paths: {
      beforeModuleFile: `${sandboxDirectory}.benchmark-before-${process.pid}.ts`,
      migrationsFolder,
      seedFile: fileURLToPath(new URL("./database-performance-seed.sql", import.meta.url)),
      trackedResultsFile: fileURLToPath(new URL(`../../../${TRACKED_RESULTS_PATH}`, import.meta.url)),
    },
    sessionId: SESSION_ID,
    startDatabaseContainer: () => startDatabaseContainer(docker, containerName),
  };
}
