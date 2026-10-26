---
title: "Task query benchmark: Task list and Task detail at 100,000 rows per table"
description: "Before and after measurement of the Task list page, the legacy complete detail and the bounded detail sections on the supplied 100,000-rows-per-table fixture."
---

# Task query benchmark

This record measures the Task read paths only: the Account Task list, the legacy complete detail
(`GET /api/v1/sessions/:id`, kept for callers written against its contract), and the bounded detail
(`GET /api/v1/sessions/:id/detail` with its three section routes). It does not re-measure the other
domains in the earlier database audit.

## Scope and environment

The fixture is the audit fixture replayed by this lane's own seed
(`packages/server/scripts/task-queries-fixture.sql`): every application table in `public` and
`billing` holds at least 100,000 rows, `sessions` holds 200,000, and all 69 real migrations run before
insertion with constraints and indexes enabled. `ANALYZE` runs before measurement. History is
account-shaped: one private chat with 50,000 messages and 50,000 deliveries plus 100,000 internal
descendants, an account with ten Agents and 25,000 messages across ten channels, and a long tail.

Two fixture adaptations, part of the tracked seed rather than hand edits:

- 50 `session_messages` rows carry a `scheduled_origin` and a NULL source Session, so the
  scheduled-origin branch of the collaboration read is exercised rather than only the
  source-Session branch.
- The audit's later step that marks 90,000 internal Sessions as ended is not replayed; this record
  does not measure the internal-session listing of the Session domain.

| Item | Value |
| --- | --- |
| Source before | `d2fc9e8aa045dc1a214ab3f0a953cbdcde088c92` (unmodified base) |
| Source after | `e8c38f95c3a3646bc1a4794c2b4e4d41649714e5` |
| PostgreSQL | 17 (`postgres:17-alpine`), `shared_buffers=128MB`, `work_mem=4MB`, `max_connections=100` |
| Node.js | 24.19.0, macOS arm64 |
| Service client | 20-connection pool, 30 s statement timeout, 35 s query timeout (defaults) |
| Database size | 1,262,608,911 bytes (before) / 1,262,625,295 bytes (after) |
| Rows verified | 39 tables, each at or above 100,000 |
| Method | one warm-up and five sequential samples per case; `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)` once per distinct SELECT, outside the timed samples |

The harness owns one disposable loopback-only container and removes it in `finally`. It never reads
`DATABASE_URL` or a `.env` file. Elapsed time includes Node.js mapping and loopback transport and
excludes HTTP. SQL counts come from the service query logger. This is a sequential local
microbenchmark, not a concurrency or production-capacity measurement.

Reproduce:

```bash
pnpm install --frozen-lockfile
pnpm --filter @opentag/shared build
pnpm exec tsx packages/server/scripts/benchmark-task-queries.ts --phase after
# A verification run writes elsewhere and leaves the committed evidence untouched:
pnpm exec tsx packages/server/scripts/benchmark-task-queries.ts --phase verify --output /tmp/task-queries
```

The `before` numbers come from the same harness and fixture replayed on the unmodified base, where
the bounded contract does not exist and those cases are skipped. Both runs record
`dirty: true` only because the evidence directory itself was present in the worktree; the recorded
commit is the source that was measured.

## Results

| Case | Before median ms | After median ms | Change | Response bytes (after) | Target |
| --- | ---: | ---: | ---: | ---: | --- |
| `tasks.list.hot-dm.limit20` | 312.420 | 237.251 | 1.3x | 470 | under 500 ms — met |
| `tasks.list.10-agents.25000-messages.limit20` | 2859.992 | 142.575 | 20.1x | 8,979 | under 500 ms — met |
| `tasks.list.10-agents.page2` | 3124.092 | 152.430 | 20.5x | 8,997 | under 500 ms — met |
| `tasks.detail.legacy.hot-dm.limit20` | 30010.953 (timeout) | 1054.727 | completes | 57,228,719 | versioned legacy, not targeted |
| `tasks.detail.legacy.10-agents.limit20` | 628.946 | 573.557 | 1.1x | 1,304 | versioned legacy, not targeted |
| `tasks.detail.bounded.hot-dm.limit20` | not measured | 1822.259 | - | 27,942 | under 1,000 ms — **missed** |
| `tasks.detail.bounded.10-agents.limit20` | not measured | 1223.491 | - | 1,370 | under 1,000 ms — **missed** |
| `tasks.detail.bounded.hot-dm.turns.page2` | not measured | 194.687 | - | 15,750 | under 1,000 ms — met |
| `tasks.detail.bounded.hot-dm.internal-sessions.page2` | not measured | 685.497 | - | 4,330 | under 1,000 ms — met |
| `tasks.detail.bounded.hot-dm.collaboration-messages.page2` | not measured | 700.946 | - | 7,370 | under 1,000 ms — met |
| `tasks.replies.hot-dm.limit20` | 12.752 | 13.487 | 1.0x | 30 | unchanged path |

`tasks.detail.bounded.hot-dm.limit20` costs 1.82 s because it answers one page of **all three**
sections in one request, and the two history-bound sections are 686 ms and 701 ms of it (see below).
Run-to-run medians vary by roughly 10%; an earlier run of the same source measured 1.68 s for this
case and 0.96 s for the ten-Agent case.

## What changed in the plans

Row flow below is the sum of `actual rows × loops` over every plan node, and "removed" is the sum of
`rows removed by filter` and `rows removed by join filter`; both come from the analyzed plans of the
first distinct SELECT of each case, in `explain/before/` and `explain/after/`.

| Case | Before | After |
| --- | --- | --- |
| `tasks.list.10-agents…` first page | 63,823,615 rows flow through the plan and 63,000,449 are discarded; a nested loop pairs the 21 page rows with every message rollup through `NOT (topic_key IS DISTINCT FROM …)`, and one join filter alone rejects 62,475,000 candidates. 3,892 ms plan | 900,990 rows flow and 25,470 are discarded; two disjoint equality branches (a concrete topic key, or both keys NULL) replace the NULL-safe residual, and the rollups are one ordered pass. 189 ms plan |
| `tasks.list.10-agents…` second page | 63,823,595 rows flow, 63,000,469 discarded, 4,201 ms plan | 900,910 rows flow, 25,490 discarded, 181 ms plan |
| `tasks.list.hot-dm…` | 1,550,046 rows flow, 350,000 discarded, 339 ms plan | 1,250,045 rows flow, 300,002 discarded, 256 ms plan — this account has one topic holding the whole history, so its cost is the history scan itself, not the join |
| `tasks.detail.legacy.hot-dm…` | statement timeout after 30 s; the related-session set also exceeded the driver's parameter limit at 100,001 ids | SQL-only collaboration read, so no id list crosses the boundary: 1.05 s including a 57 MB answer |
| `tasks.detail.bounded.hot-dm…` | contract did not exist | authorization, summary and three section pages from one read-only Repeatable Read snapshot: 7 statements, 1.82 s |

Every after-phase plan for the list and the bounded detail is in [`explain/after/`](explain/after/),
one file per distinct SELECT, with SQL, actual rows, loops, buffers and timing. The before-phase
plans are in [`explain/before/`](explain/before/). Raw samples, query counts, response sizes and
errors are in `results-before.json` and `results-after.json`.

## Residual limits, stated honestly

- **The bounded detail's first page misses its 1 s target on this fixture.** The page itself is
  bounded — the three sections return 20 rows each — but the fixture makes one topic own 100,000
  Internal Sessions and 100,000 collaboration messages, and each of those two sections must read its
  history once to decide which rows come first. The measured split of the 1.82 s is 0.25 s summary,
  0.20 s Turns, 0.69 s Internal Sessions and 0.69 s collaboration messages (analyzed plans of the
  four statements in `explain/after/tasks.detail.bounded.hot-dm.limit20-{4..7}.json`).
- **A later section page costs about the same as the first.** The keyset cursor bounds the answer,
  not the scan: the related-session set is derived per request because it is not stored. Making
  paging cost follow the page size needs either indexes that support it — an ordered `sessions`
  path for the topic filter and an ordered `session_messages` path for a session set — or a
  maintained relation table with its own write cost and cleanup. Both are schema decisions outside
  this change, and the audit's own guidance is to validate them with these plans first.
- The ten-Agent bounded detail (1.22 s) shares the cause: its two history sections still read the
  channel's history to cut one page each.
- The legacy complete detail is unchanged in contract and is still expensive by design: it returns
  every related Internal Session and collaboration message, which is 57 MB and 1.05 s here. It is
  kept explicitly versioned so no reader receives a silently truncated answer.
- `tasks.replies` is unchanged; its fixture history is empty, so its timing establishes nothing
  about a populated reply history.
- Local numbers are targets for this fixture, not production claims. The distribution is synthetic
  and deliberately uneven; it shows where work grows with history, not what production looks like.
  Passing here does not establish behaviour under concurrent load, cold storage, or a different
  history shape.
