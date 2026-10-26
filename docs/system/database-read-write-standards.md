---
title: "Database read/write standards"
description: "Requirements for database design, migrations, atomic writes, authorization, read snapshots, locks, external effects, retries, and concurrency verification."
soft_links:
  - /system/agent-session-computer-model.md
  - /system/server-client-boundary.md
  - /system/messaging/im-delivery-claim.md
  - /operations/observability.md
---

# Database read/write standards

## Decision and scope

These requirements govern changes and reviews involving schemas, queries,
transactions, background maintenance, and external effects whose authority or
identity comes from the database. They are review requirements, not a claim
that every existing path already complies. Keep the rule IDs when recording
a finding or explaining an exception.

Present a concrete database or read/write design for human confirmation before
implementing or approving it. Include the affected paths, invariants, access
patterns, transaction and lock boundaries, failure behavior, validation, cost,
and benefit. Investigation and local experiments may proceed first.

Preserve existing ownership, authorization, state transitions, revisions,
generations, quotas, ordering, deduplication, retention, and custody semantics.
A conflict between code and a documented business promise needs an explicit
contract decision; a standards cleanup must not silently choose a new policy.
Finding a deviation does not authorize its implementation.

## Model, access patterns, and resource budgets

- Give each table a clear responsibility. Define its legal states, uniqueness,
  null meanings, deletion behavior, and retention rules. Protect critical
  invariants in the database with appropriate predicates, constraints, or
  transaction guards; Server memory is not the final authority for ownership,
  admission, or quotas.
- Prefer designs that avoid adding foreign keys. State how application code
  preserves the affected relationship, including concurrent writes and
  cleanup. Keep existing foreign keys unless an approved design changes them,
  and account for their implicit locks when reviewing a transaction.
- Prefer bounded single-table reads followed by Server memory computation or
  mapping when they preserve the same authorization, filtering, ordering,
  pagination, and read-consistency contract. Do not replace an existing JOIN
  solely to satisfy that preference. A JOIN needed for correct selection or
  demonstrated to be appropriate may stay; review its predicates and index
  use. Do not introduce unbounded reads, N+1 queries, or in-memory pagination
  that changes which rows qualify.
- Identify the main query and any bounded enrichment reads. State where
  filters, counts, ordering, and pagination are decided, and how enrichment
  shares the required authorization snapshot. Avoid unnecessary Cartesian
  combinations when mapping related records in memory.
- Use the shared database pool and existing worker controls. Define relevant
  connection use, scan or batch sizes, background concurrency, and waiting
  limits for the changed path. Measure query plans and representative local
  data when investigating a suspected query bottleneck. Do not add a new
  global semaphore, lock service, queue, or retry framework without a concrete
  need and an approved design.
- Reuse the configured database timeouts described in
  [Observability](../operations/observability.md). A statement deadline,
  transaction idle timeout, transport deadline, and whole-operation budget
  cover different waits; document which component owns each applicable bound.

## Migrations

Run commands from the repository root; see the [migration policy](https://github.com/first-tree-ai/opentag/blob/main/packages/server/drizzle/README.md) for schema drift and rollback guidance.

1. Generate SQL with `pnpm --filter @opentag/server db:generate`; add `--custom --name=describe_change` for custom SQL.
2. Keep SQL, `meta/_journal.json`, and generated snapshots under `packages/server/drizzle/` together.
   Journal tags must match SQL filenames without `.sql`; keep indexes and filename prefixes contiguous and timestamps increasing.
3. Finalize SQL, then run `node scripts/check-migration-drift.mjs --update` to append `migration-hashes.json` entries.
   Preserve merged history; reconcile only new migrations and metadata when concurrent changes collide.
4. Match every `CURRENT_MIGRATION_COUNT` under `packages/server/src/__tests__/integration/` to the journal length.
   Before opening a PR, run `pnpm check` and `pnpm --filter @opentag/server test:integration`
   (requires Docker). The count check is covered by integration tests, not `pnpm check`.

## 1. Atomic commit

| ID | Requirement | Review evidence |
| --- | --- | --- |
| AT1 | Facts that must hold together commit in one atomic statement or transaction. | List the invariant, primary and related writes, deduplication record, and state change. A mid-operation failure leaves no partial combination. |
| AT2 | Helpers whose work must roll back together use the same transaction executor. | Trace the actual caller through nested services and callbacks. A root pool call inside a transaction callback does not join that transaction. A locking helper requires a transaction in its type contract; ordinary reads may accept either executor. |
| AT3 | Failure after commit is distinct from rollback. | A notification or cleanup failure does not undo a committed lifecycle change or prove an object is unreferenced. Keep the commit boundary visible in error handling. |

## 2. Final database authority

| ID | Requirement | Review evidence |
| --- | --- | --- |
| DB1 | Authorization and writable state remain protected at the final mutation. | Include owner, state, revision, or generation in the write predicate, or recheck them under a shared transaction guard. Transfer, revocation, and lifecycle paths obey that same guard. A preflight check alone is insufficient. |
| DB2 | Uniqueness and cross-row admission limits do not depend only on a precheck. | Match conflict handling to the unique constraint. For a count limit, lock a stable parent and recount inside the final transaction; all creation paths use the same admission boundary. Locking existing children does not prevent a new child. |
| DB3 | Conditional writes, claims, and deduplication handle the actual database result. | Check RETURNING or affected rows. Zero rows can mean a conflict, a late result, an already processed action, or an idempotent no-op, but cannot authorize an effect the caller did not acquire. |

## 3. Read consistency

| ID | Requirement | Review evidence |
| --- | --- | --- |
| RD1 | Authorization and sensitive details that must agree use one read snapshot. | Use one statement or a short read-only Repeatable Read transaction. Several statements in the default Read Committed transaction do not share a fixed snapshot. Check Account, Computer, and delegated entry points separately. |
| RD2 | Read snapshots and write exclusion express the original contract independently. | Ordinary displays can allow changing observations. Writes still satisfy DB1. Inconsistent counts or pages are defects when they violate the promised interface, not a reason to raise isolation for every read. |

## 4. Lock order and strength

| ID | Requirement | Review evidence |
| --- | --- | --- |
| LK1 | Competing paths acquire compatible lock orders. | Trace the actual cross-table partial order, including indirect updates and foreign keys. Acquire overlapping entity sets in immutable ID order. Preserve required queue ordering and document its compatible lock order. For JOINs, identify which tables are locked. Similar table names do not establish a common order. |
| LK2 | Use the lock strength the invariant needs and keep it for the intended protection window. | Include UPDATE, UPSERT, unique checks, and existing foreign-key locks. A pool-level FOR UPDATE ends with its statement transaction; it cannot protect a later read or write. Decide NO KEY UPDATE locally rather than replacing every FOR UPDATE. |
| LK3 | SKIP LOCKED is limited to work that can safely be revisited. | A later scan must revisit skipped rows. An empty claim does not prove there is no work. Do not use skipped rows as a complete user result or quota count. |

## 5. Database and external-operation boundaries

| ID | Requirement | Review evidence |
| --- | --- | --- |
| IO1 | Transactions do not span human waits, full Runtime execution, or slow object or cloud I/O. | Prepare external resources outside the transaction and make the final database decision inside it. A connection-fenced send that must retain a lock is an explicit exception with a stated protected fact, release point, and waiting contract. |
| IO2 | Reliable work after commit can recover from existing durable facts. | Identify the delivery, durable task, lease, object reference, or later scan that owns recovery. Preserve best-effort notification contracts; do not require a new outbox for every callback. |
| IO3 | External preparation, database commit, and cleanup distinguish their outcomes. | Before deleting a prepared object, establish that no committed row references it. Failure to read the reference is not proof of absence. Cloud allocation and release also recheck the reservation and physical generation or resource identity. |

## 6. Idempotency and late results

| ID | Requirement | Review evidence |
| --- | --- | --- |
| ID1 | Repeated delivery of one business action has a stable identity. | Match request, message, event, or occurrence IDs to database uniqueness. The same ID with different input is not automatically the same action. |
| ID2 | Deduplication and the database effect commit together. | Check both failure windows: deduplication without the effect and the effect without deduplication. State the actual external-send protocol guarantee rather than promising database exactly-once semantics for a network action. |
| ID3 | An old attempt, connection, lease, or generation cannot overwrite a newer state. | Carry the relevant identity and expected state into result updates. A late nonterminal result cannot replace a terminal result. Disconnect, timeout, and missing reports do not establish a terminal outcome. |

## 7. Failure and retry

| ID | Requirement | Review evidence |
| --- | --- | --- |
| ER1 | Business conflicts, confirmed rollback, and unknown commit outcomes are distinct. | Use the database error and operation phase. Do not turn all exceptions into “not committed,” hide a database failure behind success, or interpret a COMMIT deadline as proof of rollback. |
| ER2 | Automatic retries cover a safely replayable whole action and have bounds. | For 40001 or 40P01, investigate the cause and restart from authorization and decisions after full rollback. State attempts, backoff, and the total deadline. The absence of automatic retry alone is not a defect. |
| ER3 | Unknown outcomes are reconciled by stable identity before repeating an action. | Distinguish a lost COMMIT response, an unanswered external request, and a Runtime without a report. Preserve custody and report recovery rules; do not infer permission to redispatch or delete from uncertainty. |

## 8. Verification, waiting, and diagnostics

| ID | Requirement | Review evidence |
| --- | --- | --- |
| VT1 | Critical concurrency claims have real PostgreSQL evidence. | Use independent connections and controlled barriers for the disputed interleaving. Assert the final invariant, error classification, and full rollback. State what a mock, static inspection, or test transport does not verify. |
| VT2 | Each relevant wait has an understandable termination and release path. | Identify lock, statement, transport, and operation bounds and who enforces them. Check rollback and release after failure. An idle transaction timeout may release database locks without cancelling a send; Promise.race and connection liveness detection do not establish transport cancellation. |
| VT3 | Failures can be related to the business operation and database error. | Reuse existing logging and metrics. Keep operation identity, relevant business IDs, elapsed time, and SQLSTATE when available; inspect a bounded cause chain for wrapped driver errors. Keep SQL, parameters, credentials, and private content out of logs. A standards change does not require a new monitoring platform. |

## Applying the rules

Review each changed entry point, including Account or Computer APIs, Agent
delegation, workers, cleanup, and callbacks. Follow helpers to the final
executor; a correct insert does not prove a replace or delete is protected.

For an ownership-transfer case, pause after the old owner's successful check,
perform the actual transfer and a new-owner change, then resume the old
request. A fixed read sees an authorized snapshot, and a fixed write either
commits before the transfer or is rejected after it. Do not add revision bumps
or change history inheritance just to conceal the gap.

For a lifecycle callback, test both orderings of the callback's final admission
and the later lifecycle change. If an existing dispatch marker bounds a lock,
release there rather than waiting for the complete Runtime response. Keep
connection, installation, and placement-generation checks.

For object writes, test a failed acknowledgement after a committed row as well
as a confirmed rollback. For maintenance, test references to unsettled work,
legal terminal outcomes, and the state after the next expiry and retention
passes. Do not silently extend a retention window or create new live work while
describing the change as cleanup.

Separate findings into reproduced correctness defects, standards or
maintainability deviations with current safeguards, and documented exceptions
or unresolved contract choices. Report the trigger, applicable rule IDs,
source and test evidence, minimum change, cost, benefit, and preserved business
semantics. A deliberately misused helper in a test demonstrates an API risk;
it does not prove a production caller made that mistake.

Keep run evidence in `testing/` or the local review record rather than adding
dated status, PR history, or issue lists to this standards page. Follow
[Local validation](https://github.com/first-tree-ai/opentag/blob/main/DEVELOPMENT.md#local-validation); do not repeat
unchanged successful checks merely to complete a review. Distinguish source
changes, checks, merge, deployment, and actual acceptance.

## References

- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html)
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html)
- [PostgreSQL serialization failure handling](https://www.postgresql.org/docs/17/mvcc-serialization-failure-handling.html)
- [PostgreSQL statement and transaction timeout settings](https://www.postgresql.org/docs/17/runtime-config-client.html)
