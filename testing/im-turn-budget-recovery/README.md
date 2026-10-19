# IM Turn budget and recovery acceptance

Date: 2026-10-19. Base: `9f80f340db562274069731887f27092b4f50b7f1`.
All inputs are synthetic; no model, external message, production operation, or user Computer is used.
Contract: [IM delivery claim queries](../../docs/system/messaging/im-delivery-claim.md).

## Regression cases

- A seven-day message deadline with no explicit budget still times out at the existing 30-minute
  default. Explicit shorter and longer budgets, shorter deadlines, absent deadlines, and expired
  requests retain their stated semantics without mutating the frozen request.
- A controlled runtime exits on abort; the actual Turn Runner creates and submits one timeout
  report. An expired request does not start the Provider and reports `executionEffects: not_started`;
  a running timeout remains `may_have_occurred`. Slack activity expires on the same
  budget rule rather than following message retention.
- Every accepted reconcile status preserves custody and records its actual deferred state.
  Repeated responses follow 2/4/8/16/30/30-second delays and do not dispatch business execution.
- A report arriving during reconciliation wins over a retry write. A newer attempt also prevents
  an older response from rewriting its diagnostic or next-attempt time.
- After each deferred status, the real janitor runs after backoff expires and before another claim.
  Previously steered children retain their complete row and are never delivered or steered again.
  The `running`/`reporting` cases exercise defensive response classification; this stopped request
  normally returns `busy / active_turn` for a live Turn.
- Healthy `busy`/`running`/`reporting` responses emit no error diagnostic. Abnormal responses and
  transport failure remain diagnostic. Only the janitor's five explicit stale-failure codes
  recover children; all deferred response codes and unknown observations preserve custody.
- Real PostgreSQL coverage accepts and steers children through the custody store, then verifies
  that a due deferred code followed by expiry maintenance leaves the children unchanged.
- The existing Cloud queue plan check uses explicit message and delivery statistics. A controlled
  stale-statistics setup keeps background auto-analyze out of the experiment, verifies the seeded
  row estimate, and retains the strict primary-key lookup and no-message-sequential-scan assertions.

Focused commands:

```sh
pnpm --filter @opentag/client exec vitest run src/__tests__/turn-timeout.test.ts src/__tests__/agent-turn-runner.test.ts src/__tests__/turn-activity-reporter.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/im-delivery-worker.test.ts src/__tests__/im-delivery-retry.test.ts src/__tests__/im-delivery-recovery.test.ts src/__tests__/im-delivery-janitor.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/im-delivery-query.test.ts src/__tests__/im-delivery-selector.test.ts --maxWorkers=1
```

## Validation

- `pnpm check`, `pnpm build`, and `pnpm typecheck` passed.
- `pnpm test` passed: 691 script tests and 9,992 workspace tests; 22 existing skips.
- Focused Client budget/runner/activity tests: 68 passed. Server worker/retry/recovery/janitor tests: 84 passed.
- PostgreSQL integration: 746 passed in 58 files.
- CI fixture follow-up: 13 query-plan/selector tests passed with background auto-analyze disabled.
- Agent Runtime coverage: 642 passed, with 100% statements, branches, functions, and lines.

## Limits

This change does not diagnose an existing user-owned Pi process, modify an already running
Client timer, change report ownership, or decide when to abandon accepted work. Offline Computer
retry policy remains separate. Production acceptance requires an explicit deployment and fresh
business evidence; local tests are not a production verification.
