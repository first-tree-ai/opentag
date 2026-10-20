# Steered IM custody without terminal reports

Date: 2026-10-20. Base: `af9705a345b6ce1dde47e7870cfc450d1564edf2`.
Contract: [IM delivery claim queries](../../docs/system/messaging/im-delivery-claim.md).
All inputs are synthetic. PostgreSQL runs in local testcontainers; no user Computer, model,
external message, or production operation is involved.

## Regression cases

- Every existing recovery observation, including the five former stale-failure codes and an
  unknown code, preserves all steered child fields when the accepted target has no terminal report.
- Closing the target Session, even with a replacement Session available, preserves custody.
- Real PostgreSQL tests accept and steer through the custody store, then exercise the worker
  against a reconcile transport failure or a disconnected ConnectionRegistry entry. Diagnostics
  still record the failure. Repeated expiry sweeps through one simulated day preserve the entire
  root and child rows. A separate ended-Session case exercises the same maintenance path.
- Re-registering the original instance through ConnectionRegistry allows a live Session to
  reconcile as busy and the original owner to submit its completed report. An ended Session also
  accepts that original report. A different instance or Turn cannot release the children.
  Report replay is idempotent; completed children stay steered without another delivery or steer.
- Valid failed, cancelled, and unknown reports recover children once in ingress order. Report
  replay, a conflicting completed report, and later janitor sweeps cannot recover them again.
  A pre-existing recorded non-completed report also remains recoverable by the janitor.

Before the production change, the new unit cases failed six times (five error codes and Session
closure), and all three PostgreSQL disconnect/Session cases failed because maintenance requeued
children. After removing those inferred termination paths, the focused suites pass.

Focused commands:

```sh
pnpm --filter @opentag/server exec vitest run src/__tests__/im-delivery-worker.test.ts src/__tests__/im-delivery-retry.test.ts src/__tests__/im-delivery-recovery.test.ts src/__tests__/im-delivery-janitor.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/im-steered-delivery-recovery.test.ts --maxWorkers=1
```

## Validation

- Focused unit tests: 86 passed in four files.
- Focused PostgreSQL integration: 16 passed.
- `pnpm check`, `pnpm build`, and `pnpm typecheck` passed.
- Full PostgreSQL integration: 798 passed in 61 files.
- Agent Runtime coverage: 642 passed, with 100% statements, branches, functions, and lines.
- `pnpm test`: 691 script tests and 10,017 workspace tests passed; 22 existing skips.
  Server tests executed; unchanged workspace tasks reused matching Turbo cache entries.

## Accepted limitation

A missing terminal report can retain accepted custody indefinitely, including after Session
closure. Existing diagnostics remain; abandonment and ownership fencing need a separate policy.
This change adds no schema, queue, protocol, or automatic re-execution path. Local verification
does not establish deployment or production acceptance.

## Recovery and collaboration lock ordering

At base `f41acc1ade0a540c4a9b6b510dd6eedf8e892d4a`, three real custody-store report paths
(`failed`, `cancelled`, and `unknown`) deadlocked with `SessionService.authorizeAndRecordMessage`.
The new `im-recovery-locks.test.ts` holds the root delivery from an independent connection,
observes each Service's actual PostgreSQL blocker, and releases the gate. No production query
is mocked, intercepted, or paused by a test hook. All three initially failed with `40P01`.

The recovery paths now take Session locks before placement/delivery locks. Janitor Session
selection also uses `SKIP LOCKED`, so an occupied Session does not stall an entire background batch.
The focused PostgreSQL suites pass 46 cases, including the six new tests for the three report
interleavings, skipping busy Sessions before target locking, atomic report/recovery rollback,
and the completed-report path. The original fixture is shared with the existing recovery suite.

The change adds one SELECT to non-completed reporting and two SELECTs per nonempty janitor
batch. It adds no transaction, Agent/Account lock, schema, recovery policy, or automatic SQL retry.
Missing reports still preserve custody. The separate historical retention policy is unchanged.

Recovery lock validation: `pnpm check`, `pnpm build`, `pnpm typecheck`, and `pnpm test` passed
(691 script tests, 10,017 package tests, 22 existing skips). Runtime coverage passed 642 tests
with all four metrics at 100%; the full PostgreSQL suite passed 856 tests in 63 files.
