# runtime-custody-safety-2 progress

## Checklist

- [x] 1. Survey custody, domain owner, delivery worker, and scheduler.
- [x] 2. Decide and document the replica model.
- [x] 3. Add failure-injection tests first.
- [x] 4. Implement ARCH-03 custody and dispatch safety.
- [x] 5. Add RUNTIME-01 scheduler tests first.
- [x] 6. Implement RUNTIME-01 bounded delivery lanes and deadlines.
- [x] 7. Run full verification and finish the lane.

## Item 1 — survey (pre-change evidence)

- `beginDeliveryDispatch` had no compensating release path. `beginSteerDispatch` had `releaseSteerDispatch`, but
  only steer paths called it. Both methods persisted dispatch markers in `im_message_deliveries`.
- `RuntimeDomainOwner.#request` inserted an in-memory pending entry before `registry.send`; direct-delivery timeout and
  send-failure paths did not release the durable marker. `close()` released steer markers only.
- `ImDeliveryWorker.#claim` awaited `afterClaimRowLocked` inside a database transaction. The worker's active-agent
  admission and `agent-session-stopper` also awaited external runtime dispatch while holding a row lock.
- Durable delivery columns (`dispatchRequestId`, `dispatchInputHash`, `dispatchPayload`, custody state,
  `reportOwnerInstanceId`) were recoverable state. Owner maps, `ConnectionRegistry.#entries`, and the worker's old
  `#running` guard were process-local facts.
- The exact old global single-flight point was `ImDeliveryWorker.#running` in `runOnce`; a second tick returned while
  the first claim/delivery was active. `KeyedTaskScheduler` supplied process-local keyed ordering but no metric/deadline
  seams.

## Item 2 — replica decision

Persisted recoverable ownership is the selected model. `im_message_deliveries` is the recovery authority across process
restarts and replicas. Runtime owner and registry maps are bounded performance caches only. Existing dispatch payload,
request-hash, claim-lease, custody, and report-owner columns already persist the required state, so no migration was
needed. The model is documented in `runtime-custody-store.ts` and `im-delivery-worker.ts`.

## Item 3 — failure-injection tests

Added deterministic owner tests for synchronous runtime send failure, dispatch timeout, and steer admission capacity
failure. They assert compensating release calls and marker state. Existing unit and integration coverage continues to
assert duplicate identity, capacity exhaustion, restart/rebuild custody recovery, and exactly-once settlement.

## Item 4 — ARCH-03 implementation

Added `releaseDeliveryDispatch` with request/hash compare-and-set fencing. Direct-delivery admission and send failures
use `retry` release to clear markers. Timeout and owner shutdown use `deferred` so a late result remains recoverable for
reconciliation. Agent admission, stop notifications, and the claim hook now finish short database transactions before
external runtime work. No schema migration was added.

## Item 5 — RUNTIME-01 tests

Extended keyed scheduler tests with an injected clock and queue-age assertions while retaining independent-agent
progress tests. Saturation behavior is covered by the database workflow tests.

## Item 6 — RUNTIME-01 implementation

Removed the worker-wide single-flight guard. Claims now run through bounded `KeyedTaskScheduler` lanes keyed by agent,
preserving per-agent order while allowing independent agents to progress concurrently. Worker options provide global and
per-agent queue bounds, optional queue-age budgets, and per-operation deadlines. Saturation and timeout paths persist
bounded retry codes. Metric callbacks expose queue age, queue depth, active lanes, saturation, retry, and timeout
observations. Scheduler age calculations use an injected clock.

## Item 7 — verification

- `pnpm check` passed. Biome reported only existing cognitive-complexity warnings; notices, workspace contract, and
  migration drift passed.
- `pnpm typecheck` passed across all six workspaces.
- `pnpm test` passed, including 50 server test files and 497 server unit tests.
- `pnpm --filter @opentag/server test:integration` passed: 16 files and 293 tests with Docker-backed PostgreSQL.
- `git status --short --branch` is clean. Branch `fix/runtime-custody-safety` is eight commits ahead of `origin/main`,
  including this coverage follow-up.
- No migration or public-export snapshot changed. The shared main-checkout `.gitlock` is absent.

## Item 8 — CI patch-coverage follow-up

- Added focused unit tests for queue-age expiry, post-boundary placement fencing, operation deadlines and claim
  renewal, bounded-lane saturation/drop disposition, and synchronous runtime send failure.
- Moved type-only worker, scheduler, and custody contracts into `.d.ts` declarations. This keeps declarations out of
  executable-line accounting without weakening or changing the patch-coverage gate.
- `pnpm test:coverage` passed with aggregate unit coverage of 95.82% (46,061/48,068 lines).
- Evaluated `origin/main...HEAD` with `scripts/unit-coverage-gate.mjs`: 234/234 changed executable lines covered (100%),
  threshold 80%, no uncovered lines.
- All required checks are complete. No push, pull request, CI, merge, deployment, or live verification was performed;
  the orchestrator owns publication.

All checklist items and the coverage follow-up are complete. `.dispatch/DONE` has been rewritten.
