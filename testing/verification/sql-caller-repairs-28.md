# SQL caller repairs: credential and provider transport drain

This is another IM-F3 component. Credential owner close rejects new admission,
combines its existing caller signal with owner cancellation, revokes live
executions immediately and joins actual handle, validation issuance and liveness
operations. Execution-close cleanup remains subscribed through that drain and a
final revoke; URL-handle cleanup likewise stays subscribed until the stack's
owner and transport both finish. Platform runtime now awaits the stack close.
No persisted authority or timeout budget changes.

Existing open/broker steps recheck cancellation between asynchronous authority
stages and before issuing grants. An aborted open releases its record. GitHub
provenance carries the supplied signal through recursive reads and checks it
before management lookup. These checks stop another SQL/authorization stage;
they do not substitute an early-return race for actual operation settlement.

Provider transport retains connections after physical disconnect until their
actual stream/broker/adapter and periodic revalidation operations settle. Close
aborts streams, ends queues and credit waits, closes sockets and joins that work.
Late adapter results close their returned body. Route preClose initiates the
same close without waiting ahead of WebSocket teardown; onClose joins it. No
extra stream limit, queue, retry or generic lifecycle framework is added.

**200 distinct cases pass (41 native PostgreSQL), 417 passing executions.** The
10-file Docker matrix covers stores, owner/broker/transport, GitHub policy, IM,
MCP gateway and platform wiring. Four new native PG17 cases hold the actual
resolver query result during execution open, liveness, acquisition and validation
issuance: close remains pending, new admission fails, no late execution/grant/
ticket/validation run survives, and the pool remains reusable. Three new loopback
transport controls hold broker admission, adapter response and revalidation past
peer disconnect; cancellation fires promptly but close waits for the original
work. Two provenance controls cancel after SQL and prevent either recursive SQL
or management lookup. The affected owner/policy/native matrix is rerun after the
small final simplification; other unchanged passing consumers are not repeated.

An initial test supplied a nonexistent adapter field and was corrected before
execution. A complexity gate rejected one added branch; cancellation is checked
inside the existing provider-description continuation and cleanup catch instead.
Typecheck and repository gates pass with no baseline waiver. Logs and source
snapshots live in `.codex/reports/sql-caller-repairs-20261103/batch-28-*`.

Batch 27 exact review found no actionable defect, including a check of pinned
WebSocket late-upgrade rejection. This batch needs its own exact review. Other
owners, detached callback/proof tails and actual main ordering remain IM-F3.
Component tests do not establish whole-Server signal, CI or deployment status.

## Independent review correction

Review found two P2 windows: a confirmed IM response could create URL handles
after execution-close cleanup while waiting for capture; broker task policy did
not receive the signal, so actual GitHub authorize could continue provenance SQL.
The adapter now checks the request signal after confirmed capture and before
rewriting; capture itself still settles once. Task-policy input carries an
optional signal, and broker forwards its existing signal. No new authorization
source, retry or deadline.

The correction passes 143 distinct cases (five native PG), 270 executions on
host/Docker. Two real-adapter loopback controls close the execution while capture
is held, then prove confirmed capture finishes and neither upload nor download
handles survive. Three real broker-to-GitHubRuntimePolicy controls cover acquire,
renew and beginRequest: after the first provenance read, cancellation prevents
the recursive read and management lookup. Owning adapter/capture/transport/broker,
GitHub policy and native platform consumers pass. Batch 28 cumulative coverage is
263 distinct cases, 41 native PG, 687 passing executions. Exact correction review
is pending; main composition remains open. The default outbound capture's own
bounded raw-query tail is separately retained for the remaining IM-F3 work.
