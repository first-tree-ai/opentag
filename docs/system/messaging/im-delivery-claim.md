---
title: IM delivery claim queries
description: Indexed delivery selection, in-memory eligibility hints, transactional custody checks, and the offline retry and termination policy.
---

# IM delivery claim queries

The delivery worker reads due work from `im_message_deliveries` in pages instead of joining Session,
binding, Agent, placement, Computer, and message history inside a correlated occupancy query.
This keeps blocked input from repeatedly probing reported or cancelled history.

## Selection and authority

`ImDeliverySelector` reads at most eight pages of 128 candidates per scan. The keyset is
`(next_attempt_at, id)`; its timestamp stays in PostgreSQL text form to preserve microseconds.
The global cursor advances over blocked rows and survives polling rounds. Each sweep fixes its due
boundary, then wraps to discover newly due inputs behind the cursor. Ready notifications use a
separate Session-scoped scan. A worker serializes claim scans and coalesces timer ticks while one
is pending. Runtime execution in different lanes remains concurrent, and a lane that becomes ready
again re-enters delivery admission behind lanes that were already waiting, so sustained work on one
lane cannot starve another.

Session, placement, binding, Agent, and Computer metadata is fetched in batches through existing
keys, then joined in memory. The hint cache holds at most 2,048 Sessions for five seconds. Ready
notifications and attempted claims invalidate their Session; stopping the worker clears the cache.
Custody is loaded fresh for each scan and grouped in memory by Agent and Session. Local custody
remains Agent-wide; Cloud custody remains Session-scoped and also respects Local custody for the
same Agent. These snapshots can postpone eligibility, but cannot authorize a dispatch.

For each selected candidate, a short transaction takes the Agent advisory lock, locks the delivery
by primary key with `FOR UPDATE SKIP LOCKED`, and re-reads eligibility, metadata, and custody without
the hint cache. It checks the expected Agent identity and Cloud queue head again before persisting
the existing claim marker or recovery lease. Each scan attempts at most eight such transactions.
Pending ingress expiry uses the database clock, as before. The existing dispatch, steer, receipt,
report, cancellation, retry, and timeout state transitions still apply.

## Runtime budget and accepted recovery

Message retention is an ingress deadline, not an execution budget. A Local or Cloud Client Turn
uses the explicit `runtime.budget.maxDurationMs`, or the existing 30-minute default when it is
absent, then takes the smaller of that budget and the remaining message deadline. An explicit
budget may exceed the default. An already expired request produces a timeout report without
starting the Provider, with `executionEffects: not_started`. Execution and Slack activity use the
same budget calculation; a running Provider must still honor abort and complete its native cleanup
before the Client can report. A Client upgrade does not change an already running Turn's timer.

For accepted Local custody, a reconcile response does not settle the delivery. `busy`, `running`,
`reporting`, `recovery_required`, and `rejected` are recorded as distinct deferred status codes.
`ready` and `stopped` without a recorded report mean `IM_DELIVERY_RECOVERY_AWAITING_REPORT`.
`busy`, `running`, and `reporting` keep the operation span's `deferred` outcome and retry metric
without emitting an error diagnostic. Transport failures, `rejected`, `recovery_required`, and
unreported `ready`/`stopped` responses remain diagnostic. The stopped reconciliation used here
returns `busy / active_turn` for live activity; `running` and `reporting` are handled defensively,
not observed from this request shape.
These responses and reconcile transport failures use the existing capped exponential schedule:
2, 4, 8, 16, then 30 seconds, based on the post-claim attempt count. A retry update applies only
while the delivery is still accepted, unreported, and at that attempt; a late report or newer
attempt wins. The response never fabricates a report, expires accepted custody, or dispatches
the input again. Only the actual report settles custody.

The expiry pass also sweeps accepted custody that no work path can reach any more: an ended Session,
an inactive binding, a deleted Agent, or a superseded placement generation puts the row outside
`#recover`'s query, outside the selector, or behind a custody fence a report can no longer satisfy.
That sweep is bounded by the same batch size, requires the row to be provably past the
report-acceptance window, skips a row that another worker currently claims, and writes the same
`unknown` report, so it settles the rows it selects. It covers
Local custody only; Cloud custody stays with the Cloud owner's own acceptance cutoff.

A superseded placement needs one difference. `PostgresRuntimeCustodyStore` requires the delivery's
generation, the report's generation, and the current `session_placements.generation` to agree, and a
rollover makes the delivery's historical generation differ from the current one for good — so
`recordTurn` refuses a report for it (measured: `stale_generation`) and cannot settle it. The sweep
therefore settles that case with a fenced write of its own: in one transaction it locks the delivery
with `select … for update` and requires accepted and unreported state, no recorded `result_hash`, the
acceptance window closed, a superseded generation, no live claim marker, and Local custody — then
writes the same report body, keeps the delivery's own historical `placement_generation` (it is never
re-anchored), and records `reason = placement_superseded`. It does not consult
`report_owner_instance_id`: a superseded generation cannot report whatever instance is live now.
The settlement takes the recovery-Session locks before it reloads the row, because
`lockSteeredRecoverySessions` and `recordTurn` both require the Session lock to precede every
placement and delivery lock; taking the delivery lock first would form a `40P01` cycle with a
concurrent non-completed report.
`recordTurn` and its fence are unchanged for every real report; a genuine report issued after the
settlement is refused by that same fence and never overwrites the recorded outcome, and the
`reported_at` gate plus the row lock make the settlement exactly once. Because the settled target now
carries a non-`completed` report, the existing steered-child recovery requeues its children on the
next sweep, as it does for any other non-completed report.

An accepted target without a recorded terminal report retains its steered children and their
target identity. Error codes, expired retry backoff, an offline Computer, and an ended Session
do not prove that execution ended and cannot requeue those children. Existing error diagnostics
remain available for investigation. Reconnecting the same report owner can settle the original
Turn through the existing report identity and ownership checks.

A recorded `completed` report keeps the children steered. Recording a valid `failed`, `cancelled`,
or `unknown` report requeues them once in the same transaction; replaying the report cannot requeue
them again. The janitor can recover children of an already recorded non-completed report or an
explicitly disposed target. A missing report therefore retains custody only until the
report-acceptance cutoff below, which the delivery worker or the expiry sweep then settles as
`unknown`; ownership fencing keeps its separate policy.

Non-completed report recovery locks the target and steered children's Sessions in ID order with
`FOR NO KEY UPDATE` before acquiring placement and delivery locks. It rechecks report identity,
placement generation, ownership, and child state under the existing locks. Completed reports keep
their existing path. The janitor first selects a bounded, unlocked set of eligible target IDs.
It processes each target in its own short transaction: take that target's Session locks with
`SKIP LOCKED`, lock and recheck the target, recover its children, then commit before taking the next
target's locks. This releases unrelated Session locks before recovery can rebuild an ended Session
and acquire the existing binding foreign-key lock. Busy Sessions or targets wait for another sweep.
Earlier targets remain committed if a later target fails; subsequent sweeps use the same state
predicates to resume idempotently. Session locks remain compatible with foreign-key `KEY SHARE`;
recovery does not upgrade them to `FOR UPDATE`. Report persistence and its child recovery still
commit or roll back together, without automatically retrying deadlocked transactions.

`busy / active_turn` can include report custody. An empty retained-report manifest does not prove
that the Client has no report on disk: live activity can prevent recovery from enumerating it.

## Offline Computer retry and delivery termination

Both failing paths — a dispatch operation that exhausts its deadline and recovery of accepted
custody with no live runtime — share one retry policy. The delay is the capped exponential attempt
schedule (2, 4, 8, 16, then 30 seconds) raised, whenever the failure is an absent runtime, by a
linear term in how long the placement Computer has been silent (`computers.last_seen_at`), adding
one second of delay per eight seconds of silence up to a 30-minute ceiling. A Computer that was never seen counts as
fully silent. The term resets on its own: registration and every heartbeat rewrite `last_seen_at`,
so the first failure after a reconnect is scheduled at the 2-second floor again.

A reconnect also makes parked retries due immediately. Registration advances `next_attempt_at` for
that Computer's pending and accepted deliveries, but only for rows parked more than one minute into
the future. A client that reconnects in a loop therefore cannot turn the backoff into a hot retry,
because a row that is already due soon is left alone.

Two terminal outcomes bound the paths, and neither needs a schema change:

- A dispatch whose frozen input exhausts the whole 30-second operation budget eight **consecutive**
  times settles through the existing terminal rejection as `state = terminal_rejected`,
  `reason = retry_exhausted`, `lastErrorCode = IM_DELIVERY_TERMINAL`, with the dispatch columns
  cleared and the IM batch released. The same input is offered to the same runtime with the same
  deadline on every attempt, so another attempt is not progress. Every other failure keeps
  retrying inside the ingress deadline, because it waits for an external state change such as a
  Client upgrade, an allocation, or capacity.
  The terminal rejection is only written while the row carries no dispatch correlation. The Server
  persists that correlation before the delivery frame leaves, so a correlated row may already be
  executing: it stays pending and is settled only after its outcome arrives, and an operation that
  never settles is abandoned without any terminal decision. A dispatch release keeps the run going
  (it is a lifecycle step, not a failure) so the cap stays reachable for an input that alternates
  "timeout on the frozen dispatch" and "release, prepare a fresh dispatch".
  The count is consecutive timeouts, never total claims: `attempt_count` grows on every claim, so a
  delivery that already failed seven times for unrelated reasons must still get its whole timeout
  budget. The count has no column of its own and rides in the existing `last_error_code`: the
  canonical `IM_DELIVERY_OPERATION_TIMEOUT` for the first timeout and
  `IM_DELIVERY_OPERATION_TIMEOUT_<n>` from the second on, replaced by any other failure code, which
  is the reset. Diagnostics, the span outcome, and the alerting pipeline always see the canonical
  code without the suffix.
- Accepted, unreported custody settles as an `unknown` Turn Report with
  `executionEffects: may_have_occurred` and `errorReason: turn_state_unknown` once no report can
  still be truthful: the platform maximum runtime from acceptance plus a one-hour grace. This
  mirrors the Cloud report-acceptance cutoff, writes `reported_at`, and therefore removes the row
  from the work set. It is a cutoff on report acceptance, not evidence that no Turn ran, so it
  never overwrites a report recorded earlier.
  A live report owner of the delivery's own placement is reconciled first and is never settled by
  the cutoff: it can still describe the Turn, so settling it there would discard a genuine result.
  The cutoff therefore only covers custody that cannot report through the work path — a Computer
  with no live runtime, or a placement generation that was superseded. The superseded case is the one
  the delivery worker cannot write at all; the expiry sweep settles it and records
  `reason = placement_superseded` (see the expiry-sweep paragraph above).

These settlements cover the shapes described above. They are not a total bound on every delivery,
and three shapes stay outside them: an operation that never settles keeps its correlated dispatch and
is reclaimed again on the retry schedule, a rollover that already carries a retained `result_hash` is
refused by both settlement paths, and a crash between a claim and its failure record loses the
consecutive-timeout count.

Each of these paths emits one diagnostic per failure run instead of one per attempt: a repeat of
the failure code already recorded for the delivery adds nothing an operator can act on. Only the
terminal settlement always emits its own line. The pre-claim code is read in the claim, so no
extra query is needed.

A timed-out attempt is recorded once, by the deadline. The aborted operation does not record a
second, contradictory failure: that write would describe the same attempt and would reset the
consecutive-timeout count the deadline just produced.

Undispatched Cloud inputs retain provider order within a Session, including an earlier input in
retry backoff or locked by another worker. A narrow `LATERAL` lookup reads each pending input's
message by primary key and lets PostgreSQL order the message fields. A persisted dispatch or claim
marker can recover even when an older provider event arrives later. Cloud head results are reused
only within one scan and are re-read during the claim transaction.

## One shared partial index

Migration `0063_im_delivery_active_work` adds only `im_delivery_work_idx(next_attempt_at, id)`.
There are no new columns, states, data rewrites, or removals of existing indexes. Its predicate is
the union of candidate work and uncertain custody, wrapped in `IS TRUE`. It includes pending claim
markers and dispatched pending inputs even when `reason` is non-null; these can still hold custody.
Reported deliveries and cancelled, undispatched deliveries are excluded.

Schema and queries share `db/im-delivery-work.ts`. Keep its fixed SQL literals and the predicate's
shape together: PostgreSQL must be able to prove a query implies a partial index predicate,
including for a generic prepared plan. See [PostgreSQL partial indexes](https://www.postgresql.org/docs/16/indexes-partial.html).
The custody query materializes only this indexed work set before filtering uncertain custody;
this prevents its OR branches from pulling historical entries back through older indexes.

Candidate pages are bounded, but reading custody costs O(active work), and a Cloud head lookup costs
O(pending inputs in that Session). Neither is constant time. The planner can choose a different
plan as data distribution changes. Track query duration, active work size, pool occupancy, and
temporary files; the PostgreSQL integration suite verifies custom and generic plans at the incident
scale and at ten times the blocked queue. A much larger live backlog may justify a dedicated
custody index later.

## Deployment and rollback

The normal migration runner uses a transaction. On a live production table, prebuild the exact
index separately with `CREATE INDEX CONCURRENTLY` before running that migration. A regular index
build blocks writes; a concurrent build allows writes but must run outside a transaction and can
leave an invalid index after failure. See [PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/16/sql-createindex.html).

1. Check for an existing index before the prebuild:

   ```sql
   SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid)
   FROM pg_index i WHERE i.indexrelid = to_regclass('public.im_delivery_work_idx');
   ```

2. Take the first statement of `0063_im_delivery_active_work.sql`, replace its opening
   `CREATE INDEX IF NOT EXISTS` with `CREATE INDEX CONCURRENTLY`, and execute that statement alone
   in autocommit mode. Keep the name, keys, and predicate unchanged. If an index already exists,
   compare its full definition with the migration and require `indisvalid` and `indisready` to be
   true. Diagnose an invalid or different definition before retrying; do not silently accept it.
3. Recheck the catalog and run `ANALYZE im_message_deliveries`. Apply the normal migration; its
   `IF NOT EXISTS` accepts the prebuilt index, and its validity check rejects a failed build.
4. Verify candidate and custody execution plans with current statistics and watch readiness, pool
   occupancy, and query duration during rollout. This change alone does not resolve stuck Turns.

The index and existing claim markers are compatible with the previous worker. An application
rollback can leave the index in place. Do not rewrite the migration ledger or cancel live work to
roll back this query change. Any later index removal should use the normal forward-migration policy.
