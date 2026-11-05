/**
 * Entry point of the cancellation-read benchmark.
 *
 * Run from the repository root:
 *   pnpm exec tsx packages/server/scripts/benchmark-cancel-deliveries.ts
 *
 * Results default to the system temporary directory under `opentag-benchmarks/cancel-deliveries/`.
 * To retain results in task-owned storage, set the output path:
 *   OPENTAG_BENCHMARK_OUTPUT=/tmp/cancel-benchmark/results.json \
 *     pnpm exec tsx packages/server/scripts/benchmark-cancel-deliveries.ts
 *
 * The seed fixture is the tracked `database-performance-seed.sql` next to this file. The run never
 * reads DATABASE_URL and never targets an existing database. The orchestration lives in
 * `scripts/cancel-benchmark.ts` so unit tests exercise it without Docker; this file only wires the
 * production ports to it.
 */
import { runCancelBenchmark } from "./cancel-benchmark.js";
import { defaultCancelBenchmarkDeps } from "./cancel-benchmark-runtime.js";

await runCancelBenchmark(defaultCancelBenchmarkDeps());
