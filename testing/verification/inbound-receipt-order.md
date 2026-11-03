# Accepted inbound receipt ordering

## Contract and regression

An acknowledged recoverable receipt absent Inbox fences fresh input for its current Agent, including
other Cloud Sessions. The normalizer's lease/backoff is not permission to overtake it. Matching Inbox
identity releases the barrier; frozen work and authentic reports continue. This is the R1 admission
repair, not acceptance of global no-loss, sender completeness, retention or uncertain-input replay.

The original failure on main `b1c235b8` uses signed loopback Slack HTTP and migrated PostgreSQL: both
callbacks return HTTP 200, an injected `40001` rejects the older Inbox insertion, and the newer input
passes the production selector/final claim. The order assertion fails on that baseline. The repaired
case checks selector and final claim separately, recovers the older receipt through normal maintenance,
and uses the actual delivery worker and custody store with a recording runtime to verify both original
message IDs reach the same Agent/Session in order once.

The Feishu case uses the actual connection manager, normalization, receipts and Inbox with synthetic
provider transport/identity responses. It holds newer input during the failed receipt's backoff, takes
over the connection with a new owner, and verifies ordered delivery to the recording runtime.

## PostgreSQL concurrency and authority

`src/__tests__/integration/inbound-admission.test.ts` covers both providers:

- Live lease and future backoff block claim and final dispatch without frozen columns or a report.
- Inbox-committed/receipt-unsettled work releases the barrier; another binding's equal event does not.
- Old generation/holder input is rejected; unrelated Agents can dispatch.
- A new receipt after the selector hint blocks final freezing.
- An independently blocked receipt INSERT holds the Agent fence before commit; a competing actual
  dispatch waits, then observes the committed receipt and defers. PostgreSQL lock waits are observed
  through `pg_locks`, not inferred from elapsed sleeps.
- A dispatch blocked on its delivery row already holds the Agent fence; the actual receipt claim
  waits until dispatch commits. The frozen dispatch can replay despite that later receipt.
- Acceptance and exact terminal-report replay progress while fresh steering remains blocked.
- Slack receipt admission and actual installation observation preserve the lifecycle writers' route
  before installation lock order under independent-connection contention.

Local runtime-owner and Cloud steering tests assert that `inbound_pending` produces no outbound frame
or new custody release. A Cloud worker race inserts receipt work between claim and dispatch, asserts
the specific capped-backoff code with no frozen payload/report, then releases work and retries once.

The process recovery case acknowledges a signed loopback Slack callback while an injected `40001`
prevents Inbox insertion, kills the actual Server child process with `SIGKILL`, then restarts it.
The normal five-second sweep recovers the original receipt into one message and one delivery;
repeating the callback creates no additional input.

## Query cost

The SQL compiled by the production helper was exercised with both providers, 100,000 completed
receipts per provider and 1 / 100 / 1,000 active receipts. All 24 custom/generic prepared execution
plans used the existing partial receipt-work indexes without a receipt-table sequential scan.
Observed warm execution ranges were 0.019–0.055 ms, 0.053–0.323 ms and 0.182–0.671 ms respectively.
These local measurements cover four candidate Agent identities and are not fleet latency, pool
occupancy or throughput guarantees. Active work still bounds scan cost; no index was added.

## Validation and limits

Run the focused receipt, selector, custody, runtime-owner, Local/Cloud worker and Cloud steering unit
tests; the receipt/admission, recovery/claim and Cloud parking PostgreSQL regressions; Server typecheck;
and repository `pnpm check`. No migration or Client implementation changes are included.

Local validation on the implementation based on main `8cb997b2`:

| Check | Result |
| --- | --- |
| Affected unit regressions | 10 files, 265 tests passed |
| PostgreSQL regressions, one worker | 7 files, 89 tests passed |
| Production SQL plan experiment | 3 cases passed, 24 plans inspected |
| Server typecheck and build | Passed |
| Repository `pnpm check` | Passed |

The PostgreSQL group includes `inbound-admission`, `inbound-receipt-recovery`,
`feishu-receipt-recovery`, `inbound-process-recovery`, `im-steered-delivery-recovery`,
`im-delivery-query` and `im-delivery-cloud-parking`. An earlier two-worker run failed with container
removal/connection errors and a Cloud parking timeout during concurrent local validation. The same
seven files passed serially without changing timeouts, assertions or production code. This does not
establish the cause of the parallel-run environment failures or a production capacity guarantee.

The first remote Server coverage run exposed a stale fixture in `inbound-receipt-work-store`:
its installation stored `B_WORK` as `externalBotId`, while its saved work used bot user `U_WORK`.
The production installation writer stores the bot user ID in that column. Correcting the fixture
to `U_WORK` makes all five existing recovery tests pass with the new identity fence intact. These
five cases extend the earlier nine-file unit run; the production implementation is unchanged.

Recording-runtime callbacks stand in for provider execution. No live Slack/Feishu, real model, native
input injection, physical Cloud action, deployment or production replay is exercised. Existing receipt
cleanup and delivery retention/capacity policies remain unchanged. A coordinated Server cutover is
required before claiming the shared-fence guarantee in a deployed fleet.
