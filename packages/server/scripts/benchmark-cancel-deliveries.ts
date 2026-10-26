/**
 * Entry point of the cancellation-read benchmark.
 *
 * Run from the repository root:
 *   pnpm exec tsx packages/server/scripts/benchmark-cancel-deliveries.ts
 *
 * The run replaces the tracked evidence file `testing/performance/cancel-deliveries/results.json` and
 * must be followed by `pnpm format`, which restores the repository's JSON formatting for it. To write
 * the result somewhere else instead - for example a verification run that must not touch the tracked
 * tree - set the output path:
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
