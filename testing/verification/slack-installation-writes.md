# Slack installation lifecycle writes

Supports [Slack App setup](../../docs/system/messaging/slack-app-setup.md).

## Scope

Provider observation, identity closure, token revocation and uninstall lock the current Slack route
before updating the installation. The route guard uses `FOR NO KEY UPDATE`; shared teardown orders
binding, installation and Session termination. Existing installation/route updates stay in their
original transaction, with the original status/generation predicates and post-commit notifications.
No Account or Agent lock, transaction, migration, automatic retry or provider call is added.

The current route is unique per installation under the existing partial index. Observation, identity
closure and revocation each add one SELECT. Uninstall moves and reuses its route SELECT, adding no
successful-path query; a stale or missing uninstall now performs that SELECT before returning false.
Stale events can briefly wait for the current route even though they make no durable change.

The OAuth documentation also distinguishes the current Web recovery entry from the existing
older-client `reauthorize` callback compatibility: a different identity can replace installation and
route records, end old Sessions and retain replacement pointers. No replace intent or new UI is added.

## PostgreSQL concurrency regression

`packages/server/src/__tests__/integration/slack-installation-locks.test.ts` uses migrated PostgreSQL
and actual Services on separate connections. External test transactions hold a row gate;
`pg_stat_activity` confirms both intended waits before release. Product queries and hooks are not
replaced. Statement deadlines are confined to the test connections.

On unmodified main `af9705a345b6ce1dde47e7870cfc450d1564edf2`, the original four-case subset reproduced
`40P01` for every event kind against management unbind. The post-fix expectation is successful
completion with the original business result, rather than a particular deadlock victim.

| Interleaving or invariant | Expected result |
| --- | --- |
| Unbind, same-identity reauthorization or Agent deletion ahead of each of the four event kinds | Both finish; old event returns false |
| Each event ahead of unbind or reauthorization | Original success or configuration conflict, with no partial generation change |
| Suspended Agent, while another connection holds its Agent row | Events still execute without waiting for the Agent lock |
| Operator transfer with Slack keep or disable ahead of each event | Transfer preserves the selected behavior; provider lifecycle still works after keep |
| Session create, send, ordinary dispatch admission or scheduled admission ahead of each event | Both finish; admission remains valid when ordered first |
| Event holds the route and waits for installation while a new chat Session is inserted | Session FK check completes, preserving KEY SHARE compatibility |
| Repeated identity closure | First closure timestamp remains stable; observation refreshes |
| Stale/missing event or event after uninstall | False with no durable mutation |
| Runtime credential grant around closure, revocation, reauthorization and uninstall | Original generation and lifecycle fences remain enforced |
| Slow external credential inspection while unbind runs | Unbind completes; stale configuration fails after inspection resumes |

The existing Slack custom-configuration suite covers concurrent App/Team claimants. The OAuth suite
covers older-client identity replacement, ended Sessions and replacement provenance. Full integration
also retains the existing Session, schedule, Agent transfer, working-status and credential suites.

## Human continuation and limits

The Web ticket/challenge and confirmed pending-approval responses finish their current request;
waiting for user commands or approval does not keep the configuration transaction open. Only actual
Computer execution retains a bounded in-flight request. OAuth external calls also precede the final
configuration transaction. This change does not alter those boundaries or add polling.

These local synthetic checks do not establish production incidence, capacity, a globally acyclic
lock graph, live Slack delivery or a real user approval. No deployment or production operation is
part of validation. Machine-specific logs remain outside the repository.

## Recorded validation

Local run: 2026-10-20, Node 24.20.0, pnpm 10.12.1, PostgreSQL 17.11 with 64 migrations.

- Focused PostgreSQL regression: 4 files / 81 tests passed, including all 52 new cases.
- `pnpm check`, `pnpm build` and `pnpm typecheck` passed.
- `pnpm test` passed: 691 repository-script tests and 10,015 package tests, with 22 existing skips.
- Client Agent Runtime coverage: 29 files / 642 tests passed; statements, branches, functions and
  lines each reached 100%.
- Full PostgreSQL integration: 62 files / 846 tests passed with the default two-worker command,
  including all 52 new cases. This run followed unit and Runtime coverage completion.
