# Managed CLI installation acceptance

Supports [Internal Session collaboration](../../docs/system/messaging/internal-session-collaboration.md) and the
[Portable release guide](../../docs/operations/portable-release.md).

## Scope

Local validation for issue #1014 on 2026-10-26, based on main `77daad297d91502af11e4310898934b455474488`.
The implementation changes only CLI installation selection and the invocation supplied to managed instructions.
Server code, database semantics, credentials, and authorization policy are unchanged.

## Regression evidence

Before implementation, seven new invocation tests and one managed Runtime injection test failed against the base code.
They selected the stale PATH executable, accepted missing intended entries, or supplied a bare command to the Runtime.
The final invocation suite also covers mismatched inherited Portable metadata and both supported Portable root forms.

- npm keeps the running Node and CLI entry despite an older same-name command first on PATH.
- Missing entries, non-file entries, missing Node, incomplete Portable metadata, unusable launchers, foreign channels,
  and unrelated Portable installations fail as local configuration errors.
- Portable invocation retains the stable launcher across an atomic `current` switch and service refresh.
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
node testing/managed-cli-entry/acceptance.mjs
pnpm check
git diff --check
```

The native acceptance harness uses the built CLI, synthetic proof/context, a private temporary Home, an older dummy CLI
first on PATH, and a loopback HTTP endpoint. It submits three Session messages: two with different current execution
markers, then one after the marker file is removed. Both current markers reach the request; the missing marker never
revives the stale inherited execution ID. The harness removes its temporary files and closes its endpoint.

## Recorded result

Local host: macOS arm64, Node.js 24.20.0. All checks below passed on the final source.

| Check | Result |
| --- | --- |
| CLI package regression | 62 files, 779 tests passed |
| Session/proof/GitHub admission regression | 4 files, 11 tests passed; includes embedded PostgreSQL |
| CLI build | Passed |
| CLI and Server type checks | Passed |
| Native built CLI acceptance | 3 submissions, 2 current markers; missing marker did not reuse inherited ID |
| Portable invocation | Atomic version switch, same stable launcher, refreshed-version resolution passed |
| Repository checks | `pnpm check` passed, including migration drift, complexity ratchet, and Context Tree |
| Patch whitespace | `git diff --check` passed |

The complete Server/PostgreSQL matrix and Agent Runtime coverage were not rerun: Server implementation and covered
Client runtime files are unchanged. The added Server seam is covered by the focused embedded-database regression.
Remote CI, actual Linux service operation, release publication, and deployment were not performed.

## Acceptance boundary

Local source, regression, build, and native CLI checks are covered. No installed daemon is changed or restarted, no
external provider is invoked, and no real GitHub account operation is performed. A deployed Agent's actual next-round
GitHub read remains a separate live acceptance step; a synthetic accepted receipt does not establish that result.
