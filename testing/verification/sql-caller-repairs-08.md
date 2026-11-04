# SQL caller repairs: IM send cancellation

2026-11-03, IM-F2 on the refreshed source in the
[tracker](../sql-caller-remediation.md). No schema, migration, new deadline,
retry, shared catalog cancellation or custody replay policy is added.

The Worker forwards its existing signal through Local/Cloud direct and steer
owners. Local ready reconcile uses the existing Domain admission callback after
preparation, removing the preceding wrapper; a final authority denial retains
its existing diagnostic. Owners check after asynchronous custody/model work and
before the first frame. Cloud checks after Sandbox lookup/ensure before starting
allocation. Committed dispatch correlation stays intact after abort. Already-sent
receipts/reports still settle normally; the operation signal has no post-send
abort listener that would destroy custody.

**217 distinct passing cases: 172 host unit and 45 native PostgreSQL in Docker.**
Nine native cases cover normal Local handoff, cancelled and suspended preparation,
actual Local direct/steer and Cloud steer placement-lock delays, Cloud model
preparation, Sandbox lookup before allocation, and already-accepted late custody.
The 36 existing native cases exercise recovery, parking and Cloud dispatch.
Tests explicitly track actual owner continuations after the outer operation has
abandoned them; releasing only a wrapper is not called drain. The allocation
case releases the real table lock within existing grace and joins runOnce.

The first native run passed 43 and failed two old-probe assertions: diagnostics
now contain context, and an accepted row deliberately produces no SQL timeout
error diagnostic. The selective retry passes those two identities. The selective retry repeats no successful native identity. Two subsequent
Worker-only runs (60 cases each) verify equivalent rejection-flow and failure-code
simplifications needed by the unchanged complexity ratchet: 337 passing executions
overall. Complexity decreases from the original 39 to 38. Initial copied fixture unused imports, types and lint
failures are retained. Server typecheck and repository gates pass. Socket/model
ports are controlled; PostgreSQL custody, row locks, reports and snapshots are
real. No whole-binary stop, live Runner/provider, independent agent review, CI,
merge, deployment or private billing acceptance is claimed.

Workspace evidence: `.codex/reports/sql-caller-repairs-20261103/batch-08-*`.
IM-F2 is repaired locally. Higher-level owner stop/drain remains IM-F3; Provider
preparation remains AG-F2. Those findings are not closed by preventing late sends.
