# Provider process shutdown

Date: 2026-10-20. Base: `91dc3c52530a660fb8e8874b8d11a46281733249`.
Contract: [Agent Runtime](../../docs/system/runtime/agent-runtime-contract.md).

## Scope

The Client watchdog retains ownership through bounded process-group shutdown. Provider exit,
interrupt, and broken forwarding pipes all preserve the existing 500 ms force-kill escalation.

All processes are synthetic. Tests use the local Node executable with no model, external Provider,
or user Computer. Every synthetic process group is force-cleaned in teardown, including on failure.

## Regressions

- Real POSIX Provider and tool processes ignore SIGINT and SIGTERM. The watchdog must stay alive
  until its existing 500 ms SIGKILL escalation terminates the owned group.
- On stdin EOF, the Provider can exit before a tool whose stdio and IPC are closed. The escalation
  timer must remain referenced even when no child handles keep the watchdog alive.
- Closing the parent's stdout or stderr pipe while the Provider continues writing must enter
  bounded cleanup; an unhandled pipe error must not kill the watchdog before escalation.
- The real Claude Code process wire exercises interrupt, explicit close, and a normal terminal
  result. Neither the synthetic Provider nor its owned tool may keep running after shutdown.
  Bounded polling allows for OS process-exit visibility; zombies are distinguished from running
  processes when checking POSIX process state.

Before the source fix, all six initial real-process cases failed. Two additional pipe-disconnect
regressions failed before forwarding-error handlers were added. The eight cases join the existing
Agent Runtime 100% coverage gate without lowering any threshold.

## Commands

```sh
pnpm --filter @opentag/client exec vitest run src/__tests__/process-owner.test.ts src/__tests__/claude-code-process.test.ts src/__tests__/pi-rpc-wire.test.ts src/__tests__/codex-app-server.test.ts
pnpm check
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @opentag/client test:agent-runtime:coverage
pnpm --filter @opentag/server test:integration
```

## Validation

- `pnpm check`, `pnpm build`, and `pnpm typecheck`: passed.
- `pnpm test`: 691 script tests and 10,025 workspace tests passed; 22 existing skips.
  Server tests ran directly. Other packages reused matching validated Turborepo results.
- Agent Runtime coverage: 650 passed across 30 files; statements, branches, functions, and lines
  each met the existing 100% threshold.
- Full PostgreSQL integration: 850 passed across 62 files.
- The process source, fixture, and regression tests are unchanged from the earlier focused run:
  61 passed across four files, including eight native cases.

The same watchdog source and synthetic fixture also passed 30 instrumented Linux cases on Node.js
24.21.0 in an isolated, network-disabled container: six repetitions each of SIGINT, SIGTERM, stdin
EOF, stdout disconnect, and stderr disconnect. Every watchdog exited via SIGKILL, and both owned
processes stopped within bounded observation. Two cases briefly appeared running after wrapper
exit and stopped within 11 ms. Assertions poll for at most two seconds rather than assume simultaneous
OS exit visibility; the pre-fix orphan processes remain alive past that bound.

An initial Linux single-snapshot failure did not capture its exit signal or subsequent state, so
its cause remains unproven. Instrumented checks subsequently passed 50 repetitions before the final
30-case probe. The probe validator also treats `/proc` disappearance with `ESRCH` as stopped.

## Limits

Native process tests cover POSIX process groups and skip Windows. Windows continues using the
existing `taskkill` tree-termination command; native Windows behavior is not validated here.
A process that creates a separate session or process group is outside the watchdog's ownership.
Local reproduction proves an exit-boundary defect, not the original production Provider's internal
stall cause. Installed Clients must upgrade before newly spawned watchdogs use this fix; existing
running processes are not changed. No deployment or production acceptance is performed.
