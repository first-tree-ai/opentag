# Context Tree Integration

[简体中文](../zh-CN/design/context-tree-integration.md)

Status: implemented. Updated: 2026-09-22.

## Named connections

Each Agent stores `contextTrees: { alias: string; repository: string }[]` in its runtime
configuration. The empty list disables memory. One JSONB column owns the list; there is no
connection table or separate connection ID. APIs and effective runtime snapshots use the same
shared Zod schema. Aliases follow the upstream CLI's safe single-segment rule (1–100 characters,
starting with a letter or digit, no `.git` suffix). Aliases are case-sensitive; repository identity
is case-insensitive. Duplicate aliases or repositories are rejected. Each Agent may connect at most
32 trees to bound preparation work and runtime prompt size.

Configuration hashes sort connections by alias and normalize repository identity. Array order
conveys no priority. Agents may share repositories within that limit, and a repository's published
knowledge is shared with other Agents that connect it.

**The Agent's Context Tree page**, reached from the Agent navigation, shows alias/repository rows
with individual Disconnect buttons.
Connect/create requires an alias and `OWNER/REPO`. An identical attachment is idempotent. An
occupied alias cannot silently change repositories; rename or replacement uses disconnect followed
by connect. Local Computers support creating and publishing a private repository; Cloud Computers
connect existing authorized repositories only. OpenTag never creates memory implicitly.

## Settings operations and concurrency

The existing settings operation carries the alias, operation ID, expected Agent revision and
expected runtime configuration revision. The Server checks revisions before dispatch and under
its Agent/runtime row locks after verification. A stale response cannot overwrite concurrent changes.
Changing any nonempty configuration requires suspension, including adding another connection.
An identical attachment or already absent disconnect is a no-op. Disconnect needs no online Computer
and deletes only that alias from configuration.

Local settings run through the bound Computer. CLI mutations share the runtime preparation queue.
Create/connect/publish use an isolated project and a consistent explicit `settings` alias. Cleanup
uses `disconnect --all`, leaving checkouts intact. Operation fingerprints include the requested alias;
publication deduplication remains keyed by normalized repository identity. Durable publication intent
prevents a lost response from causing a second publication. Uncertain publication requires resolution
rather than an automatic retry.

Cloud settings verify the requested repository's exact current `context_tree` binding, admission,
branch, and live Tree head. They recheck the same binding and authorization/credential versions
before committing. Multiple Context Tree grants are allowed; each Agent/repository/role grant is
still unique, including across connections. Existing branch and publication policy remains authoritative.

## Local preparation

`ContextTreeManager` prepares each Agent workspace using the complete connection set and provider.
It discovers current attachments through the CLI, disconnects obsolete aliases, and runs:

```text
connect OWNER/REPO --as ALIAS --project-path WORKSPACE --json
```

Reconciliation changes linkage only. It never deletes checkouts or unpublished work. Unsupported
connection stores are reported and preserved; they are not silently rewritten or deleted.

CLI mutations are serialized because the upstream store has no cross-process lock. Concurrent
Session starts join the same preparation. The five-second startup budget includes queued work and
setup. Expiry returns completed results plus `PREPARING` for unfinished aliases; work continues in
the background. Healthy results stay cached while failed aliases observe the one-minute retry
cooldown. Changing the provider or complete connection set invalidates the cache. Managed executions
recheck current repository grants before using cached results.

Provider skills install once per preparation, not per tree. Claude Code discovers workspace skills
under `--setting-sources project`; Codex uses the account HOME's `.agents/skills`, independently of
custom `CODEX_HOME`; Pi receives explicit packaged `--skill` paths. Codex gets every ready tree path
as a writable root. A generated shim pins the packaged CLI and OpenTag's Node runtime.

Claude's project settings and instructions remain within the existing trusted Agent workspace
boundary. Local Pi and Claude are not isolated from other host files by this feature. Member paths
`members/<agent-slug>/` are a shared-memory convention, not an OS confidentiality boundary.

## Cloud preparation

Each Session stores checkouts and upstream version-2 connection records under
`.opentag/context-tree/home`, with prepared write worktrees under `.opentag/context-tree/tmp`.
Both survive workspace save/restore. Credentials come only from the current execution environment.
Restoring a workspace never restores authorization or selects an old configuration.

Every Turn reconciles attachments against the current configured and authorized set before exposing
the agent-facing CLI. Removed and revoked aliases are detached through local CLI operations, so an
unqualified `sync` cannot reach them. Unauthorized repositories receive no network preparation.
Checkouts and drafts remain on disk.

Preparation connects and synchronizes each alias using the version-2 CLI responses, including
per-entry errors emitted with a nonzero exit. Results carry alias, repository, status, resolved path,
and available branch/SHA. One failed tree does not hide healthy results. A thirty-second total
budget bounds the operation; completed results survive expiry and unfinished entries report timeout.
Shared setup failures apply to all affected entries.

A failed connect can recover a preserved checkout only when workspace, alias, and repository all
match the current version-2 store, and the real path stays within the Session workspace. Failed
connect/sync copies are explicitly `stale`. Nothing resets dirty checkouts, deletes incomplete clones,
or discards prepared writes. Current grants still govern subsequent remote access and publication.

## Prompts and writes

Local and Cloud prompts report each alias independently without a primary tree or implied precedence.
The upstream skills select relevant trees, attribute disagreements, and require an explicit destination
for writes. Healthy trees remain usable when another is unavailable. Unconfigured memory is normal;
optional memory never prevents the base task from starting. Tree contents and credentials are not logged.

## Packaging and rollout

`apps/cli`, `packages/client`, and `packages/server` pin `@first-tree-ai/context-tree` exactly to
`0.1.16`. Package assets are resolved on disk; the CLI, package manifest, skills, and templates travel
together in portable builds and Cloud runner images. No upstream source is vendored or used as a
Git dependency.

Deploy Server, Clients, and Cloud runner images together. Migration `0049_multiple_context_trees`
drops the former nullable repository column and adds an empty-list JSONB column without translating
old selections. Existing Agents require fresh selection. Old snapshots, operation records, and CLI
stores are not migrated. Unsupported stores must be handled explicitly while preserving unpublished work.

`0.1.16` is published on npm. Install the pinned registry package with `pnpm install --frozen-lockfile`
and run package smoke checks against that published package.

## Verification

Tests cover schema rejection, empty defaults, snapshot round-trips, order-independent hashes,
collisions, targeted disconnect, revision/suspension races, and publication deduplication. Runtime
coverage includes reconciliation, partial success, startup budgets, retry cooldowns, multiple writable
roots, exact Cloud grants, revoked access, version-2 partial sync, and preserved drafts.

Offline real-CLI scenarios connect multiple trees, write to an explicit alias, disconnect it, and
read/synchronize the remaining tree. Cloud tests exercise actual workspace archives and prepared
writes. Required repository checks include install, check, build, typecheck, unit tests, agent-runtime
coverage, PostgreSQL integration, and package smoke verification.
