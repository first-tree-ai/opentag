# Feishu setup observation consistency

Supports the [Feishu connection lifecycle](../../docs/system/messaging/feishu-connection-lifecycle.md).

## Scope and regression proof

Issue #983, based on main `4cf2978b64f74a3b3fcaddf37ef3e57558a207d5`.
Three deterministic diagnostics reproduced two read races on that source, using the migrated
PGlite helper and real Agent setup, IM binding and Feishu setup services:

- Activation between independent binding/attempt reads produced authorization-failed at generation
  zero while the actual binding was active at generation one, both when ready and waiting-handoff.
- Normal candidate persistence and registration cleanup turned a captured awaiting-user read into
  a false owner-restarted outcome while the actual attempt was validating.
- The false blocked snapshot stopped the real page's polling classifier and offered an unbind
  that disabled the now-active synthetic binding through the actual service.

The three correct-outcome regressions failed before the implementation. The fixed contract allows
a coherent earlier authorizing snapshot and then current readiness; it forbids mixed failure
snapshots and misleading start/unbind controls.

## Covered boundaries

- One-row binding/attempt observation, readiness versus pending credential handoff, and the existing
  Account/Agent ownership checks, including revocation during a captured public read.
- QR reads through both Agent and exact-attempt readers after registration completes, cancels,
  disconnects, or is replaced. Exact-attempt reads retain their own attempt identity.
- Genuine expiry and owner loss are confirmed. Advancing terminal observations stop after two
  complete reads and expose observation-failed with refresh-only controls.
- Healthy active routes survive unreadable reauthorization context; independent attempt inspection
  still reports that context honestly. Existing lifecycle cancellation and revocation remain fenced.
- Migrated PostgreSQL uses separate reader and writer clients for activation while a real SELECT
  result is held at a barrier. The same engine also exercises registration cleanup against actual
  committed candidate state; provider transport is synthetic.
- Web tests bound automatic and manual observation recovery to GET, including when Runtime
  preparation is also missing. They check budget exhaustion, manual restart, last-good snapshot
  retention, and recovery, without registration, candidate checks, disconnects or preparation writes.

## Validation commands

```sh
pnpm --filter @opentag/server test src/services/agents/__tests__ src/__tests__/agent-setup-api.test.ts src/__tests__/im-binding-api.test.ts src/__tests__/feishu src/__tests__/slack-setup src/__tests__/slack-auto-setup.test.ts src/__tests__/cloud-identities.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/feishu-connection-lifecycle.test.ts --maxWorkers=1
pnpm --filter @opentag/web test src/onboarding-v2/agent-setup
pnpm --filter @opentag/server typecheck
pnpm --filter @opentag/web typecheck
pnpm --filter @opentag/server build
pnpm check
git diff --check
```

## Local result

macOS arm64, Node.js 24.20.0:

| Check | Result |
| --- | --- |
| Affected Server services/API suites | 13 files, 336 tests passed |
| Agent setup Web suites | 7 files, 169 tests passed |
| Real PostgreSQL lifecycle/observation suite | 10 tests passed, including the three added observation cases |
| Server and Web type checks | Passed |
| Server build | Passed |
| Repository checks | `pnpm check` passed |
| Patch whitespace | `git diff --check` passed |

## Acceptance boundary

Local service, database and component tests cover these interleavings. They do not establish which
branch caused the original production response, live Feishu QR authorization, deployment, or
post-deployment acceptance. No existing business binding, Account credential, Agent, schedule or
installed daemon is changed by this validation. No schema, migration, retention or unbind-authority
change is required.
