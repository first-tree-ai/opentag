# SQL caller repairs: Runtime and Runner route drain

This is an IM-F3 component, not final Server shutdown acceptance. Runtime and
Runner routes retain connection instances until their actual close Promise
settles, including peers that already disconnected. Runtime preClose starts all
owner stops and socket closes together; onClose joins the same operation. A
small helper reuses the existing labelled cleanup/error aggregation after
initiating every stop, so a waiting owner cannot prevent its transport from
being closed. Database disposal remains outside that concurrent initiation.
Runner close joins its admitted frame chain and credential renewal. The renewal
Promise replaces overlapping interval work; no queue, retry or new budget.

**93 distinct cases pass, including two native PostgreSQL cases; 272 passing
executions across the retained runs.** The 91 owning unit/PGlite cases pass on
host and in Docker. New Runner loopback cases hold the real embedded-engine
scope lookup during authentication/renewal, disconnect the peer and prove route
close waits. Multiple renewal ticks share one lookup and emit no late frame.
The shutdown helper control combines a dependency on another close with both
synchronous and asynchronous stop failures.

Two Docker PG17 controls use actual createApp asynchronous execution-plugin
boot, real MachineAuthService/ComputerService and a real WebSocket. Registration
is held after its committed SQL, then the client disconnects before app.close.
The pool remains open while close waits; late registration performs its exact
unregister/disconnect, leaves no current instance or backend, and emits no frame.
A failing unrelated approval stop still permits connection drain and final pool
cleanup, and remains an AggregateError. The first fixture omitted the Account
auth surface required to mount execution routes and received HTTP 404; adding
that unused fixture port fixed both cases. Failed logs are preserved.

Typecheck and repository gates pass. The independent review of batch 26 found
no actionable defect. This batch still requires its own exact-commit review.
Credential/transport, other owners and actual main ordering remain IM-F3; these
results do not establish whole-Server signal handling, CI or deployment status.
