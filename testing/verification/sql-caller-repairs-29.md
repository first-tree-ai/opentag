# SQL caller repairs: IM worker and ready-wakeup drain

This is the IM worker portion of IM-F3. Stop closes admission, cancels its
existing delivery signals, drops queued scheduler work and joins actual work.
One work set retains whole claim/run passes, maintenance, parked-retry wakeups,
failure/drop writes and the underlying delivery Promise that can outlive the
existing deadline grace. The original deadline and accepted-custody semantics
remain unchanged. Local recovery also passes the operation signal to Runtime
Domain. A late runtime assembly checks cancellation before starting another
reconcile or delivery. Claim renewal already joins its own Promise and is reused.

Ready wakeup stop joins its existing coalesced operations and the actual detached
recheck reads. No durable queue, scan, concurrency or retry policy changes. No
second scheduler or independent timeout is introduced. Main still must compose
these stop ports with the remaining owners before database disposal.

**132 distinct cases pass (19 native PostgreSQL), 302 passing executions.**
Owning Local/Cloud workflow and native recovery/lock suites pass in Docker.
Six new PG17 controls hold actual work during post-claim completion, a runtime
assembly beyond the one-second timeout grace, manual janitor, scheduled expiry,
scheduled retention and detached ready recheck. Stop remains pending until the
original task is released. Abandoned assembly never emits a later request;
pending custody remains pending with no invented Turn. Pools remain healthy,
and the two delivery controls verify no backend survives disposal.

The initial Docker run exposed three old exact-call assertions that expected no
optional signal arguments on recovery. They now assert the same stopped request,
no new runtime snapshot, and the supplied AbortSignal; all 60 owning Local cases
pass after this test-only correction. Unchanged Cloud/native cases are not
repeated. Source typecheck and repository gates pass without baseline changes.
Logs/snapshots are in `.codex/reports/sql-caller-repairs-20261103/batch-29-*`.

Batch 28's two P2s are corrected at 6c87b97c and reviewer-confirmed closed. This
batch needs exact review. Feishu setup, high-level Slack/Context Tree, approval,
OAuth/Cloud/capture tails and actual main shutdown remain open IM-F3. These tests
do not establish full Server signal, CI, merge, deployment or live acceptance.
