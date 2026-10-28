# Ordered IM batches and Cloud steering: local acceptance

Date: 2026-10-28. Main baseline: `bd415ef217299690ac54236ed82e1c31534dcc74`.
Queue-policy baseline: `f5d9f488fbaaf93d577cc16d44003bb8b88713df`.
Contracts: [IM content delivery](../../docs/system/messaging/im-content-delivery.md) and
[Cloud Runner execution](../../docs/system/cloud/cloud-runner-execution.md).

## Result and boundary

Local acceptance passes for ordered aggregation, length splitting, correlated member receipts,
and steering a running Cloud Turn. Inputs are synthetic. PostgreSQL uses local migrated testcontainers.
Worker control tests use actual Unix sockets and child-process relay execution, with an injected Pi
runtime. Cloud infrastructure, model upstreams and IM providers are fixtures. These checks establish
local behavior, not deployed Runner/native Sandbox readiness or live IM delivery.

No database migration is introduced. No additional retry loop is introduced. Negotiated Local v3 and
Cloud IM input v1 enable batching; older peers keep individual inputs.

## Accepted cases

- Thirty-five ordered short inputs split at the 32-message bound. Long Chinese inputs split at
  the 16 KiB UTF-8 text bound. Every source ID appears once and in provider order. Requests remain
  within 64 KiB, and the original message projection is not additionally truncated by aggregation.
- The first batch starts one Turn; further batches steer it before completion. Per-member source
  IDs, authors, timestamps, provider references, resources and frozen hashes remain available.
- Real PostgreSQL freezes reservations with the Root request, releases known no-effect batches,
  acknowledges all members atomically, and rolls back the entire receipt if any member conflicts.
- Initial batch members follow the Root outcome. Later unconfirmed steer batches recover every
  member in source order after a recorded non-completed Root report. An exact late receipt can
  settle a batch previously marked `steer_state_unknown`; a mismatched hash cannot.
- A running Worker accepts input through its private socket before its Prompt finishes. Wrong
  authentication or target Turn cannot call Pi steer. Split UTF-8 input is preserved.
- Runner journal intent precedes native injection, and the result precedes transmission. Repeated
  requests and reconnect replay receipts without another injection. Reopened received/started
  intents do not execute automatically. Mismatched acknowledgements retain the journal entry.
- Explicit uncertainty stays frozen on the Server and is not sent again while its Root runs.
  Synchronous capacity failure can release a newly frozen request, but cannot discard an older
  dispatch's execution evidence. Connection replacement follows the same rule.
- A replaced connection cannot settle a steer. Its current report-only replacement can settle
  the exact receipt while remaining unable to authorize another input. IM input capability is
  echoed only alongside negotiated Cloud delivery.
- Existing recovery lock ordering and failure-reaction integration remain covered on PostgreSQL.

## Validation

| Scope | Observed result |
| --- | --- |
| Shared Runtime/Cloud schemas, hashes and protocol corpus | 123 passed in 4 files |
| Server delivery, custody, recovery, reactions and Runner WebSocket regression | 326 passed in 9 files |
| Final connection-replacement and capacity follow-up | 55 passed in 2 files |
| Client journal, Turn controller, native Worker and socket relay | 145 passed in 4 files |
| Local custody compatibility after the legacy observer adjustment | 31 passed |
| Runner serve regression | Passed in the affected Client run |
| PostgreSQL dispatch, member recovery, query plans, recovery locks and reactions | 39 passed in 5 files |
| Added PostgreSQL connection replacement/report-only receipt case | Passed; owning file 6 passed |
| Shared, Client and Server type checks and builds | Passed |
| `pnpm check` and `git diff --check` | Passed |

The broad Server and PostgreSQL runs precede the final bounded connection/capacity guard;
the owning suites were rerun afterwards. Unchanged successful suites were not rerun solely for
closeout. Agent Runtime coverage is not applicable: no file in its configured coverage include set
changed. No full workspace suite or full PostgreSQL suite was run; the changed contracts and database
paths have bounded coverage above, and there is no migration. CI and live acceptance remain separate.

## Independent review follow-up

Independent review of `63653a3d3757ee419fe6a3fec3ca657a1a7fe9ac` found three P2 boundary defects.
They are covered by focused regressions and corrected before PR creation:

- A full Cloud control map releases a newly reserved, never-sent input, while retaining older
  dispatch evidence. The new regression failed before the correction and passes afterwards.
- A steer arriving after its Root report acknowledgement receives a known no-effect response when
  unseen. Existing received, started, successful and uncertain child journals are handled first;
  mismatched input cannot borrow an older receipt. No native input is injected in these cases.
- Failed/cancelled/unknown Root reporting can skip a concurrently claimed steer head. Real
  PostgreSQL interleavings now preserve the whole frozen batch until all member locks are acquired.
  The reverse case, with a member locked, also retains its frozen head. The claim defers to recorded
  failed-Root recovery. All three original failed-Root schedules failed before this correction.

Exact uncertainty also survives later retry/deferred receipts, while exact success may settle it.
Local `input_conflict` results use the same uncertainty rule as Cloud.

Review-fix validation: 205 Server tests in seven files, 154 Client tests in three files, and 46
PostgreSQL tests in five files passed. The Client controller's 88 tests were rerun after a bounded
refactor. Type checks and builds cover both changed consumers. Shared protocol/queue-policy code
has not changed since the earlier successful checks. No migration, independent retry owner, or
live-provider acceptance is introduced by the review fixes.

Reproduction commands:

```sh
pnpm --filter @opentag/shared exec vitest run src/__tests__/runtime-domain.test.ts src/__tests__/runtime-protocol.test.ts src/__tests__/cloud-runner.test.ts src/__tests__/runtime-protocol-corpus.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/cloud-im-steering.test.ts src/__tests__/im-delivery-worker.test.ts src/__tests__/im-delivery-worker-cloud.test.ts src/__tests__/runtime-custody-store.test.ts src/__tests__/runtime-domain-owner.test.ts src/__tests__/im-delivery-janitor.test.ts src/__tests__/im-delivery-recovery.test.ts src/__tests__/im-failure-reactions.test.ts src/__tests__/cloud-delivery-owner.test.ts src/__tests__/runner-ws.test.ts --maxWorkers=2
pnpm --filter @opentag/client exec vitest run src/__tests__/cloud-steer-control.test.ts src/__tests__/cloud-turns.test.ts src/__tests__/cloud-turn-worker.test.ts src/__tests__/cloud-journal.test.ts src/__tests__/turn-custody-owner.test.ts src/__tests__/runner-serve.test.ts --maxWorkers=2
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/cloud-dispatch-custody.test.ts src/__tests__/integration/im-steered-delivery-recovery.test.ts src/__tests__/integration/im-delivery-query.test.ts src/__tests__/integration/im-recovery-locks.test.ts src/__tests__/integration/im-failure-reactions.test.ts --maxWorkers=2
pnpm --filter @opentag/shared typecheck
pnpm --filter @opentag/client typecheck
pnpm --filter @opentag/server typecheck
pnpm --filter @opentag/shared build
pnpm --filter @opentag/client build
pnpm --filter @opentag/server build
pnpm check
```
