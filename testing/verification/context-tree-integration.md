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
