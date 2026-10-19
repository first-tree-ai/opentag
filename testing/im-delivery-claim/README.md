# IM delivery claim query acceptance

Date: 2026-10-17. Development base: `96b93b140f9544fdf5e52bfda747a151240f1dc3`.
All database fixtures are synthetic. No production data repair, schema operation, or deployment is
part of this acceptance.

## Scope and reproducibility

The source implementation replaces the correlated claim query with indexed candidate pages,
in-memory metadata/custody joins, and a fresh transactional claim decision. It adds one shared
partial index. Metadata has a five-second, 2,048-Session hint cache; custody is refreshed every
scan and every final transaction, avoiding invalidation hooks across unrelated write paths.

Run the focused functional and PostgreSQL acceptance from the repository root:

```sh
pnpm --filter @opentag/server exec vitest run src/__tests__/im-delivery-selector.test.ts src/__tests__/im-delivery-worker.test.ts src/__tests__/im-delivery-worker-cloud.test.ts src/__tests__/im-delivery-custody.test.ts src/__tests__/im-delivery-recovery.test.ts --maxWorkers=1
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/im-delivery-query.test.ts src/__tests__/integration/cloud-session-concurrency.test.ts --maxWorkers=2 --reporter=verbose
```

The plan suite starts PostgreSQL 16 through Testcontainers; the existing Cloud concurrency suite
uses PostgreSQL 17 and real local WebSockets with synthetic Runner responses. Unit tests use
PGlite. No model or external messaging provider is invoked.

## Acceptance cases

| Area | Evidence |
| --- | --- |
| Backlog fairness | 1,100 blocked Local inputs consume the first eight pages; the next scan reaches an independent Agent. |
| Keyset precision | Seven-row pages preserve PostgreSQL microseconds and UUID tie-breaking without skips or repeats. |
| Cached eligibility | Suspension and cancellation after selection are rejected by the transaction; metadata TTL and invalidation restore the hint. A mismatched Agent cannot claim under another Agent's advisory lock. |
| Fresh custody | Releasing a claim is visible on the next scan without waiting for metadata TTL. A reason-bearing claim still fences the Agent. |
| Ready wakeups | Targeted scans exclude Local inputs and unrelated failures; new due work behind a previous sweep's boundary is found after wrap. |
| Plans with history | At 80,000 reported rows plus 424 and 4,240 blocked inputs, both custom and generic candidate/custody plans use `im_delivery_work_idx`, with no full delivery-table scan. |
| Cancelled history | After cancelling 80,000 synthetic historical rows without VACUUM, custody still uses the shared active index. A 4,241-input Cloud queue reads messages by primary key. |
| Concurrent workers | Existing Cloud integration cases cover exactly-once admission, independent Sessions, a locked head, retry backoff, late earlier input, cancellation, receipt/report identity, and Agent pause. |
| Migration | A concurrent prebuild is accepted; an invalid leftover is rejected. Ordinary fresh-database migration and schema drift are checked separately. |

The plan suite executes SQL produced by the source query builders, with `EXPLAIN (ANALYZE,
BUFFERS, FORMAT JSON)` under forced custom and generic prepared plans. It also runs the actual
selector and transaction recheck through each blocked backlog. Timing output is diagnostic; CI
asserts plan shape and behavior rather than hardware-dependent latency thresholds.

## Validation results

Repository checks, build, typecheck, and schema drift passed. PostgreSQL integration passed all
737 tests in 57 files. Client Agent Runtime coverage passed 640 tests with 100% statements,
branches, functions, and lines. The final focused delivery suite passed 120 tests.
The full Server unit run and a focused observability-mock correction covered 3,874 passing tests
with 16 existing skips; the corrected observability file passed all 26 tests at the default timeout.

The default `pnpm test` run hit two existing five-second deadlines in the Client Context Tree
end-to-end file and stopped the parallel Server/Web run. The Client and its dependencies are
unchanged from the development base. Both deadlines reproduced in isolation; all seven assertions
in that file passed with `--testTimeout=30000`, with the two affected cases taking 5.1 and 8.1
seconds. The default failure is retained as a local validation exception. Repository test settings
were not changed, and CI must pass with those original settings.

## Measured query samples

On local PostgreSQL 16.15, with other repository checks running concurrently, the source plan suite
recorded these `EXPLAIN ANALYZE` execution times (milliseconds; one custom and one generic sample):

| Synthetic fixture | Candidate custom / generic | Custody custom / generic | Cloud head custom / generic |
| --- | ---: | ---: | ---: |
| 80k reported + 424 blocked | 0.053 / 0.071 | 0.128 / 0.378 | — |
| 80k reported + 4,240 blocked | 0.085 / 0.058 | 1.108 / 0.933 | — |
| 80k cancelled + 4,241 Session inputs | — | 0.999 / 1.058 | 5.335 / 5.775 |

Five complete selector-plus-lock runs had medians of 50.31 ms and 148.41 ms for the two reported-history
fixtures, including application/driver work and fresh custody reads between bounded scans. Those
runs omit the polling interval between scans and do not include runtime dispatch. These samples
are diagnostic observations under concurrent local load, not latency acceptance thresholds.

## Operational limits

An independent read-only agent review covered the complete change, the final removal of obsolete SQL
helpers, the strict index-plan assertion, and the observability mock correction before PR creation.
All blocking findings were resolved and re-reviewed. Additional fault injection verified that
a failed scan releases the single-flight gate, queued explicit calls continue, and stopping the
worker prevents queued or later scans from starting.

These are local acceptance results, not production latency or CPU measurements. Custody cost still
grows with the global active set, and Cloud ordering cost grows with the Session's pending queue.
Many distinct Cloud Sessions can also cause one serial head lookup per Session; the performance
fixtures cover the incident's concentrated backlog, not every possible distribution.
The five-second hint TTL may delay work after metadata changes; final checks always bypass it.
Existing timeout/backoff/terminal-state behavior is outside this change. A live rollout must use
the [index prebuild and health checks](../../docs/system/messaging/im-delivery-claim.md#deployment-and-rollback).
