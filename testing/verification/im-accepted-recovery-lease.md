# Accepted recovery lease and cancellation

Contract: [IM delivery claim queries](../../docs/system/messaging/im-delivery-claim.md).
All deliveries, identities and reports are synthetic. PostgreSQL and WebSocket traffic remain local.
No Staging delivery is replayed and no external provider or model is called.

## Reproduction

On `d50c96e9de8930146b5e5aff1c9f5c5c22c01e1a`, independent PostgreSQL connections
scan while one accepted reconcile is blocked. After 2.5 seconds the expected attempt 25 has already
become 26. This regression fails against the original source and passes with the repair.
The worker's default-budget manual reproduction also keeps its ordinary 500 ms polling,
30-second operation timeout and eight queued slots; see the task-local run record for observations.

## Regression coverage

`packages/server/src/__tests__/integration/im-delivery-recovery-lease.test.ts` uses migrated
PostgreSQL 17, independent pools, real timers and controlled barriers. It checks:

- Repeated owner and competing-worker scans across the former two-second retry and multiple
  lease periods retain one attempt, one reconcile and zero duplicate queued tasks.
- Renewal starts before enqueue and continues behind the scheduler's global concurrency limit.
  Closing cancels the active waiter, drops queued recovery and stops its renewal without a
  saturation failure. Shutdown joins delayed cancellation cleanup.
- Cooperative deadline cancellation produces one timeout disposition and no recovery-failed or
  late-settle diagnostic. Real late completion and abandonment remain distinguishable; the
  delivery remains owned until the underlying operation actually settles.
- A recorded report or newer attempt wins over renewal and delayed response writes.
- An actual renewal backend is terminated while blocked on an independently held row lock.
  The old waiter cancels, retains custody, and a fresh owner can subsequently recover it.
- The production `RuntimeDomainOwner` and `PostgresRuntimeCustodyStore` exchange real frames
  over loopback WebSockets for busy, timeout, disconnect and stop. A late reconcile cannot
  rewrite timeout backoff; a later authentic report records once and its replay is acknowledged
  as already recorded. No `im:deliver` or `im:steer` frame is emitted.

The focused unit tests distinguish deadline cancellation from real late resolution/rejection and
abandonment. Runtime owner tests retain ownership of an admitted send callback or admitted result
processing during cancellation. Existing Local and Cloud worker, retry, custody, selector, janitor
and scheduler suites guard the adjacent dispatch, batching, ordering and report fences.

## Commands

Prepare workspace dependencies and build the Shared and preset exports before testing.
For local Docker Desktop use the workspace's IPv4 override and keep Ryuk enabled:

```sh
TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1 pnpm --filter @opentag/server exec vitest run src/__tests__/integration/im-delivery-recovery-lease.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/im-delivery-deadline.test.ts src/__tests__/im-delivery-worker.test.ts src/__tests__/im-delivery-worker-cloud.test.ts src/__tests__/runtime-domain-owner.test.ts
pnpm --filter @opentag/server typecheck
pnpm check
```

## Local result

On the integrated `1f5a25527996a4ce7bbba61f2fb8ac97acc381c2` base, 272 focused unit tests
and 41 PostgreSQL integration tests pass. The repository patch-coverage evaluator measures 203
changed executable lines, all covered by the focused unit run. Repository checks and full-workspace
type checking pass. These counts describe local checks; CI and current-head review remain required.

Joined settlement is explicitly requested only by accepted recovery. The existing lifecycle stop
path keeps its bounded waiter and separately drained owner. The three stop regressions exposed
by the first CI run pass after scoping this option. The complete lifecycle suite passes 17 of 18
cases locally; its 4096-Session, max-one pool case still reaches the existing 30-second dispatch
budget, matching the separately tracked #1264 investigation. No budget or concurrency is changed.
The first CI run also failed an unchanged Client legacy-report recovery assertion; all 52 tests in
that file pass locally. Its CI-only cause remains unconfirmed, and no Client source/test is changed.

## Boundaries

There is no schema, migration, retention, timeout, queue-capacity, execution-budget or retry-policy
change. Renewal uses existing attempt/state/report fences and the final claim transaction retains
its Agent advisory lock and authority checks (AT1, DB1, DB3, LK1–3, IO1–2, ID1–3, ER3, VT1–3).
The tests exercise local PostgreSQL, transport and request ownership, not a physical user Computer,
Cloud deployment or the completeness of unseen provider messages. Deployment and real-environment
acceptance remain separate. Old Server writers do not acquire the new recovery lease, so a mixed
rollout or rollback does not establish the repaired single-owner guarantee.
