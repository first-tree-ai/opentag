# SQL caller repairs: physical Cloud ownership and reservation

Batch 7a closes SB-F1/SB-F2 using existing placement facts; no schema/owner column.
Physical count, read/status/stop, report authority and runner candidate/holder
queries follow retained Session placement → Cloud Computer owner. This preserves
original-Account occupancy until verified absence and prevents cross-Account
borrow after Agent transfer. Current Agent ownership remains required for its
overview; execution separately requires the current active authority chain.

New reservation keeps capacity advisory first, then Account NO KEY UPDATE,
Agent UPDATE with captured preflight revision, binding UPDATE, Session NO KEY
UPDATE, placement UPDATE, Computer UPDATE and Sandbox UPDATE. Final reads use
that executor. Read/stop only lock Sandbox. Idle barriers and borrow ownership
checks remain ordinary reads; no authority lock is taken after Sandbox. The
ineffective autocommit initial ingress lock is removed. External create/storage
I/O remains outside SQL, retaining generation/name/UID/operation CAS and unknown
outcome handling. Already committed reservation may submit after withdrawal;
withdrawal fences subsequent admission/execution, not an issued physical effect.

**301 distinct passing cases: 213 unit and 88 native PostgreSQL in Docker.** Fourteen
new native cases cover actual suspend/delete/transfer with retained charge,
original-owner status/cleanup and no new-owner visibility; quota remains charged
and recovers after verified removal. Seven committed-first withdrawal cases cover
Agent suspension/transfer/revision, binding, Session, placement and Account. Four
independent writers (Agent, Account, binding, Session) block after the admission
locks while reservation waits on Sandbox, then commit after it. Fresh revision
retry works, no rejected reservation submits create, and no idle transaction
remains. Existing capacity/idle borrow/reuse, unknown create/delete, Cloud overview,
Runtime proof/credential and Cloud Session result/concurrency suites pass.

Initial binding fixtures violated the schema's disabled-secret shape, causing two
failures and the corresponding observed unhandled rejection. Clearing the required
secret/lease fields with disabledAt models a valid withdrawal; both cases pass
selectively without an unhandled error. Other cases were not repeated. Test helper
complexity was simplified before running; no baseline was relaxed. Server
typecheck and repository gates pass. Fake Cloud admin plus real SQL establishes
bookkeeping/concurrency, not acceptance of live Google Cloud resources.

Independent design review confirmed placement facts and no known reverse lock
cycle; final implementation review is separate. Evidence:
`.codex/reports/sql-caller-repairs-20261103/batch-17-*`. AG-F10 workspace hints and
IM-F3 final drain remain open. No CI, merge, deployment or private billing acceptance.
