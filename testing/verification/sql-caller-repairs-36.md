# SQL caller repairs: main shutdown composition and shared resource disposal

Main now supplies its producer/owner stop list to the app's first preClose
kickoff. All stop ports start synchronously and are independently observed;
websocket teardown can then unblock their actual work. The list adds Inbox,
Cloud Session work and Cloud model/tester work to the existing workers, provider
owners, platform credentials and image prewarm. The app finalizer joins those
ports, child routes and actual HTTP work, then closes billing before shared SQL.
Late main onClose now only removes process handlers.

Readiness, database-pool and telemetry cleanup share one memoized Promise between
normal app finalization and startup catch. Every resource is attempted even if
an earlier cleanup fails; a listen failure does not repeat billing, pool end or
telemetry shutdown. Without an app, model and billing cleanup still precede the
same shared cleanup. Error reporting retains controlled causes and redaction.

ContextTreeOperationService and SlackAutoSetupService have only awaited HTTP
production callers. Their now-redundant private work Sets, admission flags,
wrappers and close ports are deleted. Existing Runtime/GitHub owners remain.
Their native controls use the actual app request owner with disconnected peers
and still verify confirmed installation/selection facts through final SQL.

**74 distinct Docker cases pass, 23 native PostgreSQL, across the nine-file matrix
and one affected-file retry. Host 51 cases, server typecheck, Server build and
repository gates pass.** The matrix covers main DI startup/listen failure,
individual cleanup failure, redaction, exactly-once shared cleanup, real async
route boot, Runtime peer loss and HTTP authentication/handler drain. One old
control still called the removed service admission port after SQL disposal; that
obsolete direct call was removed. Lost-peer waiting and final stored selection
remain asserted; generic next-phase refusal is covered by the PG app tests.
Failed logs and snapshots remain in the local report directory.

Batch 35 exact review at 429b1607 found no actionable regression. Independent
batch 36 source review found no actionable defect in the composition; exact
commit review at e2f48e99 also found no actionable defect. A final late-start boundary remains: SIGTERM during
pending listen must not announce readiness, start prewarm or reopen a listener.
The pinned Fastify listen.signal path has a separately reproduced unobserved
close rejection on cleanup failure, so it cannot be adopted blindly. Actual
Server process signal/SQL-fault validation follows; IM-F3 remains open until it
passes. No CI, merge, deployment or private billing implementation coverage is
inferred from these component and DI checks.
