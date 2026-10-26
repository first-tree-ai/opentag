import type { TaskService } from "../../src/services/tasks/index.js";
import { type DockerPort, startBenchmarkContainer, waitForDatabase } from "./container.js";
import {
  type BenchmarkReport,
  type BenchmarkSink,
  runTaskQueriesBenchmark,
  seedDatabase,
  splitSeed,
  verifyRowCounts,
} from "./measure.js";

/**
 * One benchmark run, from container to evidence file, written against injected ports.
 *
 * The entry point in `benchmark-task-queries.ts` is the only caller and supplies real Docker,
 * PostgreSQL, migrations and file output; the unit tests supply fakes. Nothing here decides anything
 * about the environment, which is what keeps a run reproducible: the fixture, the case list and the
 * report shape are the same whether the ports are real or not.
 */
export interface BenchmarkRunPorts {
  phase: string;
  /** Where the evidence directory is created; the results file and plans go under it. */
  output: string;
  docker: DockerPort;
  containerName: string;
  labelValue: string;
  /** Opens a single-connection admin client for the given URL. */
  openAdmin(url: string): {
    database: { unsafe(query: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]> };
    end(): Promise<void>;
  };
  /** Opens the service under test, with its own query logger wired to `sink`. */
  openService(url: string): { service: TaskService; sink: BenchmarkSink; timeouts: unknown; end(): Promise<void> };
  /** Opens a connection used only for `EXPLAIN`. */
  openExplain(url: string): {
    database: { unsafe(query: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]> };
    end(): Promise<void>;
  };
  migrate(url: string): Promise<void>;
  /** The fixture's SQL text. */
  readSeed(): string;
  /** Facts about the checkout and the host for the evidence file. */
  environment(): Record<string, unknown>;
  mkdir(path: string): void;
  write(path: string, contents: string): void;
  gitHead(): string;
  gitDirty(): boolean;
  clock(): number;
  log(line: string): void;
  /** The accounts whose history the fixture shaped. */
  ids: { hotAccountId: string; tenAgentAccountId: string };
}

const METHOD =
  "One warm-up and five sequential samples per case unless stated. Single sequential local Docker microbenchmark, not production capacity. Default service query deadlines and connection pool. SQL counts come from the service query logger. EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) runs once per distinct SELECT outside the timed samples. Values include Node mapping and loopback transport; responseBytes exclude HTTP encoding. No external providers.";

/** Run one phase and return the report it wrote, including the container cleanup either way. */
export async function runBenchmark(ports: BenchmarkRunPorts): Promise<BenchmarkReport> {
  const explainDir = `${ports.output}/explain/${ports.phase}`;
  ports.mkdir(explainDir);
  const report: BenchmarkReport = { phase: ports.phase, results: [] };
  const resultsPath = `${ports.output}/results-${ports.phase}.json`;
  const save = () => ports.write(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  const container = startBenchmarkContainer({
    docker: ports.docker,
    name: ports.containerName,
    labelKey: "opentag.benchmark",
    labelValue: ports.labelValue,
    log: ports.log,
  });
  const admin = ports.openAdmin(container.url);
  let service: ReturnType<BenchmarkRunPorts["openService"]> | undefined;
  let explain: ReturnType<BenchmarkRunPorts["openExplain"]> | undefined;
  try {
    await waitForDatabase(() => admin.database.unsafe("select 1"));
    const migratedAt = ports.clock();
    await ports.migrate(container.url);
    report.environment = {
      commit: ports.gitHead(),
      // Source cleanliness only: the evidence directory is not a code change, so verifying a
      // committed tree records `dirty: false` however often the run repeats.
      dirty: ports.gitDirty(),
      ...ports.environment(),
      postgres: (
        await admin.database.unsafe(
          "select version(), current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem, current_setting('max_connections') as max_connections",
        )
      )[0],
      migrationCount: (await admin.database.unsafe("select count(*)::int as n from drizzle.__drizzle_migrations"))[0]
        ?.n,
      migrationMs: ports.clock() - migratedAt,
      startedAt: new Date().toISOString(),
      method: METHOD,
    };
    report.seedTimings = await seedDatabase(admin.database, splitSeed(ports.readSeed()), ports.clock, ports.log);
    await admin.database.unsafe("analyze");
    report.rowCounts = await verifyRowCounts(admin.database);
    report.databaseBytes = (
      await admin.database.unsafe("select pg_database_size(current_database())::text as bytes")
    )[0]?.bytes;

    service = ports.openService(container.url);
    explain = ports.openExplain(container.url);
    report.timeouts = service.timeouts;
    await runTaskQueriesBenchmark(
      {
        admin: admin.database,
        explainSql: explain.database,
        service: service.service,
        sink: service.sink,
        output: { dir: explainDir, mkdir: ports.mkdir, write: ports.write },
        report,
        clock: ports.clock,
        log: ports.log,
        save,
      },
      ports.ids,
    );
    report.finishedAt = new Date().toISOString();
    return report;
  } finally {
    try {
      await explain?.end();
    } finally {
      try {
        await service?.end();
      } finally {
        try {
          await admin.end();
        } finally {
          container.stop();
          report.containerRemoved = true;
          save();
        }
      }
    }
  }
}
