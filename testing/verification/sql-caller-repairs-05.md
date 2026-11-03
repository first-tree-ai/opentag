# SQL caller repairs: contention and live admission

Continues the [remediation checklist](../sql-caller-remediation.md) after
`fe78b6c2374b28c5602a9211f49e904ba8c4cd42`, based on main `8cb997b2`.
Implements the recorded minimum proposals confirmed by the instruction to fix all
findings progressively. No schema, migration, timeout, pool, queue or retry framework.

| Finding | Minimal change | Native evidence |
| --- | --- | --- |
| IM-F1 | Try the existing Agent transaction advisory key; skip a busy key before row locking or claim mutation. Preserve blocking ingress serialization, fresh authority/custody/order checks, row SKIP LOCKED and bounded scan. | With A's exact advisory fence held, the same pass accepts unrelated B, leaves A's attempt unchanged and has no advisory waiter. A is accepted after release. Existing row-lock isolation and large-history claim plans pass. |
| IM-F6 | Cap detached live Slack Inbox work at eight, using the existing pending Set. Persist each receipt before acknowledgement. Capacity/closing defers the saved input to existing recovery; add no memory queue. | On a four-connection shared pool, a cap of two admits only two fence waiters while four events are acknowledged and retained. An unrelated query works. A fresh route/Inbox/receipt-store instance recovers overflow after the logical lease boundary; four messages/deliveries persist once, with original receipt times and duplicate protection. |
| CR-F1 | Expire at most 100 in-flight calls in stable created-at/ID order, using FOR UPDATE SKIP LOCKED and guarded update in one statement. Isolate the complete per-call recovery including defer. Check stopped after issued stages and before new rows/writes. | Locked expiry and defer rows cannot strand another complete usage result. Skipped rows recover after release; startup abandon remains unchanged. Stop joins the actual lookup without issuing later row/fallback work. |
| CR-S1 | Router/result application returns early on finalization. Attempt the common pending write once outside its catch; preserve existing error observation and final-state guards. | One pending SQL attempt during a held row replaces the previous two. Failed final/fallback writes remain recoverable without another completion POST; normal pending, billing-port and finalization unit cases pass. |

Capacity review: production's factory default is 20 SQL connections. Eight live
Inbox operations plus one serial recovery operation cannot fill that pool by
waiting on this Agent fence alone. The native test uses the equivalent reduced
four-connection pool and two live admissions. This is a bound on this producer,
not a reservation or whole-service concurrency guarantee. Overflow may wait for
the existing 60-second lease before the normal five-second recovery sweep; the
clock-controlled test proves boundary/restart semantics, not wall-clock latency
under production load. Original ingress time and retention are not extended.

The expiry plan was measured before adding an index: 50,000 finalized rows plus
150 expired in-flight rows, actual source SQL, PostgreSQL EXPLAIN ANALYZE/BUFFERS.
It updates 100 rows, but sequentially filters all 50,000 history rows (about
5.3–5.4 ms here). LIMIT bounds mutations, not historical scanning. No index is
added solely from this small measured duration. Larger production history needs
its own plan, size and index-build assessment; a large concurrent build is not
silently placed in the startup migration's short budget. No production size or
latency acceptance is claimed.

## Validation

**201 distinct passing cases: 77 native PostgreSQL in Docker and 124 host
unit/API.** Ten native cases are new. Passing executions total 209: seven Cloud
cases repeat after fixture assertions are made explicit, and Slack's strengthened
fresh-owner recovery case repeats once. Three Slack tokens_revoked parameter
cases have the same abbreviated displayed title; the manifest distinguishes their
U_BOT, B_BOT and OTHER fixtures rather than merging them or rerunning for a count.

| Run | Passed | Failed | Disposition |
| --- | ---: | ---: | --- |
| Owning unit/API | 115 | 0 | Worker, Slack ingress and Cloud model/usage. |
| Selector unit | 9 | 0 | Existing authority, queue and cursor behavior. |
| New native faults | 10 | 0 | Independent real locks, shared-pool health, actual receipt/usage stores. |
| Native owning regressions | 74 | 0 | Receipt replay/retention, IM recovery, routing, 80k reported-row plans and final Cloud assertions. |
| Strengthened fresh-owner Slack test | 1 | 0 | New route/Inbox/store over persisted receipts, original receivedAt checked. |

One mistakenly overlapping Docker runner was explicitly stopped (exit 143,
zero completed cases); its replacement ran alone and passed. The interrupted log
is retained and contributes no success count. No test assertion run failed in
this batch. Initial lint errors from copied probe non-null assertions were fixed;
the ratchet's extra Slack callback branch was removed by keeping the deferred log
simple. No baseline or exception was relaxed.

The immutable image and workspace-only evidence directory match
[batch 2a](sql-caller-repairs-02.md). New native faults use PostgreSQL 17-alpine
and all 73 migrations; the existing claim-plan suite explicitly uses PostgreSQL
16-alpine. Runtime/provider/Router replies are controlled ports; native SQL,
Inbox, custody, receipts and usage recovery are real. Server typecheck and
repository gates pass. Diff review checks lock identity/lifetime, durable-before-ack,
same-executor expiry predicates, per-call error isolation and stop admission.
No independent PR review, CI, live provider, full binary shutdown, deployment or
private billing debit acceptance is inferred. Private billing implementation
remains unavailable; public schema and mock billing ports do not certify it.

These three defects and one simplification are repaired locally. The remaining
25 defects, eight simplifications and five observations keep their own scope.
