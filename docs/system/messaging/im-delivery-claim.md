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

For each selected candidate, a short transaction tries the Agent advisory lock with
`pg_try_advisory_xact_lock`. A busy Agent is skipped without taking its delivery lock or changing
attempt/claim state; the same bounded scan can reach unrelated Agents. Ingress retains its blocking
serialization on that key. An acquired claim transaction locks the delivery
by primary key with `FOR UPDATE SKIP LOCKED`, and re-reads eligibility, metadata, and custody without
the hint cache. It checks the expected Agent identity and Cloud queue head again before persisting
the existing claim marker or recovery lease. Each scan attempts at most eight such transactions.
Pending ingress expiry uses the database clock, as before. The existing dispatch, steer, receipt,
report, cancellation, retry, and timeout state transitions still apply.

## Accepted receipts awaiting Inbox

A recoverable Slack or Feishu receipt may be acknowledged before its Inbox transaction succeeds.
Fresh delivery admission waits while the Agent's current binding/generation has receipt work in
`processing` or `failed` with no matching immutable Inbox event. Active normalization leases and
retry backoff do not remove this barrier. A matching binding and provider event ID releases the
barrier even if receipt settlement has not finished; an equal event ID under another binding does not.

Distinct Slack callback event IDs can normalize to one semantic message, including a `message` and
`app_mention` pair. The duplicate event has no separate Inbox identity, so its receipt releases the
barrier through normal settlement. If that settlement fails, fresh input waits until receipt recovery
settles it; semantic deduplication does not authorize dispatch past unresolved receipt work.

Initial recoverable receipt claims and fresh dispatch freezing use the same transaction-scoped Agent
custody advisory lock as final queue claims. Receipt claims resolve the expected Agent without row
locks, take that fence, then revalidate and lock the current binding/installation generation before
inserting. Feishu also rechecks its connection holder, epoch and lease. The dispatch fence precedes
placement, delivery and Sandbox locks. No provider, model or Cloud I/O occurs under this fence.
Slack receipt claims lock their route before the installation, matching lifecycle writers.

The selector reads only blocked Agent IDs through two receipt-work projections per batch of at most
512 Agent identities. The existing partial work indexes exclude completed history; scan cost still
depends on active receipt work. These fresh hints do not authorize dispatch: final claim and final
direct/steer freeze recheck under the fence. A receipt arriving between claim and freeze defers the
new dispatch with `IM_DELIVERY_INBOUND_PENDING` and the existing capped backoff, without a terminal
state or fabricated report.

The barrier conservatively covers the Agent's other Cloud Sessions as well. Other Agents continue.
Existing frozen dispatch, acceptance, report replay and acknowledgements continue; a receipt accepted
after a frozen dispatch linearizes behind it. This protects known accepted work, not completeness of
unseen provider callbacks or strict cross-entry sender order. A repeatedly failed receipt can delay
that Agent's fresh input until normal recovery or existing disposition/cleanup releases it. Receipt
retention, ingress expiry, queue capacity and duplicate suppression keep their existing policies.

There is no schema or persisted-format change. All Server receipt/dispatch writers must use this
fence for the guarantee; mixed old/new writers or rollback reopen the admission-order gap.

## Runtime budget and accepted recovery

Retained-report reconciliation processes one bounded manifest of at most 65 claims
in one transaction. Empty manifests do no SQL. The transaction locks the live
Session with `NO KEY UPDATE`, then its placement with `UPDATE` and rechecks the
Computer and generation. One batched scope JOIN loads only unreported manifest
deliveries in that Session and locks only those delivery rows, in ascending ID
order. The JOIN retains the message, Session, placement, binding, Agent and
Computer identity checks; it does not take row locks on every joined table.

Reported rows are unchanged by a retained claim, including their report owner
and hash. Exact terminal replays are acknowledged by the normal report path
without ownership reassignment. For accepted unreported rows, matching Turn,
dispatch, input hash and generation remain required, and a different non-null
result hash cannot replace the existing result. Owner/hash fields are updated
only when they change. Matching unchanged rows still run the existing feedback
recovery, so a missing or queued target can recover without rewriting delivery
fields. Pending and expired correlated dispatches retain their atomic batch,
acceptance and feedback restoration. SQL errors roll back the entire manifest;
claims do not redispatch input or manufacture a terminal report.

Message retention is an ingress deadline, not an execution budget. A Local or Cloud Client Turn
uses the explicit `runtime.budget.maxDurationMs`, or the existing 30-minute default when it is
absent, then takes the smaller of that budget and the remaining message deadline. An explicit
budget may exceed the default. An already expired request produces a timeout report without
starting the Provider, with `executionEffects: not_started`. Execution and Slack activity use the
same budget calculation; a running Provider must still honor abort and complete its native cleanup
before the Client can report. A Client upgrade does not change an already running Turn's timer.

The Worker carries its existing operation signal into Local reconcile preparation,
Local/Cloud direct dispatch and steer. Reconcile admission runs after preparation.
Owners check the signal after asynchronous custody/model work and before the first
frame; Cloud allocation checks it after the Sandbox lookup/ensure and before
starting allocation. Already-issued SQL and shared model reads retain their own
bounds. A cancelled unsent attempt retains committed dispatch correlation for
identity-based recovery; cancellation never erases custody or rejects already-sent
receipts and reports.

The Runtime domain close port stops new requests, rejects pending waiters and
joins admitted preparation, completion, send and custody-release work. Closing a
waiter does not establish that its transport or SQL has ended. Already-sent
requests retain deferred dispatch correlation; an unsent reservation can release
through the existing retry path. Callers must await this close port before
disposing its shared database pool.

An accepted recovery claim uses the existing 15-second `next_attempt_at` lease and post-claim
attempt count. Renewal starts immediately after commit, before enqueue, and runs every five seconds
while queued or executing. Each renewal requires the same accepted, unreported attempt with no
recorded retry outcome. A report or newer attempt wins, and a failed renewal cancels the old
reconcile waiter. The worker also retains one local owner per delivery until its actual work settles;
a scheduler timeout or grace expiry does not release that owner or admit duplicate local recovery.
No transaction spans the Runtime wait.

Accepted recovery explicitly opts into joined reconcile settlement. Cancellation removes its
pending waiter and joins its admitted send callback. Result processing already admitted before
cancellation remains owned until it finishes, including after the native request deadline. Other
reconcile callers retain their existing bounded waiter and owner-drain contracts. Cancellation does
not cancel the Client Turn, erase custody, or prevent an authentic report from recording. Shutdown
drops queued recovery without a synthetic saturation failure; its lease expires for another worker.
A failed renewal likewise leaves the existing lease to expire rather than rewriting a newer owner.

A recovery deadline aborts reconcile, then records its one attempt-fenced timeout after actual
settlement and renewal shutdown. Work ignoring cancellation keeps its lease and local owner even
when the scheduler grace expires; it cannot schedule another recovery while still owned. Rejection
with the deadline's abort reason is cooperative cancellation, not late settlement. An actual late
result retains the late-settlement diagnostic, and an operation still running after the grace retains
the abandonment diagnostic. Neither observation authorizes a new input dispatch or terminal report.

For accepted Local custody, a reconcile response does not settle the delivery. `busy`, `running`,
`reporting`, `recovery_required`, and `rejected` are recorded as distinct deferred status codes.
For `ready` and `stopped`, an unreported retained claim that the Server successfully commits for
the current delivery and Turn means `IM_DELIVERY_RECOVERY_REPORTING`, even before the actual
`turn:report` arrives. The domain owner supplies this Server-only claim evidence separately from
the Client's manifest, after the existing placement, identity, dispatch and hash checks. An absent,
rejected or mismatched claim, or a successfully claimed report for another delivery, does not
establish reporting for the current delivery. Without that evidence, an unreported `ready` or
`stopped` response means `IM_DELIVERY_RECOVERY_AWAITING_REPORT`.
`busy`, `running`, and `reporting` keep the operation span's `deferred` outcome and retry metric
without emitting an error diagnostic. Transport failures, `rejected`, `recovery_required`, and
unreported `ready`/`stopped` responses without a matching committed claim remain diagnostic. The stopped reconciliation used here
returns `busy / active_turn` for live activity; `running` and `reporting` are handled defensively,
not observed from this request shape.
These responses and reconcile transport failures use the existing capped exponential schedule:
2, 4, 8, 16, then 30 seconds, based on the post-claim attempt count. A retry update applies only
while the delivery is still accepted, unreported, and at that attempt; a late report or newer
attempt wins. The response never fabricates a report, expires accepted custody, or dispatches
the input again. Only the actual report settles custody.
The operation deadline uses that same attempt-fenced recovery helper. Generic failure writes also
exclude reported rows and require the captured attempt count, so an older timeout cannot change
terminal report metadata or a newer attempt's schedule.

The expiry pass also sweeps accepted custody that no work path can reach any more: an ended Session,
an inactive binding, a deleted Agent, or a superseded placement generation puts the row outside
`#recover`'s query, outside the selector, or behind a custody fence a report can no longer satisfy.
That sweep is bounded by the same batch size, requires the row to be provably past the
report-acceptance window, skips a row that another worker currently claims, and writes the same
`unknown` report, so it settles the rows it selects. Before it writes, it locks the Agent and the
binding and re-reads the authority it selected the row for under those locks: an uncommitted
reactivation then blocks the settlement instead of being invisible to it, and a committed one refuses
it. It covers Local custody only; Cloud custody stays with the Cloud owner's own acceptance cutoff.

A superseded placement needs one difference. In current code `session_placements.generation` moves
only when the Session's Computer changes (`AgentService#moveSessionPlacements` and
`SessionService.movePlacement`), and both paths first reject any accepted, unreported custody
(`#assertSessionsCanRebind` / `SESSION_PLACEMENT_CUSTODY_PENDING`) while holding `FOR UPDATE` on the
placements. A runtime restart or a sleeping laptop never advances the generation. An accepted,
unreported row with a superseded generation can therefore exist only as a legacy row written before
that rebind guard existed. `PostgresRuntimeCustodyStore` requires the delivery's generation, the
report's generation, and the current `session_placements.generation` to agree, and a rollover makes
the delivery's historical generation differ from the current one for good — so `recordTurn` refuses a
report for it (measured: `stale_generation`) and cannot settle it. `settleSupersededPlacement` exists
to clean up those legacy rows with a fenced write of its own: in one transaction it locks the delivery
with `select … for update` and requires accepted and unreported state, no recorded `result_hash`, the
acceptance window closed, a superseded generation, no live claim marker, and Local custody — then
writes the same report body, keeps the delivery's own historical `placement_generation` (it is never
re-anchored), and records `reason = placement_superseded`. It does not consult
`report_owner_instance_id`: a superseded generation cannot report whatever instance is live now.
Lock order is part of the contract here. The rollover settlement takes the recovery-Session locks
before it reloads the row, because `lockSteeredRecoverySessions` and `recordTurn` both require the
Session lock to precede every placement and delivery lock; taking the delivery lock first would form a
`40P01` cycle with a concurrent non-completed report. The maintenance report path instead locks the
Agent and the binding **before** the recovery Sessions, in the order the binding lifecycle mutates
them: `ImBindingService.disable` holds the Agent, then the binding, and then ends that binding's
Sessions, so a maintenance settlement that held a Session first would close a
Session → Agent → binding → Session cycle with a concurrent disable. After the reorder it reloads the
row and every identity it locked, rechecks the authority, and only then writes.
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
that Computer's pending and accepted deliveries, and its expired deliveries that still hold a dispatch
(they still fence the Agent), but only for rows parked more than one minute into the future. A client that reconnects in a loop therefore cannot turn the backoff into a hot retry,
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
  executing: it stays pending and is settled only after its outcome arrives. When the same run then
  finds the correlation still in place, the row is **parked** instead of rejected — see below. A
  dispatch release keeps the run going (it is a lifecycle step, not a failure) so the cap stays
  reachable for an input that alternates "timeout on the frozen dispatch" and "release, prepare a
  fresh dispatch".
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
  with no live runtime, a placement generation that was superseded, or a different live instance whose
  reconcile answered `ready` or `stopped` without claiming the report (it lost it, for example with a reset home). The superseded case is the one
  the delivery worker cannot write at all; the expiry sweep settles it and records
  `reason = placement_superseded` (see the expiry-sweep paragraph above).

These settlements cover the shapes described above. They are not a total bound on every delivery.

### Parking a correlated dispatch

A correlated dispatch whose operation never settles is neither retried forever nor rejected. Once the
same consecutive-timeout run reaches the cap, the worker **parks** the row: it records
`lastErrorCode = IM_DELIVERY_PARKED`, sets `next_attempt_at` to the ingress deadline, and emits one
`IM_DELIVERY_DISPATCH_PARKED` diagnostic with the delivery identity. Parking keeps everything that
records what may have happened — the pending state, `reason`, the dispatch correlation
(`dispatch_request_id`, `dispatch_input_hash`, `dispatch_payload`), the execution origin, and the
unreported custody — and writes no `turn_report`, no `result_hash`, and no `reported_at`. The claim
scans exclude a parked *pending* row in SQL and in the in-memory eligibility, so the runtime is never
offered it again; a row that is due is still not claimable, because the exclusion is a predicate and
not a delay. Once the ingress deadline passes, the TTL sweep expires it as usual, and an expired row
resumes the ordinary expired-dispatch release path (the exclusion is scoped to pending rows). A late
authentic acceptance and report still settle a parked row through the normal path, because nothing was
fabricated and the correlation is intact.

A parked **Cloud** row needs one more condition, because the sweep never expires input a Runner may
still be executing: it expires only once the frozen execution window recorded in
`dispatch_payload.deadlineAt` is present and has also passed (a missing `deadlineAt` fails closed,
matching `cloudDispatchWindowExpired`), so both bounds must close. After that it is an ordinary
expired Cloud row, and the Cloud coordinator's expired-dispatch release clears the correlation without
ever rebuilding the input. A correlated Cloud row that was not parked keeps its existing owner: the
frozen window and the coordinator's release, never the sweep.

What parking and the overdue settlements do not guarantee: the consecutive-timeout counter is still
not crash-durable (a worker that exits between a claim and its failure record loses it, so the worst
case is a slower park rather than an endless loop), and a legacy cross-Computer rollover row that
already carries a retained `result_hash` remains an open limitation (refused by both `recordTurn`'s
Computer/generation fence and `settleSupersededPlacement`'s `result_hash is null` guard).

Each of these paths emits one diagnostic per failure run instead of one per attempt: a repeat of
the failure code already recorded for the delivery adds nothing an operator can act on. Only the
terminal settlement always emits its own line. The pre-claim code is read in the claim, so no
extra query is needed.

If a steer target completes between claiming the follow-up and rechecking the target, the worker
keeps `IM_DELIVERY_STEER_TARGET_ENDED` and the normal retry schedule without an error diagnostic
only when the target is still accepted, its Session, Turn and report owner match, a `completed`
report is recorded, and the follow-up has no frozen dispatch request. The retry warning retains
the delivery ID, code and delay. Missing or mismatched targets, other report outcomes and frozen
dispatches retain their failure diagnostics; the code alone does not identify an expected fallback.

The final dispatch transaction applies the same classification after acquiring the Agent custody
fence and reloading the target under row locks. Only a matching accepted target with a recorded
`completed` report returns `target_ended`. Identity, report owner and placement-generation conflicts,
missing targets and other report outcomes remain conflicts. An existing frozen dispatch is checked
first and retains its original correlation and recovery path.

Batch preparation reads a bounded set of pending inputs before the dispatch transaction. Under the
custody fence, reservation checks every selected member's identity and eligibility before writing
any reservation. A member that became claimed, unavailable, expired or not yet due returns
`batch_changed`; missing members and message, Session, generation or attention mismatches remain
conflicts. A new message outside the selected batch does not invalidate that batch. Reservation and
the head's frozen dispatch commit or roll back together.

These two explicit pre-send outcomes use `IM_DELIVERY_STEER_TARGET_ENDED` and
`IM_DELIVERY_BATCH_CHANGED`, respectively. They retain pending input and the normal bounded retry
schedule, emit a retry warning and counter, and mark the operation deferred without an error
diagnostic. No delivery or steer frame or dispatch notification is sent, and no release is needed
because nothing was frozen. The next attempt rebuilds input from Inbox; stable delivery and message
identities and normal custody acknowledgements still apply. Database exceptions, authorization or
generation conflicts, send failures and unknown execution outcomes retain their existing failure
and reconciliation paths; a generic conflict never authorizes a fresh send.

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
