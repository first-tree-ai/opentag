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

## Local authority separation (2026-10-29)

Context execution v2 separates OpenTag local authority from managed GitHub access without
changing database storage or the pinned Context Tree CLI. Version 1 behavior is retained.
Independent review found and resolved three issues: provider-free executions needed ongoing
authority checks, rejected remote opens needed to reach the existing offline fallback, and
command classification needed parsed flags rather than arbitrary argument values.

The real pinned CLI regression runs both Local and Cloud preparation through the command
gateway. After a successful download and write preparation, remote authorization is denied.
Both paths recover a stale snapshot, commit locally (including a message equal to `--publish`),
and retain committed work when abort is refused. Restoring managed transport publishes the
same commit; aborting a separate empty session clears its routing hint. Local environments
exclude ambient GitHub/SSH credentials and proxies and reject Git file transport. These tests
use a local Git fixture; they do not exercise live GitHub OAuth or a deployed Cloud Runner.

Server tests cover parent/child v1/v2 admission, provider acquisition denial for local children,
ownership/selection/source/revision fences, real Runner WebSocket v2 negotiation, and the
existing timer cancelling provider-free children after authority loss. Slow queries cannot
overlap or revive an execution after parent closure. GitHub admission is not read for valid
local work. Shared schemas reject mixed local/remote scopes and unsupported protocol versions.

Validation passed on Node 24.20.0 with pnpm 10.12.1:

- Shared suite: 49 files, 781 tests.
- Affected Client suites: 9 files, 256 tests; the final real-CLI gateway suite has 13 tests.
- Affected Server suites: owner, broker, Context scope, local channel, Web execution,
  Cloud delivery, Runner WebSocket, Cloud runtime composition and Runner hub.
- Web component suites: 2 files, 39 tests.
- Agent Runtime coverage: 31 files, 773 tests; 100% statements, branches, functions and lines.
- Workspace build and typecheck; affected Server/Client builds after final production edits;
  `pnpm check` and whitespace checks.
- Three browser smoke tests, with zero retries: English disconnect confirmation and mutation,
  active account widths 320/390/768/1440, and Chinese help/confirmation at narrow widths.
  [Screenshots and browser boundary](../web-ui/context-local-authority/README.md).

The browser used the built Web/Server and a disposable PostgreSQL database, with fixture
GitHub responses. Docker's published host port stalled locally; a temporary loopback wire
bridge to that test container enabled the successful run without repository infrastructure
changes. Earlier infrastructure failures never reached page tests. The bridge and container
were stopped after verification. No live GitHub grant, Account binding or Agent was changed.

There is no schema/query or migration change, so the full PostgreSQL integration suite was
not rerun. Local validation does not establish CI, staging rollout or live acceptance. Deploy
the compatible Server before v2 Runner images; retain a compatible Server during rollback
until v2 peers are drained or reverted.
