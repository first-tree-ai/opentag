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

On the integrated `179783208a2bca86a582d00039a05893a0fdaf35` base, 272 focused unit tests
and 41 PostgreSQL integration tests pass. The repository patch-coverage evaluator measures 199
changed executable lines, all covered by the focused unit run. Repository checks and Server type
checking pass. These counts describe local checks; CI and review remain required before merge.

## Boundaries

There is no schema, migration, retention, timeout, queue-capacity, execution-budget or retry-policy
change. Renewal uses existing attempt/state/report fences and the final claim transaction retains
its Agent advisory lock and authority checks (AT1, DB1, DB3, LK1–3, IO1–2, ID1–3, ER3, VT1–3).
The tests exercise local PostgreSQL, transport and request ownership, not a physical user Computer,
Cloud deployment or the completeness of unseen provider messages. Deployment and real-environment
acceptance remain separate. Old Server writers do not acquire the new recovery lease, so a mixed
rollout or rollback does not establish the repaired single-owner guarantee.
