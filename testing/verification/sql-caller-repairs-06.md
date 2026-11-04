# SQL caller repairs: SQL classification and terminal fences

Continues the [remediation checklist](../sql-caller-remediation.md) after
`79106cdc41ae89713812f114fa9ead876dcd14b1`, based on main `8cb997b2`.
Implements the recorded minimum proposals confirmed by the instruction to fix all
findings progressively. No schema, timer, retry mechanism, provider policy or
generic Local durable-state transition change.

| Finding | Implementation | Native result |
| --- | --- | --- |
| SW-F1 | Narrow the provider try/catch to setThreadStatus. Credential/desired/claim SQL and successful/failure settlement reach the existing pump boundary. Remove the initial mutable working value. | Real 57014 at each of four SQL stages leaves provider failures/disablement unchanged. Four consecutive SQL faults recover after the existing 90-second claim lease. A real committed settlement followed by simulated method acknowledgement loss is not classified as an API failure or settled twice. Existing provider retry/circuit/stop controls pass. |
| IM-F4 | Route the recovery operation deadline through the existing unreported/attempt-fenced defer helper. Generic failure updates also require reportedAt NULL and the captured attempt count. | An actual completed Turn report wins over timeout and late reply. An independent second Worker reclaims a test-shortened lease and keeps its newer attempt/schedule. The still-current unreported attempt records its legitimate timeout. Both deadline and late continuation are awaited in the test. |
| CR-F2 | Pass the already-read Runner record to terminal CAS. Retirement scans the complete record and reuses the existing row-to-record decoder, removing its later reread too. Replace generic write with the existing Computer/record-guarded CAS. Clear exact Turn busy/grants only after successful/identical persistence. | With a real Computer lock ordering concurrent writes, unknown and cancelled Runner results commit first; allocation retirement loses CAS and cannot overwrite either. Identical replay is acknowledged; a stale expected record is refused. Existing missing/conflicting results, current custody and retirement suites pass. |

The pure durable-row decoder is shared with the existing store rather than
duplicated. Optional/degraded CAS ports fail closed. A replaced or failed record
is not blindly retried, and a lost acknowledgement is not rollback evidence.
No transaction spans a Slack or Runner result wait.

## Validation

**289 distinct passing cases: 90 native PostgreSQL in Docker and 199 host
unit/API.** Fifteen native cases are new. Passing executions are also 289:
the selective unit retry had not passed earlier, and no successful identity
needed to repeat.

| Run | Passed | Failed | Disposition |
| --- | ---: | ---: | --- |
| Initial Cloud owner/Worker unit | 108 | 1 | An old cancellation test paused the removed duplicate store.read and timed out. Its SQL-stage observation needed to follow the actual scan. An absent selected filename contributes no cases. |
| Selective cancelled-read unit retry | 1 | 0 | Pause the actual table scan and assert the current CAS method is not invoked after cancellation. The failed identity now passes. |
| Slack worker/status/store unit | 35 | 0 | Provider failures, limits, absolute status replay and claim behavior. |
| Durable store/Local transitions/IM retry unit | 55 | 0 | Existing quotas, generic state matrix and retry contracts. |
| New native faults | 15 | 0 | Four actual SQL failure stages, lease recovery, settlement uncertainty, real report/new-Worker/timeout paths and two terminal races. |
| Owning native regressions | 75 | 0 | Cloud Session, steered IM recovery and Slack working status. |

The historical fault scenarios were revalidated in current source and converted
to repaired acceptance cases; this batch does not claim a fresh pre-repair RED
execution of every scenario. Initial fixture type errors and the failed unit run
are retained. The acknowledgement-loss port throws after actual SQL settlement;
no PostgreSQL wire-level lost-COMMIT injection or live Slack call is claimed.
Lease recovery uses the controlled store clock. Runtime/Runner sockets are
controlled while PostgreSQL report, claim, custody, CAS and locks are real.

Environment and workspace-only evidence directory match
[batch 2a](sql-caller-repairs-02.md): immutable Docker image, Node 24.22.1,
PostgreSQL 17-alpine, all 73 migrations; host Node 24.20.0. Server typecheck,
server build and repository gates pass. The existing Worker size allowance and
complexity baseline are unchanged. Diff review covers catch boundaries, exact
post-claim counters, supplied record identity, CAS/cleanup order and cancellation
after the actual read. Independent PR review, CI, full binary shutdown,
deployment, live providers and private billing acceptance are not claimed.

These three findings are repaired locally. Preparation/send cancellation,
high-level drain ownership and the other 22 defects remain separately open.
