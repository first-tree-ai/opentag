# SQL caller repairs: nested shutdown failure diagnostics

The new shutdown composition can wrap a resource failure through several
AggregateErrors. Signal logging inspected only the outer error and one cause,
hiding the actual resource name and leaf failure. It now reuses the existing
startup failure formatter, which walks errors/causes, deduplicates objects and
applies the existing secret redaction. The failures array and detail field remain;
the redundant one-level cause branch is removed. Resource order, Promise
ownership, SQL behavior and exit code are unchanged.

The first new control fails on the old code because the scheduler leaf is absent.
The corrected control combines scheduler, worker and database-close failures,
retains all three leaf messages, redacts three known secrets, attempts telemetry
and exits with code one. The worker test double now returns its actual stop
Promise instead of discarding it, matching the production port.

**22 Docker component cases and 22 host cases pass; server typecheck and repository
gates pass.** These are lifecycle/diagnostic controls, not new native PostgreSQL
claims. The existing four actual Server process controls remain the evidence for
unchanged physical shutdown behavior. Logs retain both the red reproduction and
successful checks. Independent source review found no actionable regression;
exact committed review is pending. Batch 38 exact review at 73d7e0a6 found none.

IM-R2 native scale/selection-equivalence measurement and final broad owning
checks remain before declaring the full remediation complete.
