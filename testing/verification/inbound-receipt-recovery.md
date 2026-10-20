# Inbound receipt recovery

Contract: [Message domains and routing](../../docs/system/messaging/message-domains.md#durable-inbound-receipt-work).

## Baseline

On `f41acc1ade0a540c4a9b6b510dd6eedf8e892d4a`, a real signed Slack HTTP event returned 200,
then a local PostgreSQL trigger rejected the actual Inbox insert with `40001`. Removing the
trigger restored the database, but redelivering the same event still skipped Inbox. Real
Slack and Feishu receipt stores also refused failed and abandoned processing entries. Those
baseline assertions demonstrate the gap; they are not post-fix validation.

## Regression scope

`integration/inbound-receipt-recovery.test.ts` exercises the real HTTP route, HMAC validation,
Slack adapter, ImBindingService, receipt store and Inbox against migrated PostgreSQL:

- An acknowledged Inbox failure recovers without provider redelivery.
- Fresh application state resumes abandoned persisted input after lease expiry.
- Concurrent replicas claim one attempt, and old or unfenced settlement cannot overwrite it.
- Inbox commit followed by interrupted receipt settlement remains message/delivery-idempotent.
- Unsupported events, mismatched Bot identity and absent routes retain ignored behavior.
- Live and recovered permanently stale routes settle once, clear work input and keep their diagnostic
  error code. Invalid saved work schema or identity also settles without repeated Inbox attempts.
- Credential revocation and unbind do not restore old authority; unreadable current credentials
  retain work for a capable replica instead of discarding it.
- Missing required permissions in the current installation grant end work once without another
  attempt; the existing installation query returns the grant metadata without extra queries or locks.
- Live processing and recovery pass identical projected input to the real Slack adapter.
- Original direct and ambient receive timestamps/deadlines survive delayed recovery.
- Expiry clears work input while the original terminal/legacy receipt retention remains intact.

`integration/feishu-receipt-recovery.test.ts` exercises the actual ConnectionManager, receipt
store, normalization and Inbox with synthetic provider transport/identity responses:

- A fresh owner on a separate PostgreSQL connection recovers an Inbox failure.
- Old connection callbacks cannot persist work after takeover.
- Missing/current-owner fences and original generation are rechecked.
- Inbox commit followed by failed receipt settlement recovers without duplicate delivery.
- Concurrent initial receipt inserts and lease claims have one winner; Feishu deduplication
  remains binding/event-scoped across credential generations.
- A normal self-message can finish its receipt without creating a message or delivery.

Unit coverage compares canonical normalization before/after the Slack field projection for
file-share fixtures and created/edited/deleted rich content. It checks input size/version
bounds, credential-field removal and retry scheduling. Five PGlite receipt-work tests also check
due-time/lease conjunction, scoped claims, stale/unfenced settlement, current installation identity,
provider validation and cleanup without relying on query-builder stubs. Existing transport, receipts, Inbox,
retention and connection-lifecycle regressions remain applicable.
Durable Slack control-event tests retain uninstall and exact Bot-user token-revocation behavior.
The real Feishu callback tracing regression distinguishes a claim-time stale fence from a database failure.

## Commands

```sh
pnpm --filter @opentag/server exec vitest run src/__tests__/inbound-work.test.ts src/__tests__/slack-events.test.ts src/__tests__/feishu-adapter.test.ts src/__tests__/slack-webhook-receipt-store.test.ts src/__tests__/feishu-inbound-receipt-store.test.ts src/__tests__/im-delivery-janitor.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/inbound-receipt-recovery.test.ts src/__tests__/integration/feishu-receipt-recovery.test.ts --maxWorkers=1
```

All data and credentials are synthetic. No model, external IM send, live provider transport,
production database, historical backfill, merge or deployment is part of these checks. The
migration adds three nullable columns and a partial work index to each existing receipt table,
with bounded-work/lease shape checks, and preserves existing receipt identity keys and FKs.
Deployment must coordinate old receipt-writer shutdown; local checks are not live acceptance.

## Initial validation results

Initial receipt revision `f55535a4f392931e58d44f3cbfb18debf6c948d2`, based on
`f41acc1ade0a540c4a9b6b510dd6eedf8e892d4a`, was validated on Node 24.20.0:

| Check | Result |
| --- | --- |
| `pnpm check`, `pnpm build`, `pnpm typecheck` | Pass |
| `pnpm test` | 691 script tests and 10,029 package tests pass; 22 existing skips |
| Client Runtime coverage | 29 files, 642 tests pass; statements, branches, functions and lines all 100% |
| Full migrated PostgreSQL suite | 64 files, 872 tests pass, including 22 new receipt recovery cases |
| Server unit coverage / changed-line gate | Pass; changed lines 496/548 (90.51%), above the 80% floor |

The final PostgreSQL and Runtime runs used the same production source as the final unit/coverage
runs. The only subsequent additions were the five PGlite unit tests and this verification record.
These are local checks with synthetic external transports, not production or live-provider acceptance.

## Permanent-input follow-up validation at `320e533f`

The live and recovered permanently stale-route cases and the two invalid saved-work cases
first retained retryable input on the initial revision. They now settle once, preserve a diagnostic
error code, and remain unchanged after another recovery sweep. Transient Inbox failure,
Inbox-committed/receipt-unsettled replay and unreadable-current-credential recovery still pass.

The final source passed `pnpm check`, `pnpm build`, `pnpm typecheck`, and `pnpm test`
(691 script tests, 10,031 package tests, 22 existing skips). Runtime coverage passed 642 tests
with all four metrics at 100%; full migrated PostgreSQL passed 876 tests in 64 files, including
26 new receipt recovery cases. Server unit coverage passed; changed lines were 511/566
(90.28%, above the 80% gate). No query, transaction or schema change was added by this follow-up.

## Review-comment follow-up validation

Negative controls reproduced three differences before the fixes: live and recovered Slack adapter
input differed, a current grant missing required Bot permissions retained retryable work, and a
claim-time Feishu stale fence was traced as a database failure. The corrected source passed 106
focused unit tests and 27 real PostgreSQL receipt-recovery cases. Durable uninstall and token
revocation retain their existing behavior; complete but unreadable current credentials still
recover through a capable replica. The existing installation lookup only adds grant metadata to
its projection; no query, transaction, lock or schema is added.

All required local checks passed on the same production source: `pnpm check`, `pnpm build`,
`pnpm typecheck`, `pnpm test` (691 script tests and 10,035 package tests, 22 existing skips),
Runtime coverage (642 tests, all four metrics at 100%) and the full migrated PostgreSQL suite
(64 files, 877 tests). Server unit line coverage was 90.67%; changed-line coverage was 532/584
(91.10%, above the 80% gate). These remain synthetic local checks, not live-provider acceptance.
