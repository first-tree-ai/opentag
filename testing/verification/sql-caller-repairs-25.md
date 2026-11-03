# SQL caller repairs: Runtime Domain drain

This closes the Runtime Domain portion of IM-F3. Close stops admission and rejects
pending waiters immediately, retains actual preparation/completion/send/custody
release Promises and joins them before clearing the remaining caches. Existing
trace/dedup maps remain; no parallel request state machine is introduced. Public
requests and later dispatch-admission stages use the existing stopped error.
Detached timeout/send-error releases now belong to the same actual-work owner.
No new timer, pool, retry, migration or custody identity is added.

**70 distinct cases pass (2 native PostgreSQL), 315 passing executions.** All
68 owning unit/PGlite cases and both new native PG17 cases pass in Docker Linux.
Three new unit controls cover preparation before later reconcile admission,
original send callback after waiter rejection, and an admitted completion hook.
Stop remains pending until the underlying work ends, and no new frame is sent
from a preparation which resumes after stop.

The native cases reuse the actual migrated IM recovery fixture and
PostgresRuntimeCustodyStore. One stops an already-dispatched pending request and
holds its real release before SQL; the other holds an actual begin-dispatch SQL
result before a request enters the pending map. Close joins both. Sent correlation
stays deferred; the known-unsent reservation takes the existing retry release and
never sends. Durable rows remain pending, expected correlation predicates hold,
and pg_stat_activity confirms the disposed single-connection client has no
backend left. The transport is controlled; these are actual SQL/owner checks,
not an actual WebSocket or full Server signal test.

The new stopped guard initially increased existing reconcile cognitive complexity.
Its cache-quota trimming now lives in a small memory-only helper; the 56-case
owner suite passes again on host and Docker. Typecheck and repository gates pass
without baseline changes. Evidence:
`.codex/reports/sql-caller-repairs-20261103/batch-25-*`.
Actual Runtime route/main wiring still does not await this port. RuntimeSession,
Runner, provider transport, remaining background/high-level owners and the final
pool ordering remain IM-F3. Independent review follows the exact commit; no full
Server, CI, merge, deployment or online acceptance is inferred.
