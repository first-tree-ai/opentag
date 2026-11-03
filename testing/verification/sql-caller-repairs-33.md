# SQL caller repairs: Cloud proof commit and Runner cleanup

This IM-F3 component rechecks the exact Cloud connection after proof upsert and
after transaction COMMIT. If the connection is lost during COMMIT, mint awaits
existing exact-connection revocation before failing. The registry-backed proof
authority refuses to register an execution already closed during SQL. The
previous redundant pre-upsert check moves after the write; no schema, new proof
kind, lock order, retry or timeout is introduced. Current-connection executions
continue sharing their live proof; execution close alone does not trigger broad
connection cleanup, and a replacement connection's proof cannot be deleted.

Runner detach clears the retained connection before synchronous teardown and
retains the collaboration owner's actual durable-cleanup Promise. Connection
close joins frame processing, credential renewal and this cleanup. The route's
existing retention after peer close therefore also covers proof cleanup. Existing
cleanup failures retain their controlled warning; no unobserved rejection or
additional disconnect write is introduced. Proof mint is already awaited by the
Cloud credential-open frame chain, including its post-COMMIT cleanup.

**176 distinct Docker cases pass, including 10 native PostgreSQL cases.** Four
new native controls hold real proof SQL or COMMIT/result delivery, close the
execution or disconnect, and confirm rollback or late cleanup; a fresh replacement
proof remains authenticatable. Existing queued-sibling proof controls also pass.
A new loopback Runner control disconnects its peer, holds cleanup, initiates app
close and verifies close waits and detach runs once. Host 107 owning cases and
server typecheck pass. Type-only test annotations were corrected after the first
typecheck; runtime tests were not repeated for erased annotations. Repository
gates pass; manifests and failed/successful logs remain in the local report dir.

Independent source review found no actionable regression; exact-commit review
remains pending. Batch 32 exact review at 9a6db831 found no actionable defect.
Original Cloud allocation convergence and actual main shutdown composition remain
open IM-F3. These component tests do not establish full Server signal, CI, merge,
deployment or private billing acceptance.
