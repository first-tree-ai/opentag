---
title: IM delivery claim queries
description: Indexed delivery selection, in-memory eligibility hints, and transactional custody checks.
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
is pending. Runtime execution in different lanes remains concurrent.

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

An accepted target without a recorded terminal report retains its steered children and their
target identity. Error codes, expired retry backoff, an offline Computer, and an ended Session
do not prove that execution ended and cannot requeue those children. Existing error diagnostics
remain available for investigation. Reconnecting the same report owner can settle the original
Turn through the existing report identity and ownership checks.

A recorded `completed` report keeps the children steered. Recording a valid `failed`, `cancelled`,
or `unknown` report requeues them once in the same transaction; replaying the report cannot requeue
them again. The janitor can recover children of an already recorded non-completed report or an
explicitly disposed target. A missing report can therefore retain custody indefinitely, including
after Session closure. Abandonment and ownership fencing require a separate policy; maintenance
does not synthesize a terminal report.

`busy / active_turn` can include report custody. An empty retained-report manifest does not prove
that the Client has no report on disk: live activity can prevent recovery from enumerating it.
Offline Computer retry and final-abandonment policy are separate from this response backoff.

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
