# Context Tree integration: verification and acceptance

Tests for [Context Tree integration](../../docs/system/capabilities/context-tree-integration.md)
cover source identity, targeted disconnect, revision/suspension fences, authorized subtree
verification, and interrupted repository creation.

Runtime tests check configuration ownership, one refresh per source, partial results,
startup deadlines, authorization revocation, and offline recovery with a separate budget.
Real CLI tests use local Git remotes without public network access. They exercise isolated
writes, subtree publication, shared Agent workspaces, and Cloud archive save/restore.

The timeout regression requires an interrupted refresh to retain its selection and allow
a subsequent attempt. Context Tree's package tests check recovery of an interrupted owner's
lock without cloning the downloaded repository again. Dirty snapshots and unpublished write
sessions must never be discarded as part of recovery.

Run install, check, build, typecheck, unit tests, agent-runtime coverage, PostgreSQL integration,
and portable package smoke checks before release. Publish Context Tree 1.0.0, refresh the
registry lockfile to record the published tarball integrity, and verify a frozen installation.
Local validation uses the packed release candidate until it is published.

Local Provider launch tests cover visible and internal Sessions for Codex, Claude Code, and
Pi. They assert the spawned process PATH after Provider discovery and workspace environment
overrides. Session manager tests also execute a shell against competing managed and ambient
CLIs. The affected runtime suites pass 208 tests; client typecheck, client/CLI builds, and
`pnpm check` pass.

A manual check through the installed Pi Bash tool selected the global `0.1.16` with the old
PATH and bundled `1.0.0` with the corrected launch PATH. The local development daemon was
restarted after its active Turn completed and reported a consistent runtime owner and a
ready computer connection.

Repository creation is exercised through the settings operation service, the real GitHub API
client with an injected offline transport, and the pinned CLI's real initializer. Tests cover
personal and organization repositories, private visibility, default-branch persistence,
Account authorization rechecks, permission denial, rejected creation without overwriting an
existing repository, uncertain responses without write retries, and idempotent selection.
The GitHub and Context Tree server suites pass 519 tests (16 existing skips); server build,
typecheck, and `pnpm check` pass. The local GitHub App was checked read-only and has
administration and contents write permissions. No test repository was created on GitHub.

Transport rewrite regression: the Local Context Tree integration fixture applies Git
`url.*.insteadOf` to every command, including origin queries. It fails with the previous
local bundle and passes with stored-origin checks in the package. The package's tests cover
an HTTPS-to-HTTP transport rewrite through sync and publication, and reject a changed stored
origin while preserving unpublished work. All 99 package tests, typecheck, lint and packed
package checks pass; all 12 affected Local/Cloud integration tests pass. The local bundled
CLI is refreshed from the checked package build; no remote tree is changed by these tests.

The selection reset migration clears saved tree selections and advances affected Agent and
runtime configuration revisions. Users reconnect with repository, directory, and branch;
repository contents, cached checkouts, and unpublished work remain in place.

## Agent GitHub MCP credential source (2026-10-30)

Context Tree consumes the current Agent's official GitHub MCP OAuth credential through its
existing restricted Git transport. There is no schema, token copy, separate refresh worker or
runtime protocol upgrade. Account GitHub routes and callbacks return 410, and Account has no
independent GitHub section. Historical credential rows remain inert.

Independent review resolved final-commit exclusion, repository-scope classification, authority
changes during identity lookup, disable/re-enable ABA, capability renewal switching identity,
and disabled/unsupported authorization being reported as retryable infrastructure failure.
The Context child now pins authority on its live Server-only registry record; refresh generation
alone can rotate without changing authority. Reacquisition and renewal cannot replace the pin.

Validation on Node 24.20.0 and pnpm 10.12.1:

- Shared: 48 files / 779 tests. Affected Server suites: 13 files / 436 tests; final review
  regressions in broker, owner, policy and startup: 4 files / 78 tests (overlapping batches).
- Actual MCP root/cipher tests verify same-token consumption, no credential copies or extra
  token exchange, shared references, rotation, client/resource/ownership, readonly policy,
  earliest-mount selection without fallback, enable ABA and final-write rejection.
- Real PostgreSQL: 2 files / 22 tests. Independent connections prove both race orderings:
  a prior raw invalidation makes selection fail; a selection holding authentication row locks
  commits before a waiting invalidation, which then takes effect. Existing shared refresh and
  holder-handoff tests also pass.
- Client Local/Cloud Context suites: 5 files / 40 tests using the real pinned CLI and local Git.
  The Server settings verification suite passes 27 tests, including Local/Cloud operations
  that resolve the actual shared MCP root and rotate credentials between trusted Git calls.
- Web: 3 files / 35 tests. Browser: 3 smoke cases with zero retries against built Web/Server,
  isolated PostgreSQL and an authenticated test session. Memory remains visible without a
  GitHub connection; Account makes no legacy GitHub query. English/Chinese widths
  320/390/768/1440 and accessibility checks pass. [UI evidence](../web-ui/context-mcp-authorization/README.md).
- Workspace build/typecheck/check and final affected Server build pass.

API/OAuth responses are offline fixtures. These checks do not establish deployed Cloud or live
GitHub acceptance. No real token, Agent message, repository, Issue or PR business fixture was
created. The full PostgreSQL and cross-package regression matrix remains CI-owned. Client Agent
Runtime coverage implementation/configuration is unchanged, so that separate gate was not rerun.

The subsequent independent review also found that repository admission could query a replacement
identity before comparing the operation's authorization version. Repository lookups now require the
initial version and compare it before API I/O. Actual shared-root regressions prove zero calls with
the replacement token during initial admission and recheck; ordinary refresh remains usable.
The failing CI fixtures were updated to the Agent credential port (including `agentId`), locale keys
were sorted, and a baseline receipt test now injects failure after its first durable write completes.
The affected Server batch passes 204 tests (16 native-tool cases skipped without the pinned binaries),
PostgreSQL passes 48, reply capture passes 24 and the locale catalog passes 3. The affected Server build,
workspace typecheck and repository check pass. Complete CI results remain separate from these local checks.

Deployment review removed the unused Account OAuth parser and setup examples. Old environment
variables are ignored with a names-only warning; only the MCP client settings enable GitHub access.
Config, startup and Session CLI continuation regressions pass 78 tests. The actual MCP/CLI suite
passes 27 tests under v8 instrumentation; its two database-plus-CLI cases use a 30-second test budget
without changing any product deadline or assertion.

The merge of main `8528f7ab` retains the current Memory layout and its read/operation recovery
behavior. Authorization-specific messages and the existing recovery link target the current Agent's
Connectors rather than the retired Account integration. The merged Web build and all 12 typecheck
tasks pass; four affected Web suites pass 52 tests and the three existing Chromium smoke cases pass
with zero retries. The no-GitHub Memory screenshot is refreshed to the merged layout.
