# SQL caller repairs: Feishu setup actual-work drain

This IM-F3 component stops new setup commands, retains complete create/check/
cancel operations and detached heartbeat/sweep/registration work, and joins the
original probe, activation and claim-read Promises behind cancellation wrappers.
Stop keeps the original QR failure-write before registration abort, independently
collects cleanup failures, loops until actual work drains, settles any late owned
QR slot, then releases exact UUID-fenced check claims. Durable candidate states,
ciphertext, deadlines and authorization paths are unchanged. Restart cannot begin
while stop is pending; a completed stop does not prevent a later start/stop cycle.

Registration ownership is recorded immediately after SDK start, before QR or
slot SQL awaits. A narrow optional gateway settlement port retains the actual
SDK Promise even when ExternalCallPolicy has already returned cancellation. The
SDK action checks the composed native AbortSignal before starting. Existing
manager task tracking also retains the original runtime-readiness callback SQL
behind its own policy wrapper. No new queue, retry, timeout or lifecycle framework.
The SDK's exposed Promise does not prove its private in-flight HTTP socket has
physically exited; no such guarantee or live-provider acceptance is claimed.

Independent design/source review found a late-slot cleanup P2 before commit:
the first QR pass can miss an uncommitted insertion, while a failed cleanup in
create would be discarded as an ordinary task error. Stop now repeats the same
owner/awaiting-user settlement after drain and aggregates that failure. The
special create cleanup write and redundant result observers/abort calls were
removed; the original admission fences remain.

**355 distinct cases pass (129 native PostgreSQL) across the 12-file Docker
consumer matrix and affected-file retry; 536 passing executions in those runs.**
Two new SDK controls verify pre-action cancellation and actual settlement after
the public result returned cancellation. Five native PG17 setup controls cover
QR wait, slot SQL, registered SDK work, a transaction that commits its slot after
the first shutdown pass, and a single failing late cleanup. The last must either
settle the owned row or explicitly reject stop; retry restores the latter. Start
during stop is fenced, subsequent restart/stop succeeds and pools remain usable.
A sixth new native control joins the original readiness SQL while setup and
manager stop together, preserving the encrypted candidate and preventing activation.

Broader consumers exposed ordinary SDK doubles whose abort never settled their
result, and deliberate probe gates released only after awaiting stop. A small
shared test helper models public gateway cancellation; explicit actual-SDK gates
continue to use DefaultFeishuRegistrationGateway. Probe tests now initiate stop,
release the original gate and join, preserving their late-result assertions.
One obsolete test proxy omitted Runtime dispatch admission, and one tracing test
sent a new report after owner close. The proxy now binds the complete method;
tracing records the admitted report before close and awaits owner drain. Native
fixture cleanup likewise awaits the already-async Runtime Domain close port.
Production forwarding was checked and already preserved admission.

The first broad disposable runner was stopped after representative stale-mock
failures; its partial log is retained. The corrected full matrix had 15 fixture/
contract failures; all five affected files then pass their 196-case Docker retry.
The other seven unchanged passing files were not repeated. Owning host checks
also pass. Typecheck and repository gates pass without a baseline waiver. Failed
and successful logs remain in `.codex/reports/sql-caller-repairs-20261103/batch-31-*`.

Batch 30 exact review found no actionable defect. This batch still needs exact
committed review. Detached OAuth/proof/outbound-capture tails and main composition
remain open IM-F3. These results establish no full Server signal, CI, merge or
deployment acceptance.
