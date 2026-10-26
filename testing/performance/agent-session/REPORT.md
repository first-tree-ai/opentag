# Agent usage and internal Session page benchmark

Supports [Agent usage accounting](../../../docs/system/agent-usage.md) and
[Internal Session collaboration](../../../docs/system/messaging/internal-session-collaboration.md).

## Scope and environment

- Fixture: 39 application tables, each with at least 100,000 rows, 4,000,000 rows in total; `sessions` has
  200,000. All 71 migrations run before seeding, every constraint and index stays enabled, `ANALYZE` runs before
  measurement, and a run aborts if any table holds fewer than 100,000 rows.
- One owned PostgreSQL 17.11 container on a random loopback port, removed in `finally`; the script never reads
  `DATABASE_URL`. Database size after seeding: 1,262,649,871 bytes. `shared_buffers=128MB`, `work_mem=4MB`,
  `max_connections=100`, the service's 20-connection pool and default deadlines.
- One warm-up plus five sequential samples per case; medians are reported. Elapsed time includes Node.js mapping
  and loopback transport, no HTTP.
- Each distinct read gets one extra untimed `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)`; parameters are not
  stored.
- The before case runs the removed implementation in the same process — one row select of every Delivery in the
  window plus the JavaScript token loop and the same zero-filled day projection — and must return a body equal to
  the submitted read's body. The harness compares both bodies after key sorting and fails the run otherwise.
- Node.js v24.19.0, macOS arm64. Absolute times varied noticeably between runs of the same code, so only
  same-run comparisons are used below; no single figure is offered as a machine-independent number.

## Final results (run `final5`)

| Case | Median ms | SQL per call | Bounded result |
| --- | ---: | ---: | --- |
| `agents.usage.50000-deliveries` (submitted) | 142.27 | 3 | dailyBuckets=31 |
| `agents.usage.50000-deliveries.before` (removed) | 206.59 | 1 | rowsRead=50000 |
| `agents.list.1-agents` (with the shipped index) | 158.23 | 5 | agents=1 |
| `agents.list.1-agents.without-unreported-index` | 278.93 | 5 | agents=1 |
| `sessions.internal.100000-active.limit20` | 0.83 | 1 | items=20 |
| `sessions.internal.90000-ended.limit20` | 1.48 | 1 | items=20 |
| `sessions.internal.90000-ended.limit20.before` | 114.11 | 1 | items=20 |

`report.equivalence` for this run: `{ "equal": true }` over all eleven public keys — `windowDays`, `startedAt`,
`endedAt`, `tasks`, `measuredTasks`, `failed`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `tokens`,
`daily` — so the two timings above describe the same output. Earlier runs compared a one-query row count with
the three-query public body and are **not** used as speedup evidence.

Target status, stated plainly:

| Target | Result | Status |
| --- | --- | --- |
| Agent usage detail < 50 ms | 142.27 ms | **missed** |
| Hot Agent list < 100 ms | 158.23 ms | **missed** |
| Active internal page < 10 ms without 90k ended-session probes | 1.48 ms | met |

The submitted usage read is 31% faster than the removed one with identical output (206.59 → 142.27 ms), and the
hot list is 43% faster with the shipped partial index (278.93 → 158.23 ms). Both still miss their targets. Run-to-run
spread was large: the same code measured 95–142 ms for the usage detail and 99–158 ms for the hot list across runs,
so only these same-run ratios are claimed.

### Reports the aggregate cannot sum

The SQL aggregate sums values stored in canonical decimal form. Any other report — a valid `1000.00` or `1e3` as
well as a malformed one — is recomputed row by row in keyset batches of at most 1,000 ordered by
`(accepted_at, id)`, folded into the per-day totals as each page arrives, with the exact UTC text of the cursor so
microseconds are not truncated. There is **no cap on the total number of such reports**: the batch size bounds each
statement and the memory, not the compatibility of the data. The fixture writes canonical values, so this path does
not appear in the timings above; its correctness is covered by unit cases over more than two batches and by a
PostgreSQL boundary suite with 1,205 such reports packed into one millisecond.

## EXPLAIN attribution of the remaining latency

`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the statement `getUsageById` actually issues, with the fixture's real
parameters and authorization predicate (execution 105.55 ms in that capture):

| Plan node | Actual rows | Estimated | Time incl. | Buffers |
| --- | ---: | ---: | ---: | ---: |
| `Aggregate` (13 day groups) | 13 | 1 | 105.0 ms | 208,648 hit |
| `CTE Scan flagged_window` | 50,000 | 1 | 95.1 ms | 208,648 hit |
| `CTE Scan usage_window` (materialized) | 50,000 | 1 | 81.3 ms | 208,648 hit |
| `Nested Loop` on deliveries | 50,000 | 1 | 56.2 ms | 208,648 hit |
| `Nested Loop` bindings→sessions | 100,001 | 8 | 11.1 ms | 4,061 hit |
| `Seq Scan im_bindings`, 99,999 rows removed by filter | 1 | 1 | 2.6 ms | 2,438 hit |
| `Index Scan sessions` (`sessions_im_binding_scope_idx`) | 100,001 | 8 | 4.9 ms | 1,623 hit |
| `Index Scan im_message_deliveries` (`session_id_idx`), 100,001 loops | ~0.5 per loop | 11 | ≈44.6 ms | 204,587 hit |

Attribution, stated precisely:

- The planner estimates **1** Delivery row and **8** Sessions for the binding join, because `im_binding_id = b.id`
  is a generic join condition and cannot know that this binding owns 100,001 Sessions. The join therefore becomes a
  parameterized nested loop that probes deliveries 100,001 times. `Actual Rows 0` per loop is display rounding:
  each loop returns a fraction of a row on average, so the probes return the window's 50,000 rows in total, not
  zero.
- All 204,587 delivery buffers were **hits**, so this capture made no physical reads. That is a warm-cache
  property of the run, not proof that the operator avoids heap access: an index scan still visits the heap for
  each matching row.
- The remaining time is intrinsic to the read: ~25 ms materializing the 50,000-row window into a tuplestore, ~14 ms
  for the verdict CTE and its canonical test, ~10 ms for the final aggregate. There is no sort node and no temp
  spill in this query.

Options measured and deliberately not adopted:

| Option | Effect | Verdict |
| --- | --- | --- |
| `= ANY (ARRAY(subquery))` for the Session set | Removes the 100,001 probes; kernel 100.15 → 75.57 ms with an identical row checksum | A real gain that still misses 50 ms; not adopted, because the remaining time is dominated by the detoast and aggregation the semantics require |
| `jsonb_to_record` in a lateral | Reported 147.69 ms once the record fields matched the JSON keys | Slower; an earlier "34% faster" reading was measuring NULLs from mismatched field names |
| Index on `(accepted_at, session_id)` | No plan change, 3,976 kB of index | Built, measured and dropped |
| Statistics / extended statistics | The bad estimate comes from a generic join condition, not a stale column statistic | Not a fix |
| Pre-aggregated daily usage table | Not measured; it would change the cost profile by trading read work for write work | New table, write amplification on every report, retention and backfill — rejected as out of scope, and no latency claim is made about it |

## Hot Agent list

| Case | Median ms |
| --- | ---: |
| With `im_message_deliveries_unreported_accepted_idx` (shipped) | 158.23 |
| Same fixture with that index dropped | 278.93 |

The partial index is worth 43% here and 8,192 bytes on 100,000 Deliveries; its predicate covers only Turns
awaiting a report, so it shrinks as reports arrive and never grows with history. Rebuilding it on this fixture took
178 ms. Its write cost is one additional partial index maintained when a Delivery is accepted or reported.

The list still cannot beat the usage aggregate it contains: it measures about 16 ms above the usage case, and the
aggregate alone costs 142 ms.

## Internal Session page: 114.11 → 1.48 ms

With 90,000 of 100,000 descendants ended, the removed SQL walked the activity index and probed `sessions` once per
candidate. The submitted page reads `session_descendants_ancestor_activity_active_idx` and touches 21 rows; the
analyzed plan is an index scan on the partial index plus 21 `sessions_pkey` lookups. The active-tree page stays at
0.83 ms, so the partial index did not trade one case for the other.

## Closure write and storage

Ending 90,000 descendants through the production path took 1,081 ms for the `sessions` update and 1,084 ms for
`markEndedDescendantsInactive` on the 100,000-row closure table in this run. Production lifecycle calls end the
Sessions of one binding or one Agent, so their cost follows that subset rather than 90,000 rows. The invariant held:
10,000 active, 90,000 inactive, zero rows disagreeing with `sessions.ended_at`.

On the 100,000-row closure table: 25,518,080 bytes of table, 13,795,328 for
`session_descendants_ancestor_activity_active_idx`, 15,351,808 for the depth variant. Those two were built while
every row was still active and keep dead entries until the table is vacuumed; the legacy indexes they replaced
measured 7,725,056 and 8,626,176 bytes when built on the 10% active state.

## Provenance and reproduce

Tracked in the repository: `packages/server/scripts/benchmark-agent-session.ts` (entry),
`packages/server/scripts/agent-session-benchmark.ts` (flow and assertions),
`packages/server/scripts/agent-session-seed.sql` (fixture), `packages/server/scripts/__tests__/agent-session-benchmark.test.ts`
(30 unit cases over the flow with an embedded PostgreSQL) and `results.json` (this run).

```bash
pnpm install --frozen-lockfile
pnpm --filter @opentag/shared build
pnpm exec tsx packages/server/scripts/benchmark-agent-session.ts            # writes testing/performance/agent-session/results.json
pnpm exec tsx packages/server/scripts/benchmark-agent-session.ts --out /tmp/bench   # keeps the checkout clean
```

`OPENTAG_BENCHMARK_OUT` does the same as `--out`. The harness waits for the container to answer before migrating
(a published port is not a ready server), recreates its admin client per readiness attempt because postgres.js
caches a fatal startup error, and removes its container and volume in `finally` — including when a case throws or
the database never becomes ready. A run is rejected unless every required case ran, recorded no error, produced all
five samples, proved the two usage bodies equal, and removed its container.

## Limits

Sequential, mostly warm local benchmark of three reads and one write path. It does not cover HTTP, cold storage,
concurrent load, wider payloads or other service methods. The fixture's distribution is deliberately uneven — one
binding owns 100,001 Sessions and 50,000 Deliveries — and is not a production sample.
