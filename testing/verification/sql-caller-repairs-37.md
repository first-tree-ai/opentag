# SQL caller repairs: actual Server process and pending-listen shutdown

Signal shutdown now synchronously sets a shared native AbortSignal as an
admission marker and starts the same memoized producer stop. It joins the actual
listen Promise before closing the app, preserving SQL until pending bind/boot
work settles. The main path checks that marker after listen and cannot announce
listen readiness or start prewarm after shutdown. The app reads the marker to
refuse a new HTTP phase during this window. No new timeout, queue or state model.

The signal is not passed to pinned Fastify listen.signal: independent loopback
experiments reproduced an unobserved internal close rejection on cleanup error,
even when the caller observed its own close Promise. Joining the original listen
operation avoids that defect. DNS still uses the operating system's termination
behavior; the implementation does not claim to cancel DNS through a Promise race.

**26 individually identified Docker cases pass (29 passing executions), including
four native PG17 actual-process cases. Host 22 cases, server typecheck and Server
build pass.** The binary cases spawn built dist/index.mjs with the actual startup,
workers, app/async plugins, SQL pool, readiness and process-signal handler. They
use real Machine credentials and Runtime WebSocket registration held on a row
lock, then send SIGTERM and either release the lock or wait for the configured
one-second official statement timeout. Both exit zero, clear the exact Computer
binding and leave every observed application backend gone; an unrelated pool
stays usable while drain waits. Actual bind failure exits one without a backend.

A fourth case pauses real listen DNS in a child-only preload, sends SIGTERM and
proves the application pool remains until bind settles. Releasing DNS leads to
normal exit without reopening or a surviving backend. The preload is only a
test transport control; no production DNS override is introduced. The process
fixture uses an isolated loopback download endpoint and no live provider binding.
Two main controls hold listen completion (including producer cleanup failure),
assert stops begin immediately and SQL remains until release, then verify no
late listen-ready/prewarm event. A third HTTP gate control refuses a new request
before app.close starts. Test-only signal callback typing was corrected after
the first typecheck; failure logs remain retained.

Batch 36 exact review at e2f48e99 found no actionable defect. Independent batch 37
source review found none; exact review at 5d4040c4 also found none; final broad checks remain.
IM-F3's public SQL ownership/composition defect is repaired locally. AA-R1 remains
separately actionable: the pinned official Google token exchange has no native
application budget and can prolong the now-correct HTTP drain. It must be bounded
before declaring the entire remediation complete. Other cost/legacy observations
retain their individual evidence and disposition, including unmeasured IM-R2.
No CI, merge, deployment, arbitrary DNS bound or private billing implementation
acceptance is claimed.
