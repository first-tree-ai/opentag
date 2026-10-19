# IM Turn budget and recovery acceptance

Date: 2026-10-19. Base: `9527fc6f934845882c000142649be735e8116d95`.
All inputs are synthetic; no model, external message, production operation, or user Computer is used.

## Regression cases

- A seven-day message deadline with no explicit budget still times out at the existing 30-minute
  default. Explicit shorter and longer budgets, shorter deadlines, absent deadlines, and expired
  requests retain their stated semantics without mutating the frozen request.
- A controlled runtime exits on abort; the actual Turn Runner creates and submits one timeout
  report. An expired request does not start the Provider. Slack activity expires on the same
  budget rule rather than following message retention.
- Every accepted reconcile status preserves custody and records its actual deferred state.
  Repeated responses follow 2/4/8/16/30/30-second delays and do not dispatch business execution.
- A report arriving during reconciliation wins over a retry write. A newer attempt also prevents
  an older response from rewriting its diagnostic or next-attempt time.

Focused commands:

```sh
pnpm --filter @opentag/client exec vitest run src/__tests__/turn-timeout.test.ts src/__tests__/agent-turn-runner.test.ts src/__tests__/turn-activity-reporter.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/im-delivery-worker.test.ts src/__tests__/im-delivery-retry.test.ts
```

## Validation

- `pnpm check`, `pnpm build`, and `pnpm typecheck` passed.
- `pnpm test` passed: 690 script tests and 9,981 workspace tests; 22 existing skips.
- Focused Client budget/runner/activity tests: 68 passed. Focused Server worker/retry tests: 52 passed.
- PostgreSQL integration: 740 passed in 58 files.
- Agent Runtime coverage: 642 passed, with 100% statements, branches, functions, and lines.

## Limits

This change does not diagnose an existing user-owned Pi process, modify an already running
Client timer, change report ownership, or decide when to abandon accepted work. Offline Computer
retry policy remains separate. Production acceptance requires an explicit deployment and fresh
business evidence; local tests are not a production verification.
