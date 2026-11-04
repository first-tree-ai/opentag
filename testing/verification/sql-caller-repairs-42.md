# SQL caller repairs: bounded Local lifecycle stop

Closes the actionable LC-R1 fan-out under the user-confirmed
[Local-stop policy](../sql-caller-remediation.md#lc-r1-supplemental-design--confirmed),
following the [read/write standards](../../docs/system/database-read-write-standards.md).
No schema, migration, retention, authorization order, Session-count limit or new
recovery queue is introduced.

## Final implementation

Local stop uses at most 16 workers, each awaiting the original complete
requestReconcile Promise, and one native 30-second dispatch signal. Proof
preparation, final locked admission and result waiting remain within a worker.
Capacity stops further target admission; already-started operations continue.
Other per-target failures retain aggregate diagnostics. Superseded targets and
offline Computers keep their previous skip behavior.

Late preparation checks the signal before final authority SQL. The existing
Domain enqueue check fences a transaction that had already entered before the
cutoff. Main passes the complete bound method so the sixth signal argument is
preserved; the previous positional forwarding lambda dropped it. All targets
already confirmed stopped may finish successfully after the shared cutoff.
Unattempted/unconfirmed targets are not marked stopped or broadly revoked.

The eager per-target Promise/result arrays, final filter and exported aggregate
helper are removed. Outside this module the helper was referenced only by its
predicate unit test; actual caller failure controls now cover that behavior. No generic
queue, configurable worker framework or second cleanup owner is added.

The window is a dispatch policy, not a hard HTTP return deadline. Enqueued
requests retain their original result timers. If a result has already entered
proof cleanup when that timer expires, the existing Domain continues to own the
real SQL tail and shutdown joins it before resource disposal. The caller does
not race away that work or add another cleanup registry. Cloud cancellation and
the initial complete metadata selection retain their documented boundaries.

## Docker verification

**49 distinct Docker cases pass, including 21 native PostgreSQL cases.** The first
four-file matrix passes 46 cases. Three subsequently added owner/SQL-tail/shared-pool controls
were each run separately and pass; selection-only skip markers are cases already
covered by the earlier matrix, not waived tests. Product code and shared fixture
helpers were unchanged for those additions. Source, commands, individual case
names, logs and input hashes are retained in the workspace report.

The owning scope is the stopper, actual main wiring, Local lifecycle and Cloud
lifecycle regressions. Six controls first fail on the old implementation,
including unlimited admission, lost budget forwarding and late effects. Existing
lifecycle revision, replacement-proof, best-effort Provider CLI and Cloud exact
work-identity controls remain in the matrix.

| Native scenario | Result |
| --- | --- |
| 64 / 1,024 / 4,096 Sessions, max-one pool | Every target confirmed stopped; preparation peak 16; no proofs left. The 4,096 sample takes about 11.16 seconds. |
| 4,096 Sessions, normal 20-slot pool | All 4,096 confirmed stopped; preparation peak 16; no proofs left; about 4.71 seconds. The earlier baseline stopped only 1,041 and rejected 3,055 for capacity. |
| Shared domain already full | Only the first 16 preparations occur, no stop is sent, all 4,096 proofs remain and the existing diagnostic is emitted. The earlier baseline prepared all 4,096. |
| One shared-domain slot free | The first cohort starts; after the other 15 actual capacity failures, the one admitted result remains pending and is then confirmed. Its exact proof is removed; all 4,095 others remain. Capacity does not abort admitted work. |
| All 16 admitted proof reads blocked in one 20-slot pool | A query through that same pool still completes (about 6.2 ms in the sample), and an independent control stays healthy. Cutoff stops new targets; the actual blocked reads remain owned until release. |
| Actual proof SELECT blocked past cutoff | The original SQL remains owned until release; no new authority transaction or frame follows it. |
| Actual Agent lock wait crosses cutoff | The already-entered transaction settles, but the final Domain signal check blocks enqueue. |
| Result/proof cleanup crosses shared cutoff | Confirmed stop is retained; placement-locked SQL is actually joined and the selected proof is removed after release. |
| Native 30-second window, no Runtime results | About 30.02 seconds; 16 preparations/frames only, no second wave, original failure diagnostic, all 64 proofs retained. |
| Owner closes with first cohort pending | Stop work drains, no later preparation occurs, and a late result performs zero SQL. |
| Original request timer expires during actual proof SQL | A controlled 500 ms request timer settles the notification with its existing diagnostic; Domain.close still waits. Releasing the placement lock completes the same exact cleanup, then close settles. |

Every new native scenario checks committed suspended Agent state, unchanged live
Session identity, actual proof rows, usable SQL and no idle transaction after
settlement. SQL gates use independent holder/observer clients. Budget-boundary
controls inject only a test-local native signal; the separate no-response case
uses the actual production 30-second dispatch window. Runtime frames/results are
controlled ports, not live provider/process throughput.

These are synthetic single samples. Normal successful stop now performs more
useful work than the partially rejected baseline; no claim is made that every
latency or total SQL count decreased. Healthy control queries are queued while
stop runs, and are not parallel queries inside a held transaction. The tests do
not establish a global Session-population bound or an online SLO.

Server typecheck/build and repository gates pass. Independent source review found
no actionable defect; exact committed review is recorded separately. The batch 41
exact review at 03c7005e found no actionable issue.

## Remediation disposition

All original 37 public defect IDs and nine simplifications have local repairs.
AA-R1, IM-R2 and LC-R1 also have verified fixes under their confirmed scopes.
CR-R1 and IM-R1 remain measured scale/atomicity observations; TK-R1 is an external
API compatibility decision (Web already uses paged sections). They do not justify
unconfirmed truncation, new budgets or persistence designs. Private billing
implementation remains unavailable. Prior full Server matrices, Client Runtime
coverage and their explicit skip/affected-rerun boundaries remain as recorded in
[batch 41](sql-caller-repairs-41.md); they were not repeated for this bounded change.
No CI, PR, merge, deployment or live business-acceptance claim is made.
