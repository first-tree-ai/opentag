# SQL caller repairs: lifecycle stop authority

Continues the [remediation checklist](../sql-caller-remediation.md) after
`f676eee8b6e802a14a494a7a2a4def33ce8abf8b`, based on main `8cb997b2`.
Implements the recorded minimum AG-F12 and lifecycle AG-F2 proposals confirmed
by the instruction to repair all findings. No schema, lifecycle column, HTTP
field, timer, retry framework or retention change.

| Scope | Implementation and evidence |
| --- | --- |
| AG-F12 | Stop targets capture the revision produced by the locked lifecycle mutation. One narrow admission helper checks the inactive Agent at that exact revision, then locks its Session and captured placement. Both Local and Cloud enqueue use it; stale decisions skip. New native cases preserve new accepted Cloud work/proof after reactivation and send no old Local stop after reactivate/second suspend/delete. |
| Local enqueue/results | Use the existing Runtime dispatch-admission port after actual proof preparation. Its operation enqueues synchronously; return the result promise from SQL without awaiting it or the socket callback. Real one-connection tests permit reactivation/new proof before a late stopped result and complete proof cleanup despite pending socket callbacks. No stopped evidence is fabricated for skipped admission. |
| Cloud identities | Guarded cancellation uses the transaction executor for existing delivery/message/placement reads. Close only captured execution IDs; retain selected delivery/message/Turn and allocation fences. Compare-delete proof ID plus updatedAt, and drop correlation only after a successful delete. A native mint/revoke interleaving reuses the same proof ID with a newer update version and preserves its live correlation. Current cancellation and proof cleanup work with a max-one pool. |
| AG-F2 lifecycle extensions | Retired Provider CLI notifications are best effort after local authority is removed. Active retry/replacement cancellation still waits on its existing gate. Remove redundant Local dispatch promises and await actual reconcile results. A native confirmed-result test completes while both provider-cancel and socket callbacks remain pending. |

The Cloud/Local composition moved from the executable entry file into the
existing stop module so tests import the actual production composition. The old
single-read preflight transaction disappears. Existing lifecycle revision, proof
update version, placement and domain timeout are reused. An Agent revision
change supersedes the captured decision; this is a strict revision guard, not a
new independently persisted lifecycle epoch.

## Validation

**270 distinct passing cases: 79 native PostgreSQL in Docker and 191 host
unit/API.** Nine native cases are new. Passing executions total 326 after
deduplicating retries and the repeated Cloud control.

| Run | Passed | Failed | Disposition |
| --- | ---: | ---: | --- |
| Initial owning unit suites | 184 | 7 | Five stopper cases hit an erroneous test hook return, which Vitest treated as cleanup. Two Provider ordering cases correctly caught an overbroad first implementation that made active replacement cancels nonblocking. |
| Targeted unit retry | 61 | 0 | Correct the hook and restrict nonblocking cancellation to retired requests. All seven failed identities pass; active request ordering remains covered. |
| Selected execution-close case | 1 | 0 | A successor execution opened after capture survives the prepared close. |
| Initial new native faults | 6 | 0 | Actual lifecycle/proof/Runtime owners, max-one Local SQL pool, controlled sockets. |
| Native Agent/Cloud/rebind suites | 61 | 0 | Includes the repeated Cloud stale-callback case, two additional Cloud source/CAS cases and an actual lifecycle Cloud IM cancellation over loopback WebSockets. |
| Native transfer/Computer repair | 13 | 0 | Existing transfer, ownership, lifecycle and rebind behavior. |

Initial fixture type/import/format failures and the failed unit run remain in
the evidence logs. Native faults reproduce the historical audit's component
scenarios; this batch does not claim a fresh pre-repair RED run for every case.
Diff inspection checks query executor propagation, Agent/Session/
placement order, exact proof CAS, synchronous enqueue and ordinary cancel
ordering. Server typecheck, server build and repository gates pass.

Docker image, PostgreSQL version and workspace-only evidence directory match
[batch 2a](sql-caller-repairs-02.md). Cloud credential/proof/SQL owners are real;
Runner replies and normal message admission are controlled fixture ports. One
Cloud IM case also uses real loopback WebSockets. No native provider process,
live service, full HTTP/binary shutdown, CI, independent PR review, deployment or
private implementation acceptance is inferred.

AG-F12 is repaired locally. AG-F2 remains open for Runtime test send and Provider
preparation budget/close paths. IM-F3 high-level drain ownership and the separate
Cloud recovery/resource findings are not closed by this lifecycle batch.
