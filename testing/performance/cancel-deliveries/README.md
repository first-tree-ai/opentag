# Cloud delivery cancellation reads

This page records the before/after evidence for removing the repeated Sandbox lookup in
`CloudDeliveryOwner.cancelSessionDeliveries`
(`packages/server/src/services/sandboxes/cloud-delivery-owner.ts`).

## Scope

The stop path selects the Session's accepted, unreported deliveries once, revokes their model grants,
closes the Session's credential executions, and then sends a connection-fenced `delivery:cancel` to the
Runner that owns each delivery. Before this change the loop also re-read the Session's Sandbox row for
every delivery, so a backlog of N deliveries issued N+1 statements. `sandboxes_session_id_unique`
guarantees one Sandbox row per Session, so the read is now performed once, and only when the eligible
list is nonempty.

Only statement counts and the repeated read change. Authorization, ordering, custody, lifecycle and
retention semantics are untouched: this path opens no transaction, so no transaction can span a send.

## Harness

`packages/server/scripts/benchmark-cancel-deliveries.ts` owns a disposable loopback
PostgreSQL 17 container, applies the checked-in migrations, seeds at least 100000 rows into every
`public` and `billing` table with constraints and indexes enabled, and measures the same call on the
same seeded data with two owners. The orchestration lives in `packages/server/scripts/cancel-benchmark.ts`
and its production ports in `packages/server/scripts/cancel-benchmark-runtime.ts`, so
`packages/server/scripts/__tests__/cancel-benchmark.test.ts` covers the fixture contract, the
before/after accounting and the cleanup paths with injected ports - no Docker, database, or network.
The pair under measurement is:

- `before`: `cloud-delivery-owner.ts` from `d2fc9e8aa045dc1a214ab3f0a953cbdcde088c92` (the audit base,
  read inside the loop; it is on `main`, and `OPENTAG_BENCHMARK_BEFORE_REF` overrides the ref),
  generated with `git show` into the module's own directory so its relative imports resolve unchanged,
  and deleted again after the run;
- `after`: the working-tree implementation (one read for the backlog).

The seed fixture is tracked at `packages/server/scripts/database-performance-seed.sql` (the audit's
exact fixture), so a fresh checkout can reproduce this page. Run from the repository root:

```sh
pnpm --filter @opentag/shared build
pnpm exec tsx packages/server/scripts/benchmark-cancel-deliveries.ts
pnpm format
```

The last command restores the repository's JSON formatting of the tracked result file, which
`pnpm check` expects. A verification run that must not touch the tracked tree writes elsewhere with
`OPENTAG_BENCHMARK_OUTPUT`:

```sh
OPENTAG_BENCHMARK_OUTPUT=/tmp/cancel-benchmark/results.json \
  pnpm exec tsx packages/server/scripts/benchmark-cancel-deliveries.ts
```

Keep the committed defaults: the script owns and removes its container and volume in `finally`,
including when setup fails, and it deletes the temporary `before` module it generates (the crash-safe
`.benchmark-before-*.ts` pattern is also in `.gitignore`). The report records only the
repository-relative `resultsPath` for the tracked default, or `<overridden>` for an override run, so
committed evidence never carries a machine path. It never reads `DATABASE_URL` and never targets an
existing database.

## Environment (recorded run)

- Run interval 2026-10-26T10:58:35Z to 10:59:29Z, produced by the committed harness on the working
  tree above commit `b95ca784` (implementation commit `9c745963`); before-ref `d2fc9e8aa045`.
- Node.js v24.19.0, macOS arm64, `postgres:17-alpine`
  (`sha256:ff80089083d7365046af7f03d949a2defa14e0b09e14bd5b8f08a242291be8b2`).
- Docker VM: 18 CPUs and the memory reported in `results.json` (`environment.dockerResources`). These are VM
  limits, not dedicated benchmark capacity.
- PostgreSQL 17.11, `shared_buffers=128MB`, `work_mem=4MB`, `max_connections=100`. The service client
  keeps its default 20-connection pool, 30-second statement timeout and 35-second query timeout.
- 69 real migrations, 39 application tables (`public` + `billing`), each with at least 100000 rows
  (`sessions` has 200000); database size 1262592527 bytes; `ANALYZE` runs before measurement.
- Method: one warm-up and five sequential timed samples per case and owner, both owners measured on the
  same database so each pair shares data and cache state. Statement counts come from the Drizzle query
  logger; plans come from one additional untimed `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)`
  per distinct statement. The fixture has no live Runner connection, so every outcome is
  `no_connection`, as in the audit: these cases model a cancellation backlog, not live provider turns.

## Results

`cloud.cancel.<N>-unreported` for one Session with N accepted, unreported Cloud deliveries:

| N eligible | Statements before | Statements after | Median ms before | Median ms after |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 1 | 6.016 | 5.833 |
| 1 | 2 | 2 | 6.223 | 6.383 |
| 10 | 11 | 2 | 9.187 | 6.771 |
| 100 | 101 | 2 | 30.120 | 6.257 |

After the change the statement count is 1 for an empty backlog and 2 for any nonempty backlog, which
is the per-delivery work of the stop itself collapsing to zero database round trips. Small-backlog
medians (0 and 1) stay within run-to-run noise; the 100-delivery case drops from 30.120 ms to 6.257 ms.
Samples, per-statement SQL, parameter counts, plan trees and buffer counters are in
[results.json](results.json). Repeated runs of the same harness reproduced the statement counts
(1/2/11/101 before, 1/2/2/2 after) and kept the 100-delivery before-median between 28.7 ms and 33.7 ms.
An `OPENTAG_BENCHMARK_OUTPUT` run outside the repository produced the same counts, reported
`resultsPath: "<overridden>"` and left this artifact untouched.

## Plans

The two statements of the 100-delivery case (identical for both owners):

- Eligible deliveries: `select id, turn_id, report_owner_instance_id from im_message_deliveries where
  session_id = $1 and state = 'accepted' and reported_at is null`. In this run a sequential scan of the
  100000-row table returns the 100 qualifying rows in 6.121 ms (before) and 5.702 ms (after) analyzed,
  with 2701 and 2925 shared buffer hits. One occurrence per call for both owners.
- Session Sandbox: `select ... from sandboxes where session_id = $1 limit 1`. `Limit` over `Index Scan`
  using `sandboxes_session_id_unique`, 1 row, 4 shared buffer hits. **100 occurrences before, 1 after.**

The deliveries read itself is unchanged by this diff and is bounded by the Session's own eligible
backlog, which the stop must act on in full; it is not a paginated list. Across runs PostgreSQL chose
either this sequential scan or a bitmap heap scan over `im_message_deliveries_session_id_idx` (50104
index entries examined) for the same SQL and statistics, so the plan for that statement is
planner-dependent and unrelated to the fix.

## Semantics preserved

The unit suite `packages/server/src/__tests__/cloud-delivery-owner.test.ts` covers the stop path:

- 0/1/10/100 deliveries: an empty backlog reads no Sandbox at all (exactly 1 SELECT in total), and any
  nonempty backlog reads it once (exactly 2 SELECTs). Every delivery still gets one `delivery:cancel`
  frame and one `cancelled` outcome, and every row stays `state=accepted` with `reportedAt=null`
  afterward - a delivered cancel frame is not a terminal outcome; the Runner's report still settles
  custody through the durable report path.
- Grant revocation still happens for accepted turns while the Sandbox is read once, and
  `closeSessionExecutions(sessionId, "execution_closed")` still runs even for an empty backlog.
- A stale `report_owner_instance_id`, a replacement connection on the same Sandbox (the superseded
  instance's rows stay `no_connection` while the replacement's own delivery is cancelled on its
  socket), and a missing Sandbox row all report `no_connection` without dropping outcomes, each at 2
  SELECTs.
- The connection fence is still read per delivery, which the mid-sweep tests pin: a replacement
  installed from inside the first delivered cancel frame takes over the remaining sends (1 frame on
  the superseded socket, 2 on the replacement, all `cancelled`), and a fence invalidated mid-sweep
  turns the remaining deliveries into `no_connection` instead of a failed send. Both stay at 2
  SELECTs, and caching the fence read across the loop fails them.

## Validation

```sh
pnpm --filter @opentag/server exec vitest run src/__tests__/cloud-delivery-owner.test.ts --maxWorkers=2
pnpm --filter @opentag/server exec vitest run scripts/__tests__/cancel-benchmark.test.ts --maxWorkers=1
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/cloud-session-concurrency.test.ts \
  src/__tests__/integration/cloud-dispatch-custody.test.ts --maxWorkers=2
pnpm --filter @opentag/server typecheck
pnpm check
```

Results: the focused cancellation unit file passes 56 tests, and the benchmark harness passes 26
tests with no Docker, database or network. The shared measurement fix now instruments
`packages/server/scripts/*.ts`, so the harness lines this change adds are measured by the patch gate
instead of reading as missing coverage entries. Reverting only `cloud-delivery-owner.ts` to the base
commit fails the cancellation statement-count tests with `expected 11 to be 2` / `expected 101 to be
2`, and caching the per-delivery fence read fails the mid-sweep replacement test, so the regressions
have teeth. Both PostgreSQL integration files pass 13 tests (real PostgreSQL 17, real local
WebSockets, synthetic Runner responses; the cancellation case cancels one Session without touching
another Session's authority or completion). Server typecheck and `pnpm check` exit 0.
No migration was added, so the full server integration suite is not required by this change; the two
files above are the cancellation-relevant ones.

## Limits

This is a sequential, mostly warm, single-process local microbenchmark with no HTTP layer, no live
Runner turns and no external providers. It does not measure concurrent stops, network sends or
production capacity, and no product SLO was supplied, so the numbers are local diagnostics rather than
performance targets. Whether `cancelled` reflects an actual aborted turn is covered by the
integration tests, not by this fixture.
