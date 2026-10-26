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
- `.before` cases rebuild the removed implementations in the same process: the previous usage read (Drizzle row
  select of every Delivery in the window plus the JavaScript token loop) and the previous page SQL with the two
  legacy non-partial activity indexes created for the measurement and dropped afterwards.
- Node.js v24.19.0, macOS arm64. These are local numbers, not production capacity.

## Final results

| Case | Median ms | SQL per call | Bounded result |
| --- | ---: | ---: | --- |
| `agents.list.1-agents` (with the shipped index) | 137.20 | 5 | agents=1 |
| `agents.list.1-agents.without-unreported-index` | 216.96 | 5 | agents=1 |
| `agents.usage.50000-deliveries` | 106.40 | 3 | dailyBuckets=31 |
| `agents.usage.50000-deliveries.before` | 143.08 | 1 | rowsRead=50000 |
| `sessions.internal.100000-active.limit20` | 0.84 | 1 | items=20 |
| `sessions.internal.90000-ended.limit20` | 1.49 | 1 | items=20 |
| `sessions.internal.90000-ended.limit20.before` | 115.42 | 1 | items=20 |

Target status, stated plainly:

| Target | Result | Status |
| --- | --- | --- |
| Agent usage detail < 50 ms | 106.40 ms | **missed** |
| Hot Agent list < 100 ms | 137.20 ms | **missed** |
| Active internal page < 10 ms without 90k ended-session probes | 1.49 ms | met |

Run-to-run spread is large on this machine because other lanes were running: the hot list measured 97.03 ms and
125.05 ms in two earlier runs of the same code, and the usage detail 94.96 ms. The report quotes this run's medians
and does not claim the better samples.

### Agent usage detail

The bounded read is faster than the unbounded one it replaced in every run: 143.08 → 106.40 ms here, 121.33 →
93.32 ms and 126.24 → 94.96 ms in earlier runs. It returns 31 day buckets and about 4 KB instead of 50,000 rows
aggregated in Node.

The 50 ms target is out of reach for this query shape on this fixture. Measured decomposition of the window:

| Step | Median ms |
| --- | ---: |
| Reaching the window's 50,000 Deliveries (bindings → 100,001 Sessions → deliveries) | 36.5 |
| Aggregate work: detoasting 50,000 turn reports and summing three `numeric` columns | ~58 |
| Total aggregate kernel | ~95 |

What was tried, and why it is not in the submitted code:

| Shape | Median ms | Outcome |
| --- | ---: | --- |
| Committed: two materialized CTEs, verdict once per row | 95.5 | submitted; end-to-end 93–106 ms |
| `usage` object extracted once, then three `->>` | 87.2 | 8 ms faster, more code; not worth the semantic surface |
| `jsonb_to_record` in a lateral, all three sums in one pass | 147.7 | **slower**, reverted |
| Index on `im_message_deliveries (accepted_at, session_id)` | 96.6 end-to-end | no plan change: PostgreSQL still drives from the binding; built 3,976 kB and dropped |
| Index on `(accepted_at)` alone | no change | same |

The `jsonb_to_record` experiment is worth recording as a mistake: the first comparison reported it 34% faster, but
the record type's field names did not match the JSON keys (`input_text` vs `inputTokens`), so the lateral produced
three NULLs and the sums had nothing to do. Adding a kernel checksum that compares both shapes row by row exposed
it. Only then did the rewrite show its real cost. A plan or a timing without a checksum can be measuring nothing.

Two changes would plausibly reach the target, and both are outside this change: a composite
`(session_id, accepted_at)` index, which helps production windows but cannot be proven on a fixture where every
Delivery is inside the window, and a pre-aggregated daily usage table, which is new schema, new write amplification
and a new retention problem.

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
| `Index Scan im_message_deliveries` (`session_id_idx`), 100,001 loops | 0 per loop | 11 | ≈44.6 ms | 204,587 hit |

Attribution: the join becomes a parameterized nested loop because the planner estimates **1** Delivery row and
**8** Sessions for a binding join. That estimate is generic — it cannot know that this binding really owns 100,001
Sessions — so the plan performs 100,001 delivery index probes that each return no row: about 45 ms of the 105 ms.
The rest is intrinsic to the read: ~25 ms materializing the 50,000-row window, ~14 ms for the verdict CTE and its
canonical test, ~10 ms for the final aggregate. There is no sort and no temp spill (all buffers are hits, no reads).

Ways to remove the 45 ms of probes without changing the schema:

| Option | Effect | Verdict |
| --- | --- | --- |
| `= ANY (ARRAY(subquery))` for the session set | Forces the Session list to be materialized and hashed, so deliveries are scanned instead of probed | Tested in a disposable database; kept only if it is both correct and clearly faster — see the recorded run |
| Statistics or extended statistics | The bad estimate comes from a generic join condition, not from a stale column statistic; `ANALYZE` is already current | Not a fix |
| Pre-aggregated daily usage | Would reach the target | New table, write amplification on every report, retention and backfill — rejected as out of scope |

Even with the probes removed, the ~50 ms of detoast and aggregation over 50,000 JSON reports stays, which is why
the 50 ms target is reported as missed rather than pursued further.

### Hot Agent list

| Case | Median ms |
| --- | ---: |
| With `im_message_deliveries_unreported_accepted_idx` (shipped) | 137.20 |
| Same fixture with that index dropped | 216.96 |

The index is worth about 80 ms (37%) on this fixture and is the difference between 97 ms and 216 ms in the best and
worst runs. It costs **8,192 bytes** on 100,000 Deliveries and a rebuild of **141 ms**; its predicate covers only
Turns awaiting a report, so it shrinks as reports arrive and never grows with history. Its cost on the write path is
one extra partial index on `im_message_deliveries`, maintained only when a row is accepted or reported.

The remaining list cost is the usage aggregate it shares with the detail read: the list measures about 30 ms above
the usage case, so it cannot reach 100 ms while that aggregate costs 106 ms.

### Internal Session page: 115.42 → 1.49 ms

With 90,000 of 100,000 descendants ended, the removed SQL walked the activity index and probed `sessions` once per
candidate. The submitted page reads
`session_descendants_ancestor_activity_active_idx` and touches 21 rows; the analyzed plan is an index scan on the
partial index plus 21 `sessions_pkey` lookups. The active-tree page stays at 0.84 ms, so the partial index did not
trade one case for the other.

### Closure write and storage

Ending 90,000 descendants through the production path took 803.80 ms for the `sessions` update and 945.10 ms for
`markEndedDescendantsInactive` on the 100,000-row closure table. Production lifecycle calls end the Sessions of one
binding or one Agent, so their cost follows that subset rather than 90,000 rows. The invariant held afterwards:
10,000 active, 90,000 inactive, zero rows disagreeing with `sessions.ended_at`.

On the 100,000-row closure table: 25,518,080 bytes of table, 13,795,328 for
`session_descendants_ancestor_activity_active_idx`, 15,351,808 for the depth variant. Those two were built while
every row was still active and keep dead entries until the table is vacuumed; the legacy indexes they replaced
measured 7,725,056 and 8,626,176 bytes when built on the 10% active state. Every closure insert and activity update
now maintains two partial indexes instead of two full ones.

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm --filter @opentag/shared build
pnpm exec tsx packages/server/scripts/benchmark-agent-session.ts            # writes testing/performance/agent-session/results.json
pnpm exec tsx packages/server/scripts/benchmark-agent-session.ts --out /tmp/bench   # keeps the checkout clean
```

`OPENTAG_BENCHMARK_OUT` does the same as `--out`. The harness waits for the container to answer before migrating
(a published port is not a ready server), recreates its admin client per readiness attempt because postgres.js
caches a fatal startup error, and removes its container and volume in `finally` — including when a case throws or
the database never becomes ready. Anything a forced kill leaves behind carries
`opentag.benchmark=agent-session`.

## Limits

Sequential, mostly warm local benchmark of three reads and one write path. It does not cover HTTP, cold storage,
concurrent load, wider payloads or other service methods. The fixture's distribution is deliberately uneven — one
binding owns 100,001 Sessions and 50,000 Deliveries — and is not a production sample. Other lanes were running on
this machine, which is why the same code measured 97–137 ms for the hot list across runs.
