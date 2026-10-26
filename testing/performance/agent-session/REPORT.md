# Agent usage and internal Session page benchmark

Supports [Agent usage accounting](../../../docs/system/agent-usage.md) and
[Internal Session collaboration](../../../docs/system/messaging/internal-session-collaboration.md).

## Scope

Two approved reads and one write path:

- The 30-day Agent usage detail (`AgentService.getUsageById`), which returned one row per accepted Delivery.
- The Agent list (`AgentService.listForAccount`), which shares the same 30-day window and the two
  unreported-accepted-Delivery reads.
- The internal-Session page (`SessionService.listInternalSessions`) after 90,000 descendants have ended, which
  read the closure activity index and then asked `sessions` about every candidate it walked.

The numbers below are local microbenchmarks, not production capacity or SLO evidence.

## Environment and method

- Fixture: 39 application tables, each with at least 100,000 rows, 4,000,000 rows in total; `sessions` has
  200,000. Every migration in the chain runs before seeding, every constraint and index stays enabled, and
  `ANALYZE` runs before measurement.
- One owned PostgreSQL 17.11 container on a random loopback port, removed in `finally`. The script never reads
  `DATABASE_URL`, and no production or shared database is touched.
- Database size after seeding: 1,262,608,911 bytes. `shared_buffers=128MB`, `work_mem=4MB`,
  `max_connections=100`, the service's default 20-connection pool and default deadlines.
- One warm-up plus five sequential samples per case; the median is reported. Elapsed time includes Node.js
  mapping and loopback transport, and no HTTP layer.
- Each distinct SELECT gets one extra untimed `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)`. Parameter
  values are not stored.
- The `.before` cases rebuild the removed implementations in the same process and against the same fixture:
  the previous usage read (Drizzle row select of every Delivery in the window plus the in-JavaScript token
  loop) and the previous page SQL with the two legacy non-partial activity indexes created for the measurement
  and dropped afterwards.

## Results

| Case | Median ms | SQL per call | Bounded result | Response bytes |
| --- | ---: | ---: | --- | ---: |
| `agents.usage.50000-deliveries.before` | 121.33 | 1 | rowsRead=50000 | 150 |
| `agents.usage.50000-deliveries` | 93.32 | 3 | dailyBuckets=31 | 4147 |
| `agents.list.1-agents` | 184.28 | 4 | agents=1 | 546 |
| `agents.list.1-agents.with-candidate-index` | 118.56 | 4 | agents=1 | 546 |
| `sessions.internal.100000-active.limit20` | 0.49 | 1 | items=20 | 5566 |
| `sessions.internal.90000-ended.limit20.before` | 86.59 | 1 | items=20 | 6613 |
| `sessions.internal.90000-ended.limit20` | 0.95 | 1 | items=20 | 5635 |

### Agent usage detail: 121.33 ms → 93.32 ms, 50,000 rows → 31 buckets

The response now carries the daily series and 4,147 bytes instead of 50,000 Delivery rows to aggregate in Node.
Both figures are from the same run, so the 23% difference is the change and not machine load.

The first implementation of this read was slower than what it replaced, at 162 ms. The diagnosis, from
isolated `EXPLAIN (ANALYZE)` runs on the same fixture:

| Shape | Median ms |
| --- | ---: |
| Scan + join of the window's 50,000 Deliveries (`count(*)`) | 35 |
| ... plus extracting the three usage values per row | 35 |
| ... aggregated into 13 day buckets with three `numeric` sums | 63 |
| ... with three regex validity filters added | 68 |
| Same CTE, but the canonical test written inside every `FILTER` and `sum` (18 evaluations per row) | 157 |
| Verdict boolean computed inside the projection (6 extractions per row) | 112 |
| Accepted: two materialized CTEs, verdict computed once, seven cheap aggregates | 93 |

Two defects produced the 162 ms: the projected CTE row was wide enough to spill its tuplestore (427 temp
blocks against a 4 MB `work_mem`), and the canonical predicate was re-evaluated inside each of six aggregates,
which re-ran three regex tests on every row per aggregate. The correction read for non-canonical reports also
ran on every call; it is now gated by a count the aggregate itself returns and bounded at 1,000 rows.

The 93 ms is not below the ~50 ms the plan hoped for. The floor on this fixture is the scan: 35 ms of the
93 ms is spent reaching the window's rows through the hot binding's 100,001 Sessions. The remaining ~58 ms is
the aggregate work itself, which the pre-change path paid in Node.js instead.

### Internal Session page: 86.59 ms → 0.95 ms

With 90,000 of 100,000 descendants ended, the old shape read the activity index in order and probed `sessions`
once per candidate (90,021 probes for a page of 20 in the audit run). The page now reads
`session_descendants_ancestor_activity_active_idx` and touches 21 rows: the plan's `sessions` access is the
`OK` lookups for the items it returns. The active tree page stays at 0.49 ms, so the partial index did not
trade one case for the other.

### Hot Agent list: target missed, at 184.28 ms

The Agent list misses the 100 ms target in this run; the previous run of the same code measured 163.60 ms and
159.72 ms, so load moves this figure by roughly 15%. Two statements dominate it:

- Two unreported-accepted-Delivery reads cost about 40 ms each. They join `im_message_deliveries` to the
  Agent's bindings through `sessions`, so for a hot binding they walk 100,001 Session rows and probe deliveries
  once per Session to find no rows.
- The 30-day usage aggregate costs about 103 ms, of which 56 ms is the same Session walk.

A partial index on `im_message_deliveries (accepted_at, id, session_id) WHERE state = 'accepted' AND
reported_at IS NULL` was built (114.99 ms, 8,192 bytes), measured at 118.56 ms for the list, and then dropped:
PostgreSQL also starts choosing it inside the IM delivery work query, whose plan test in
`im-delivery-query.test.ts` requires the dedicated active-work index alone. That query belongs to another
owner, so the index is measured evidence here, not a shipped change. The case stays in the harness so the
next owner can repeat it.

### Write and storage cost of the closure flag

Ending 90,000 descendants through the production path took 630 ms for the `sessions` update and 662 ms for
`markEndedDescendantsInactive`, on the 100,000-row closure table. Production lifecycle calls end the Sessions of
one binding or one Agent, so their cost scales with that subset, not with 90,000 rows. The invariant held after
the write: 10,000 active and 90,000 inactive rows, with zero rows disagreeing with `sessions.ended_at`.

Storage on the 100,000-row closure table: 25,518,080 bytes of table, 13,795,328 bytes for
`session_descendants_ancestor_activity_active_idx` and 15,351,808 bytes for the depth variant. Those two were
built while every row was still active and keep the dead index entries until the table is vacuumed or
reindexed; the legacy indexes they replaced measured 7,725,056 and 8,626,176 bytes when built on the 10%
active state at the end of the run. Every closure insert and activity update now maintains two partial indexes
instead of two full ones, so the write cost is lower for rows that are already inactive and unchanged for the
first activity of an active row.

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm --filter @opentag/shared build
pnpm exec tsx packages/server/scripts/benchmark-agent-session.ts            # writes testing/performance/agent-session/results.json
pnpm exec tsx packages/server/scripts/benchmark-agent-session.ts --out /tmp/bench   # keeps the checkout clean
```

`OPENTAG_BENCHMARK_OUT` does the same as `--out`. The script creates its own container on a random loopback
port, seeds every business table with at least 100,000 rows from `packages/server/scripts/agent-session-seed.sql`,
runs the real migrations, checks every table count, and removes its container and volume in `finally`. A forced
kill can bypass cleanup; anything left behind carries the label `opentag.benchmark=agent-session`.

## Limits

This is a sequential, mostly warm local benchmark of three reads and one write path. It does not cover HTTP,
cold storage, concurrent load, wider payloads, or other service methods. The fixture's distribution is
deliberately uneven — one binding owning 100,001 Sessions and 50,000 Deliveries — and is not a production
sample. Figures are medians of five samples on one machine, and the Agent list figure moved by about 15%
between runs of the same code.
