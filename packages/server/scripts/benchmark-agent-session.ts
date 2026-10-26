/**
 * Runs the Agent usage and internal-Session page benchmark against its own PostgreSQL container.
 *
 * Everything here is wiring: Docker, postgres.js, the real services, and the paths. The flow itself lives in
 * `agent-session-benchmark.ts`, which has no import-time side effects so the measurement logic can be tested
 * without Docker. Run from the repository root:
 *
 * ```bash
 * pnpm --filter @opentag/shared build
 * pnpm exec tsx packages/server/scripts/benchmark-agent-session.ts [--out <directory>]
 * ```
 *
 * `OPENTAG_BENCHMARK_OUT` does the same as `--out`, so a reviewer can keep the checkout clean.
 * Results default to `testing/performance/agent-session/results.json`; the container and its volume are
 * removed in `finally`, and anything a forced kill leaves behind carries the `opentag.benchmark=agent-session`
 * label.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentUsageWindowDays } from "@opentag/shared";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDatabaseClient } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import * as schema from "../src/db/schema/index.js";
import { AgentService } from "../src/services/agents/agent-service.js";
import { deliveryUsageTokenCounts } from "../src/services/agents/agent-usage.js";
import { SessionService } from "../src/services/sessions/session-service.js";
import {
  type BenchmarkAdmin,
  type BenchmarkDeps,
  readLegacyUsage,
  resolveOutputDirectory,
  runBenchmark,
} from "./agent-session-benchmark.js";

const trackedDirectory = resolve(import.meta.dirname, "../../../testing/performance/agent-session");

/** Stable fixture identities produced by `agent-session-seed.sql`. */
const id = (kind: number, number: number) =>
  `${String(kind).padStart(8, "0")}-0000-4000-8000-${String(number).padStart(12, "0")}`;

function benchmarkDependencies(): BenchmarkDeps {
  return {
    docker: (args) => execFileSync("docker", args, { encoding: "utf8" }).trim(),
    // postgres.js is a template tag, not an object with a `query` method: the adapter is what makes the
    // harness depend on three plain members instead of on the driver's callable shape.
    openAdmin: async (databaseUrl) => {
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      return {
        query: ((strings: TemplateStringsArray, ...values: unknown[]) =>
          sql(strings as never, ...(values as never[]))) as BenchmarkAdmin["query"],
        unsafe: (query, parameters) => sql.unsafe(query, (parameters ?? []) as never[]),
        end: () => sql.end({ timeout: 5 }),
      };
    },
    migrate: (databaseUrl) => migrateDatabase(databaseUrl, resolve(import.meta.dirname, "../drizzle")),
    readSeed: () => readFileSync(resolve(import.meta.dirname, "agent-session-seed.sql"), "utf8"),
    createDatabase: (databaseUrl) => {
      const client = createDatabaseClient(databaseUrl);
      const queries: { query: string; params: unknown[] }[] = [];
      const database = drizzle(client.sql, {
        schema,
        logger: { logQuery: (query, params) => queries.push({ query, params }) },
      });
      return {
        database: database as unknown as ReturnType<BenchmarkDeps["createDatabase"]>["database"],
        queryLog: {
          reset: () => {
            queries.length = 0;
          },
          snapshot: () => [...queries],
        },
        close: () => client.sql.end(),
      };
    },
    createCases: (database, now) => {
      const services = {
        agents: new AgentService(database, { now: () => now }),
        sessions: new SessionService(database, { now: () => now }),
      };
      const usageEndedAt = now;
      const usageStartedAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
      let legacyRows = 0;
      return {
        listAgents: (accountId) => services.agents.listForAccount(accountId),
        usage: (accountId, agentId, windowDays) =>
          services.agents.getUsageById(accountId, agentId, windowDays as AgentUsageWindowDays),
        internalPage: (rootSessionId) =>
          services.sessions.listInternalSessions(rootSessionId, { limit: 20, recursive: true }),
        // The removed read, projected to the same public body the service returns.
        legacyUsage: async () => {
          const legacy = await readLegacyUsage(database as unknown as Parameters<typeof readLegacyUsage>[0], {
            agentId: id(4, 1),
            provider: "codex",
            windowDays: 30,
            startedAt: usageStartedAt,
            endedAt: usageEndedAt,
          });
          legacyRows = legacy.rowsRead;
          // The complete public body, so the harness can prove both reads answered the same question.
          return legacy.detail;
        },
        legacyRowsRead: () => legacyRows,
      };
    },
    fixture: {
      accountId: id(1, 1),
      agentId: id(4, 1),
      hotBindingId: id(6, 1),
      rootSessionId: id(7, 1),
      endedDescendants: 90_000,
    },
    resolveOutputDirectory: () =>
      resolveOutputDirectory({
        argv: process.argv.slice(2),
        env: process.env,
        trackedDirectory,
      }),
    writeResults: (directory, content) => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, "results.json"), content);
    },
    now: () => new Date("2026-10-26T08:00:00Z"),
    elapsed: () => performance.now(),
    log: (record) => console.log(JSON.stringify(record)),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runBenchmark(benchmarkDependencies());
}
