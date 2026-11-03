# SQL caller repairs: actual Cloud allocation and collaboration drain

CloudSessionCollaborationOwner now closes new delivery/recovery/cancel admission,
composes the existing delivery/recovery signal with its shutdown signal, fails
pending receipt waits, and joins the existing per-target serialized tails plus
one set of actual tasks. Allocation convergence enters that set before the
existing timeout race; original provider/SQL work stays owned after the public
preparation budget returns. Already-issued allocation may finish; shutdown waits
for it and no later dispatch begins. No new timeout or retry is introduced.

Whole public recovery and cancellation operations use the same task owner.
Nested recovery calls use the private implementation so admitted cancellation
can finish its factual cleanup without being rejected by a second admission
check. New recovery/cancel calls return their existing empty outcomes. Closed
connection sends cannot issue late verification. Runner callbacks remain owned
by their frame chain; single read-only busy checks keep their existing callers.

**195 distinct Docker cases pass, including 14 native PostgreSQL cases.** The
five-file 194-case matrix and one new pending-receipt control cover allocation
completion before/after public timeout, late resolve/reject SQL, admitted recovery
and cancellation reads, new-admission refusal and prompt receipt release without
verification. Four new PG controls keep the pool usable while close waits, then
prove the SQL tail has completed without execution custody. Host 53 owning cases,
server typecheck and repository gates pass. Docker snapshots and logs remain in
the local report directory. PGlite is not counted as native PostgreSQL.

Independent source review found no actionable regression; exact-commit review is
pending. Batch 33 exact review at 41b921c7 found no actionable defect. Main must
still start every producer/owner stop without awaiting websocket-dependent work,
join actual child route shutdown, then dispose billing/readiness/SQL/telemetry.
IM-F3 remains open until that composition and actual shutdown fault tests pass.
No full Server signal, CI, merge, deployment or private billing claim is made.
