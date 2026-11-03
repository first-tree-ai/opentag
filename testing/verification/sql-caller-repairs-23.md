# SQL caller repairs: Provider preparation drain

This closes only the Provider portion of IM-F3. Preparation retains the actual
eligibility/send/fallback Promise separately from the caller's deadline race.
Close still rejects admitted waits immediately and now returns a join of the
underlying work. Reconcile retains its existing freshness/preparation/request
maps and tracks registration, placement/binding callbacks, grant issuance,
result handling and detached cancel sends. Close stops admission, starts all
cleanup, then joins those actual operations; it does not wait before initiating
cancellation. A post-eligibility closed guard prevents the next requirements SQL.
No new SQL timer, retry, pool or lifecycle framework.

**71 distinct cases pass (4 native PostgreSQL), 206 passing executions.** Docker
Linux runs all 67 owning unit cases and four native PG17 cases. Two native lock
cases retain the original operation timeout/recovery evidence. Two new native
cases pause registration/preparation after the real Computer eligibility query:
close remains pending, admitted preparation is rejected, and releasing the
continuation produces neither later requirement SQL nor send. The shared pool
still answers normally after owner close. Socket controls prove that resolving
the caller's wait does not finish drain before the original send and detached
cancel callbacks settle.

One updated unit control initially settled the original send but omitted its
separate cancel callback, so the stronger close correctly remained pending.
Settling both callbacks passes selectively; the entire Docker owning suite then
passes. A temporary source-edit parse error was caught by Biome before execution
and corrected. Failed logs remain; no baseline was relaxed. Typecheck and
repository gates pass. Evidence:
`.codex/reports/sql-caller-repairs-20261103/batch-23-*`.

The Runtime route/main composition does not yet await these new close Promises.
That wiring, Session/Runner/transport tasks, other background borrowers and final
shared-pool ordering remain IM-F3. These component checks do not establish full
Server shutdown, CI, merge, deployment or online acceptance.
