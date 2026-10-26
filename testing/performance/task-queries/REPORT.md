---
title: "Task query benchmark: Task list and Task detail at 100,000 rows per table"
description: "Before and after measurement of the Task list page, the legacy complete detail, and the bounded detail first pages and section continuations on the supplied 100,000-rows-per-table fixture."
---

# Task query benchmark

This record measures the Task read paths only: the Account Task list, the legacy complete detail
(`GET /api/v1/sessions/:id`, kept for callers written against its contract), and the bounded detail
(`GET /api/v1/sessions/:id/detail` with its `sections` selection, plus one route per section). It does
not re-measure the other domains in the earlier database audit.

## Scope and environment

The fixture is the audit fixture replayed by this lane's own seed
(`packages/server/scripts/task-queries-fixture.sql`): every application table in `public` and
`billing` holds at least 100,000 rows, `sessions` holds 200,000, and all 69 real migrations run before
insertion with constraints and indexes enabled. `ANALYZE` runs before measurement. History is
account-shaped: one private chat with 50,000 messages and 50,000 deliveries plus 100,000 internal
descendants, an account with ten Agents and 25,000 messages across ten channels, and a long tail.

Two fixture adaptations belong to the tracked seed rather than to hand edits:

- 50 `session_messages` rows carry a `scheduled_origin` and a NULL source Session, so the
  scheduled-origin branch of the collaboration read is exercised rather than only the
  source-Session branch.
- The audit's later step that marks 90,000 internal Sessions as ended is not replayed; this record
  does not measure the internal-session listing of the Session domain.

| Item | Value |
| --- | --- |
| Source before | `d2fc9e8aa045dc1a214ab3f0a953cbdcde088c92` (unmodified base) |
| Source after | `f40b7a493bd2` (`dirty: false`), executed end to end |
| PostgreSQL | 17 (`postgres:17-alpine`), `shared_buffers=128MB`, `work_mem=4MB`, `max_connections=100` |
| Node.js | 24.19.0, macOS arm64 |
| Service client | 20-connection pool, 30 s statement timeout, 35 s query timeout (defaults) |
| Database size | 1,262,608,911 bytes (before) / 1,262,633,487 bytes (after) |
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

The `before` numbers come from the same harness and fixture replayed on the unmodified base, where the
bounded contract does not exist and those cases are skipped.

## Results

Targets from the approved plan: the bounded first page under 1,000 ms, and every list page under
500 ms. The bounded first page is measured twice because the two are different requests: the page the
Web reads (`sections=turns`, summary plus Turns) and the page that asks for every section.

| Case | Before median ms | After median ms | SQL per call | Response bytes | Target |
| --- | ---: | ---: | ---: | ---: | --- |
| `tasks.list.hot-dm.limit20` | 312.420 | 221.3 | 1 | 470 | under 500 — met |
| `tasks.list.10-agents.25000-messages.limit20` | 2859.992 | 141.5 | 1 | 8,983 | under 500 — met |
| `tasks.list.10-agents.page2` | 3124.092 | 140.9 | 1 | 9,001 | under 500 — met |
| `tasks.detail.hot-dm.turns-only.limit20` | not measured | **427.6** | 5 | 16,200 | under 1,000 — met |
| `tasks.detail.10-agents.turns-only.limit20` | not measured | **25.2** | 5 | 1,265 | under 1,000 — met |
| `tasks.detail.hot-dm.all-sections.limit20` | not measured | 1762.3 | 7 | 27,954 | **missed — exception, see below** |
| `tasks.detail.10-agents.all-sections.limit20` | not measured | 963.8 | 7 | 1,370 | met, but only by 36 ms |
| `tasks.detail.hot-dm.turns.page2` | not measured | 210.6 | 4 | 15,754 | under 1,000 — met |
| `tasks.detail.hot-dm.internal-sessions.page2` | not measured | 686.4 | 4 | 4,334 | under 1,000 — met |
| `tasks.detail.hot-dm.collaboration-messages.page2` | not measured | 677.8 | 4 | 7,374 | under 1,000 — met |
| `tasks.detail.legacy.hot-dm.limit20` | 30010.953 (timeout) | 1029.4 | 6 | 57,228,723 | versioned legacy, not targeted |
| `tasks.detail.legacy.10-agents.limit20` | 628.946 | 510.9 | 6 | 1,304 | versioned legacy, not targeted |
| `tasks.replies.hot-dm.limit20` | 12.752 | 11.5 | 2 | 30 | unchanged path |

The five statements of a `sections=turns` first page are: the read-only transaction setting, the
message-to-channel lookup, the topic classification, the summary rollup, and the Turn page. The seven
of the all-sections page add the Internal Session page and the collaboration page.

The one miss is stated rather than smoothed over: the **all-sections first page** takes 1.76 s on the
hot fixture. The next section attributes that to plan nodes; it is an exception for user disposition,
not a target met, and the Web never issues that request.

## What changed in the plans

Row flow below is the sum of `actual rows × loops` over every plan node, and "removed" is the sum of
`rows removed by filter` and `rows removed by join filter`; both come from the analyzed plans of the
first distinct SELECT of each case, in `explain/before/` and `explain/after/`.

| Case | Before | After |
| --- | --- | --- |
| `tasks.list.10-agents…` first page | 63,823,615 rows flow through the plan and 63,000,449 are discarded; a nested loop pairs the 21 page rows with every message rollup through `NOT (topic_key IS DISTINCT FROM …)`, and one join filter alone rejects 62,475,000 candidates. 3,892 ms plan | 900,990 rows flow and 25,470 are discarded; two disjoint equality branches (a concrete topic key, or both keys NULL) replace the NULL-safe residual, and the rollups are one ordered pass. 189 ms plan |
| `tasks.list.10-agents…` second page | 63,823,595 rows flow, 63,000,469 discarded, 4,201 ms plan | 900,910 rows flow, 25,490 discarded, 181 ms plan |
| `tasks.list.hot-dm…` | 1,550,046 rows flow, 350,000 discarded, 339 ms plan | 1,250,045 rows flow, 300,002 discarded, 256 ms plan — this account has one topic holding the whole history, so its cost is the history scan itself, not the join |
| `tasks.detail.legacy.hot-dm…` | statement timeout after 30 s; the related-session set also exceeded the driver's parameter limit at 100,001 ids | SQL-only collaboration read, so no id list crosses the boundary: 1.06 s including a 57 MB answer |
| `tasks.detail.hot-dm.turns-only…` | contract did not exist | summary 251 ms + Turns 223 ms inside one read-only Repeatable Read transaction; the sections the Web does not render are not read at all |

## Plan-node attribution

Every number below comes from the `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)` of the same
statement, parameters, authorization filters and paging boundary the service issues; the files are in
`explain/after/`. "Exclusive" is the node's own time after subtracting its children, so the rows add up
to the statement that dominated each case.

| Case and statement | Dominant nodes (exclusive ms) | Rows: estimated vs actual | Buffers / heap | Reading |
| --- | --- | --- | --- | --- |
| `tasks.list.hot-dm` 253.0 ms | `CTE Scan topics` 177.6; `CTE Scan message_topics` 65.5 | topics est 1 / act 1 over 50,000 aggregated executions; message_topics est 11 / act 0 | 764,449 shared hits, 0 reads | A 20-row page pays for one full pass over the topic's 50,000 deliveries: two 50,000-loop index probes inside the `executions` CTE (~50 ms each) plus the window aggregate that `distinct on` then reduces to one row. `LIMIT 20` cannot bound it, because status and ordering need every execution. |
| `tasks.list.10-agents` 161.2 ms | `CTE Scan topics` 102.3; `CTE Scan message_topics` 40.7 | topics est 6 / act 25,000 | 382,224 hits | Same shape at 25,000 rows; cost tracks history size, which is why the before-plan's 63 M discarded join rows mattered. |
| `tasks.detail.hot-dm.turns-only` 226.8 ms | three index scans at 50.0 ms each (`im_message_deliveries` × 2, `im_messages`) with 50,000 loops; `Nested Loop` 28.0 + 26.1 | est 1 / act 1 per loop, 50,000 loops each | 401,638 hits; the `thread_owned` index-only probe shows 14,448 heap fetches | The Turn page itself is 21 rows, but `executions` derives the topic's whole execution set first: one delivery lookup per message, one Session lookup, one message lookup. |
| `tasks.detail.hot-dm.internal-sessions.page2` 721.1 ms | `Limit` 524.8 (above a materialized CTE); `CTE Scan internal_related` 188.7; `CTE Scan spawned` 112.2; `Aggregate` 181.3 total / 57.1 exclusive | internal_related est 2,894,362 / act 100,000; spawned est 8,669,871 / act **0** | 387,858 hits; spawned alone 386,224 | The keyset filter is applied row by row *above* the materialized `internal_related` set, so the `LIMIT 21` cannot push into it, and the recursive `spawned` CTE is evaluated in full — ~112 ms and 386k buffer touches — to return no rows at all. |
| `tasks.detail.hot-dm.collaboration-messages.page2` 731.4 ms | `Limit` 380.0; `Gather Merge` 173.2; `CTE Scan related_sessions` 160.5; `CTE Scan spawned` 114.0 | related_sessions est 8,683,087 / act 100,001; spawned est 8,669,871 / act 0 | 391,999 hits | Membership is tested against a 100,001-id derived set, so the plan cannot use an ordered index on `session_messages`; it reads the messages and sorts instead. The recursive `spawned` CTE costs the same ~114 ms for zero rows. |
| `tasks.detail.legacy.hot-dm` 1,029.4 ms (and the all-sections page's two extra sections) | the same two section statements, 686.4 + 677.8 ms | as above | as above | The legacy complete detail and the all-sections page are the sum of the two slow sections plus the fast ones, which is why they sit above one second. |

What the plans establish, and what they do not:

- The list and the Turn page are dominated by deriving a topic's execution set per request; that is
  proportional to the topic's history, not to the page. Bounding it further needs a stored rollup
  (last activity and status per topic) with its own write path.
- The two history sections are dominated by materialising a derived set of 100,000 Sessions per
  request, and by the recursive `spawned` CTE returning zero rows for ~112 ms and ~386k buffer touches.
  Bounding those pages needs either an index that can serve the derived-set order or a maintained
  relation table.
- No index scan in these plans is mistakenly treated as efficiency: the 50,000-loop scans are exactly
  the work being questioned, and their loop counts, buffer counts and estimate errors are recorded above.

## Simple options considered and not taken

Each of these was rejected because it either changes semantics or moves cost rather than removing it;
none was implemented, and the schema was not expanded.

| Option | Why it is not taken |
| --- | --- |
| Push the keyset `LIMIT` inside the `internal_related` CTE | The page is cut after `UNION` deduplication and ordering, so cutting earlier changes which rows a page contains. |
| Replace the recursive `spawned` CTE with a direct join on `created_by_session_id` | That drops descendants beyond one level, which the documented Internal Session attribution requires. |
| `LATERAL` probe per related Session instead of one set membership test | 100,000 index probes per page in the worst case; it moves the cost and makes it depend on the set size again. |
| New index on `session_messages(created_at)` | Helps only the collaboration ordering, not the derived-set cost, and adds a migration and write cost for one section. |
| Summary/rollup table or materialized view for topic status and related Sessions | Removes the read cost but introduces write amplification, reconciliation and retention semantics; that is a material architecture decision outside the approved design. |
| Session-plan hints (`SET LOCAL`) inside the read | Planner tuning that can regress other Account shapes and hides the structural cost; it is not evidence of a fix. |

## Evidence set

`explain/before/` holds 14 plan files and `explain/after/` holds 46: one per distinct SELECT per
measured case, each referenced from the `explainFile` of its statement in the matching
`results-*.json`. They are kept because a query change is reviewed against the plan, not against the
median; a run that regenerates them with `--output /tmp/task-queries` leaves this set untouched, so it
is one copy of the evidence rather than one per run.

## Residual limits

- Local numbers are targets for this fixture, not production claims. The distribution is synthetic and
  deliberately uneven; it shows where work grows with history, not what production looks like. Passing
  here does not establish behaviour under concurrent load, cold storage, or a different history shape.
- `tasks.replies` is unchanged, and its fixture history is empty, so its timing establishes nothing
  about a populated reply history.
- The ten-Agent bounded detail answers in 25 ms because those channels hold few Turns; the hot
  account is the case that shows the summary rollup's cost.
- The all-sections first page and the legacy complete detail are **unmet latency exceptions**, recorded
  for user disposition rather than fixed: their cost is the two history-bound section statements
  (686.4 ms and 677.8 ms), and the plan analysis above shows why a bounded change cannot remove it
  without moving cost into a stored rollup or relaxing what the sections must return.
