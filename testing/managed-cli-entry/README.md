# Managed CLI installation acceptance

Supports [Internal Session collaboration](../../docs/system/messaging/internal-session-collaboration.md) and the
[Portable release guide](../../docs/operations/portable-release.md).

## Scope

Local validation for issue #1014 on 2026-10-26, based on main `77daad297d91502af11e4310898934b455474488`.
The implementation changes CLI installation selection and carries the same invocation into managed instructions and
native Provider command permissions. Server code, database semantics, credentials, and Server authorization policy are
unchanged.

## Regression evidence

Before implementation, seven new invocation tests and one managed Runtime injection test failed against the base code.
They selected the stale PATH executable, accepted missing intended entries, or supplied a bare command to the Runtime.
The final invocation suite also covers mismatched inherited Portable metadata and both supported Portable root forms.

- npm keeps the running Node identity and CLI entry despite an older same-name command first on PATH. Homebrew's
  versioned Node keg is replaced by a stable alias only after checking that both resolve to the same executable.
- Missing entries, non-file entries, missing Node, incomplete Portable metadata, unusable launchers, foreign channels,
  and unrelated Portable installations fail as local configuration errors.
- Portable invocation retains the stable launcher across an atomic `current` switch and service refresh, including
  reconciliation from the superseded process. The manual-upgrade regression calls the real service manager against
  temporary payloads with distinct Node paths, checks durable installed state, and executes the new launcher target.
- Compatible launcher template changes pass semantic root/bin-directory validation; a foreign target still fails.
- Daemon startup logs safe resolver details (path, reason, running version, available installed version) locally without
  reporting an authorization failure or sending a remote defect report.
- An uninstalled artifact cannot start managed daemon integration; its diagnostic requires installation first.
- Claude Code and Codex receive permissions generated from the exact managed invocation, including spaces and
  apostrophes. npm permissions retain the CLI entry token rather than authorizing every Node script.
- Runtime composition carries the invocation into Provider policy on both create and resume.
- A generated managed command is actually executed with spaces and apostrophes in its entry and arguments; custom
  OpenTag Home is retained.
- Service rendering uses the same invocation rule. Existing protected-work and supervisor handoff tests remain intact.

`packages/server/src/__tests__/session-cli-github-continuation.test.ts` exercises the real Session route, proof service,
Session message persistence, and GitHub admission policy against embedded PostgreSQL. Only execution liveness, the GitHub
account overview, and the dispatch receipt are fixtures. A current execution marker preserves user-task provenance for
the next round; missing/stale markers, a closed execution, and revoked authorization do not grant GitHub capability.

## Local commands

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter='open-tag^...'
pnpm exec turbo run build --filter='@opentag/server^...'
pnpm --filter open-tag build
pnpm --filter open-tag test
pnpm --filter open-tag typecheck
pnpm --filter @opentag/server test src/__tests__/session-cli-github-continuation.test.ts src/__tests__/session-cli-proof-service.test.ts src/__tests__/runtime-sessions-api.test.ts src/__tests__/github-runtime-policy.test.ts
pnpm --filter @opentag/server typecheck
pnpm --filter @opentag/client typecheck
pnpm --filter @opentag/client test
pnpm --filter @opentag/client test:agent-runtime:coverage
node --test testing/managed-cli-entry/acceptance.test.mjs
pnpm check
git diff --check
```

The native acceptance harness uses the built CLI, synthetic proof/context, a private temporary Home, an older dummy CLI
first on PATH, and a loopback HTTP endpoint. It submits three Session messages: two with different current execution
markers, then one after the marker file is removed. Both current markers reach the request; the missing marker never
revives the stale inherited execution ID. The harness removes its temporary files and closes its endpoint. It is a
`node:test` regression executed by the CLI Pack Smoke CI job, and follows the existing test-file coverage policy.
The 80% changed-line coverage gate and its production-source scope remain unchanged.

## Recorded result

Local host: macOS arm64, Node.js 24.20.0. All checks below passed on the final source.

| Check | Result |
| --- | --- |
| CLI package regression | 63 files, 786 tests passed |
| Session/proof/GitHub admission regression | 4 files, 11 tests passed; includes embedded PostgreSQL |
| CLI and Client builds | Passed |
| Client package regression | 160 files passed, 1 skipped; 2790 tests passed, 6 skipped |
| Agent Runtime coverage | 31 files, 773 tests passed; statements, branches, functions, and lines all 100% |
| CLI, Client, and Server type checks | Passed |
| Native built CLI acceptance | 3 submissions, 2 current markers; missing marker did not reuse inherited ID |
| Portable invocation | Atomic version switch, same stable launcher, refreshed-version resolution passed |
| Repository checks | `pnpm check` passed, including migration drift, complexity ratchet, and Context Tree |
| Changed-line coverage | 111/112 executable changed lines covered (99.11%); existing threshold 80% |
| Patch whitespace | `git diff --check` passed |

The focused Server seam is unchanged from the initial implementation and was not repeated. The complete
Server/PostgreSQL matrix remains CI-owned. Agent Runtime coverage includes the Client permission plumbing and
composition/create/resume regressions. Actual Linux service operation, external providers, release publication, and
deployment were not performed.

## Acceptance boundary

Local source, regression, build, and native CLI checks are covered. No installed daemon is changed or restarted, no
external provider is invoked, and no real GitHub account operation is performed. A deployed Agent's actual next-round
GitHub read remains a separate live acceptance step; a synthetic accepted receipt does not establish that result.
