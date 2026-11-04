# Retained-report claim cost and recovery verification

Issue: [OpenTag #1226](https://github.com/first-tree-ai/opentag/issues/1226).
Supports the [database standards](../../../docs/system/database-read-write-standards.md)
and [accepted recovery contract](../../../docs/system/messaging/im-delivery-claim.md#runtime-budget-and-accepted-recovery).

## Change and boundaries

The retained-manifest transaction keeps the live Session `NO KEY UPDATE` guard,
locks its placement once and rechecks Computer/generation, then loads unreported
manifest deliveries in one bounded scope JOIN. It locks only delivery rows in
ascending immutable ID order. The existing JOIN and per-claim Session, Agent,
Computer, generation, dispatch, input and result-hash checks remain authoritative.
The shared scope helper also serves single-delivery callers without changing
their placement-before-delivery lock order.

Reported rows are excluded. Accepted unreported rows UPDATE their delivery only
when owner/hash changes, with terminal/state/Turn/hash predicates and RETURNING.
A matching unchanged delivery still runs feedback recovery: missing and queued
feedback targets must recover. Pending/expired correlated dispatches keep the
existing atomic batch, acceptance and feedback helpers. A failing later claim
rolls back prior delivery and feedback effects. Conflicting claims remain
individual no-ops; there is no new retry or redispatch mechanism.

The existing protocol maximum is 65 unique claims. Empty manifests do no SQL.
There is no schema, migration, index, Client format, retention, custody deadline,
or external-send change. Query and lock changes follow the revised confirmation
policy; schema changes and migrations still require prior human confirmation.

The production report describes revision `606a58b0`, 29 claims, 117 statements and
a 510.59 ms transaction. Those production logs were not independently queried.
A later author comment reports 1,012.80/1,099.65 ms reconcile transactions and
923.83/1,033.07 ms placement-lock waits by concurrent report replays. Those logs
and the proposed Client-retention explanation were not independently verified;
this repair preserves replay and reduces the same retained-claim lock window.
Baseline measurements use main `f4fd6916c14598e8e872b06865f54adc0c02d2c5`;
implementation was updated to `b0e966df99eb7ea8a0a6b2dea29d8cd19ea98795`, whose
custody source and lockfile are identical. Current main already limits the scope
JOIN lock to the delivery. Broad Agent/binding/Computer JOIN locks from the older
production report were not reintroduced after the Session lock.

## Local measurements

Real PostgreSQL 17-alpine runs in disposable Docker databases with all 74 current
migrations. The host uses Node 24.20.0, pnpm 10.12.1, postgres 3.4.9 and
Drizzle 0.45.2, installed from the worktree lockfile with resolved paths checked.
A shared client uses one connection, normal 30 s statement / 35 s elapsed bounds,
and a native five-second close. No production database is involved.

Each scenario seeds distinct deliveries in one Session through actual dispatch
and acceptance methods. The reported case also uses real terminal report writes.
Unreported cases seed the matching retained hash after acceptance. Timing covers
`RuntimeDomainOwner.handle(session:reconcile:result)` and actual custody SQL. The
connection uses an in-process socket port; authentication, parsing, queue wait,
wire latency and Client replay are outside this handler timing. SQL events count
statements/affected rows; before/after PostgreSQL `xmin` independently verifies
physical delivery writes. Observation queries and BEGIN/COMMIT are excluded from
statement counts, consistently with the normal query instrumentation.

| 32-claim scenario | SQL before → after | Delivery writes before → after | Transaction p50 before → after | Handler p50 before → after |
| --- | ---: | ---: | ---: | ---: |
| Already reported, same instance/hash | 129 → 3 | 32 → 0 | 283.82 → 3.95 ms | 283.94 → 4.02 ms |
| Unreported, same instance/hash | 257 → 131 | 32 → 0 | 381.96 → 237.84 ms | 382.07 → 237.93 ms |
| Unreported, new instance | 257 → 163 | 32 → 32 | 390.21 → 279.68 ms | 390.31 → 279.77 ms |

The first two scenarios have one warm-up plus ten retained samples each; new-owner
recovery has one transition sample per version, not a percentile distribution.
Reported transaction ranges were 188.76–382.55 ms before and 3.65–4.34 ms after;
unchanged-unreported ranges were 330.30–476.80 ms and 199.84–269.68 ms. Maximum
individual query times were 35.46/1.42 ms for reported, 7.87/15.89 ms for unchanged
unreported, and 5.91/5.25 ms for new-owner before/after. Scheduling and local Docker
load affect timing; the exact SQL counts, affected rows and xmin are the stable
regression assertions. The unreported case's isolated maximum increased despite
lower total work; this is not a per-query latency improvement claim.

All three scenarios also pass at 0, 1 and 65 claims. Empty manifests produce zero
SQL, nonempty reported manifests produce three SELECTs independent of length,
and unchanged-unreported manifests write zero delivery rows. The three scope
reads are fixed; necessary per-report feedback and recovery writes are not.
Unchanged-unreported work is `3 + 4N` statements in this fixture; new ownership is
`3 + 5N`. Pending batches retain their additional member/feedback operations.

Actual Drizzle SELECT shapes were captured and run through
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` outside timed handlers. Baseline SELECT
execution was 0.031–0.162 ms. Repaired scope SELECT execution was 0.045–0.684 ms;
the batch query uses existing indexed selection. The unreported fixture also
captures the existing feedback helper reads. These small-fixture plans establish
no production-cardinality or contention guarantee and justify no new index.
The normal SQL summarizer classifies `FOR UPDATE OF` as target `of`; captured SQL
was used to reconcile those events rather than treating `of` as a real table.

The experiment reproduces repeated reads and write amplification. The baseline
did not exceed 500 ms. A single-query goal, alert threshold and transaction
deadline are different; no unconfirmed 500 ms transaction budget was adopted.

## Native correctness and concurrency evidence

- Scope cases reject wrong dispatch, input, generation, Agent, Computer, ended
  Session and another Account's delivery without changing its row. Pending,
  expired and accepted custody can be recovered by a new instance, the previous
  instance cannot record it, and the exact new-owner report records once.
- A conflicting non-null retained hash cannot replace the winner. A null hash
  can be pinned without changing `acceptedAt`. A new instance can replay an
  already-recorded report without taking ownership or changing terminal feedback.
- Missing/queued feedback recovers despite unchanged delivery fields. The cost
  harness independently verifies zero physical delivery writes in those no-op
  owner/hash scenarios.
- Independent connections and `pg_blocking_pids` barriers exercise reverse-order
  manifests with equal and conflicting hashes. The Session/placement guard
  serializes them, valid claims continue beside a conflicting claim, and the
  winning owner records the exact report.
- The actual binding-disable service is exercised before and while a claim holds
  its Session guard. Disable-first prevents recovery; claim-first commits and
  then disables without a lock cycle. The authentic report still settles after
  disable, preserving the existing report-recovery contract.
- Actual Account transfer refuses unsettled custody while a claim is waiting.
  After a settled transfer ends the old Session, its manifest cannot change the
  historical delivery. Placement/report/failed-child interleavings remain covered
  by the retained-lock, IM-binding and steered-recovery regression suites.
- A disposable-database trigger injects SQLSTATE `40001` on the second ordered
  claim after the first created feedback. The complete manifest rolls back,
  feedback remains absent, the connection stays usable, and replaying the same
  identities after removing the fault recovers both deliveries. No automatic
  retry was added.
- Existing machine-credential rotation and WebSocket revocation tests verify the
  unchanged Runtime authentication boundary. This patch does not add an in-flight
  credential-revocation transaction lock or strengthen that pre-existing contract.

## Validation and reproducibility

The focused custody/domain/worker unit run passes 127 cases. The new cost/scope/
concurrency and existing retained-lock suites cover 38 native cases; the initial
concurrency run had two fixture timeouts because a backend-PID observation was
queued on its already occupied single-connection pool. Moving that observation
before the transaction fixes both cases; their targeted rerun passes. The five
other concurrency cases and all 15 scope cases passed in the original run.
A further retained initial-batch case verifies that prefetched reserved members
remain steered children rather than becoming separate Turns. The initial
cross-Account investigation fixture also reused a fixed Feishu app ID;
its uniqueness conflict was repaired before final scope validation.

The four-file owning native matrix covers 157 cases. Its initial command passed
155 and failed two: the 101-message Thread-history fixture exceeded Vitest's
five-second case deadline, followed by a DM-recall `40P01`. This is consistent
with overlapping the next reset with still-running timed-out fixture work, not
a reproduced custody lock cycle. A default-budget selective rerun reproduced both failures;
a diagnostic run with a 15-second CLI case budget passes both without source or
assertion changes. The same two cases pass at the default budget in an isolated
unchanged-base worktree, and subsequently pass unchanged on the repair at the default budget
(Thread case 3,811 ms; recall case 168 ms). The failure is intermittent in this
local environment; it was not reproduced as a baseline code defect. All 157
native identities now have passing coverage, but neither failed broad command
is described as green. No repository timeout or assertion was changed.

Five selected credential-rotation/revocation cases pass. Server typecheck,
`pnpm check` and `git diff --check` pass. Existing repository complexity warnings
pass the unchanged ratchet. One interim repository check rejected excess
complexity in the cost harness; query-plan export was extracted without
changing measurements or increasing the complexity baseline. The optional
fixture ID parameter was also corrected to the existing UUID return type after
typecheck caught an overly broad string annotation.

Representative commands from the repository root:

```sh
pnpm exec turbo run build --filter='@opentag/server^...'
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/retained-report-cost.test.ts src/__tests__/integration/retained-report-scope.test.ts src/__tests__/integration/retained-report-concurrency.test.ts src/__tests__/integration/retained-report-lock-order.test.ts --maxWorkers=1
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/im-recovery-locks.test.ts src/__tests__/integration/im-steered-delivery-recovery.test.ts src/__tests__/integration/im-binding.test.ts src/__tests__/integration/im-recovery-failure-fence.test.ts --maxWorkers=2
pnpm --filter @opentag/server test src/__tests__/runtime-custody-store.test.ts src/__tests__/runtime-domain-owner.test.ts src/__tests__/im-delivery-worker.test.ts
pnpm --filter @opentag/server typecheck
pnpm check
```

Set `RETAINED_REPORT_MEASUREMENTS` to a local JSONL output file to capture samples;
set `RETAINED_REPORT_PLANS` for a one-sample-per-case diagnostic plan export.
Workspace-only raw runs, plans and logs live in `.codex/reports/opentag-1226/`.

Local checks do not establish CI, PR review, merge, deployment or online acceptance.
No production SQL, cleanup, message replay, remote CI rerun, real external business
call or deployment was performed.
