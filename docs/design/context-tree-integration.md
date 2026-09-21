# Context Tree Integration

Status: implemented

Last updated: 2026-09-15

## Purpose

OpenTag gives Agent Sessions durable memory through `@first-tree-ai/context-tree` without
requiring the user to install or connect it per project.

Each Agent optionally selects one GitHub Context Tree in **Agent settings → Context Tree**, and
every Session for that Agent:

- resolves to the selected repository, so Agents that select the same repository share durable memory;
- can read and write it through the packaged skills and CLI;
- knows its own Agent slug, so `members/<agent-slug>/` is unambiguous.

Context Tree is optional memory. No Context Tree failure prevents a Session from starting.

## Target package shape

Context Tree is an npm package with a `bin`, six skill directories, and scaffolding templates.
It has no plugin manifest, no marketplace, and no lifecycle hooks; an earlier revision of this
document assumed those and is superseded.

Two consequences shape everything below:

- **The skills invoke `context-tree` by name.** Every skill says "run `context-tree …`", so a
  Session needs that command on its `PATH`. There is no plugin root to resolve it from.
- **The CLI locates its own assets relative to itself.** It walks up from its entry file to the
  directory holding a `package.json` named `@first-tree-ai/context-tree`, and reads its version
  there on *every* invocation. The manifest, `skills/`, and `templates/` are therefore parts of
  the package, not metadata about it.

## Shipping the pinned package

`@first-tree-ai/context-tree` is a pinned runtime `dependency` of `apps/cli` and
`packages/client`. What
OpenTag needs from it is on-disk assets rather than JavaScript exports, so nothing is bundled:
resolution is `createRequire(import.meta.url).resolve("@first-tree-ai/context-tree/package.json")`,
with no static import anywhere. tsdown therefore emits no reference to it, no source map names it,
and `THIRD_PARTY_NOTICES` is unaffected.

This depends on an upstream fix. The package's `postinstall` used to auto-install its skills
whenever `npm_config_global` was set — which npm also sets for the dependencies of a global
install, so `npm i -g open-tag` would have written six skill directories into the user's personal
`~/.claude` and `~/.codex` as an invisible side effect. `@first-tree-ai/context-tree` now also
requires that it is the install *target* rather than a nested copy, so being a dependency has no
side effects. That guard first ships in **0.1.8**. `scripts/cli-pack-smoke.mjs` holds the line empirically: for the production
identity it installs the packed CLI globally under an isolated `HOME`, asserts no `.claude` or
`.codex` appears, and then runs the nested `postinstall` with `npm_config_global=true` to prove the
dependency guard is what kept it inert rather than a script that merely failed to run.

An earlier revision of this design vendored the package into `apps/cli/vendor/context-tree` at
build time to avoid the postinstall. That worked, but it cost a copy script and a bespoke asset
resolver, and it broke the CLI's own assumption that it can find a `package.json` named after
itself by walking up from its entry file — the manifest and `templates/` had to be copied too,
for a version string the CLI reads on every invocation. Fixing the hazard upstream removed all of
it.

## Per-Agent Context Tree

### Selection is explicit, per Agent

OpenTag never creates a Context Tree implicitly. Each Agent carries a nullable
`contextTreeRepository` in its runtime configuration — database column, API contract, runtime
snapshot, and configuration hash — which defaults to `null`, meaning durable memory is off.

The **Agent settings → Context Tree** section owns the selection:

- an `OWNER/REPO` field with **Connect**, which validates an existing tree and saves it only after
  it resolves;
- **Create private repository**, which creates and publishes a new private repository;
- **Disconnect**, which removes the selection without deleting the repository or its memory.

Only GitHub repositories are selectable. The former Computer-wide `opentag context-tree connect`
command is removed; existing trees, connections, and memory are preserved. Context Tree
selection is visible in Agent settings, and preparation status is reported in Session prompts.
`opentag doctor` does not report Context Tree diagnostics.

**Upgrade requires re-selecting.** A previously configured Computer reports disabled until the
user selects a repository again for each Agent. A Session prepared with no selection runs
`context-tree disconnect` for its workspace, so a stale project record cannot silently attach the
workspace to the old tree. The old `~/.context-tree/opentag.json` target is ignored, and there is
no fallback or automatic migration.

**A disabled Context Tree is a normal state, not an error.** Sessions start, the managed prompt
says durable memory is inactive, and Agent settings shows no repository selected. Auto-creating a tree
outside the settings action is deferred.

### Settings operations

Connect, create, and disconnect run as remote settings operations rather than Computer-wide
commands. They reuse the runtime-test transport pattern: the Server sends a
`context-tree:operation` frame carrying the operation id, both expected revisions, the action, and
the repository, and the bound Computer answers with a `context-tree:operation:result` frame. An
operation needs an online Computer whose client advertises the new capability; older Computers
report `capability_missing` and the settings page asks the user to update OpenTag there.

The Server validates revisions before dispatch and again inside the Agent update transaction
before applying an asynchronous result, so a concurrent edit or a changed Computer fails as
`stale_configuration` and preserves the repository. Switching or removing an existing selection
requires the Agent to be paused: the operation reports `pause_required` unless the Agent is
suspended, and the Computer verifies its runtimes have stopped before changing the connection they
share.

`create` runs in an isolated setup project, so publication cannot disturb the Agent's current
connection. A durable local operation record makes duplicate requests idempotent and records
publication intent before publishing, so a lost response is never permission to publish again; an
uncertain creation is reported as `publication_uncertain` and never repeated automatically.
Authentication failures tell the user to run `gh auth login` on the named Computer and retry;
repository-exists, permission, and invalid-tree failures are reported separately. The tree is
verified before the selection is saved.

### Per-Agent resolution

`ContextTreeManager` (`packages/client/src/runtime/context-tree.ts`) prepares each Agent
workspace once per repository and provider, cached in memory:

```text
cwd = await workspace.cwd(agentId)
connect OWNER/REPO --project-path <cwd> --json  # clones on first use
install --host claude --project <cwd>     # -> <cwd>/.claude/skills/context-tree-*
install --host codex                      # -> $HOME/.agents/skills/context-tree-*
```

`connect` is idempotent for an identical connection, so this is the ensure operation. It also
returns the resolved tree under the same schema `resolve` does, so there is no second round-trip:
an earlier revision of this design ran `resolve` afterwards and compared the two, which only
guarded a race that a single call makes impossible.

Every workspace selecting the same repository resolves to the same checkout, which is what
makes the tree shared across the Agents that select it.

The path always comes from `AgentWorkspaceManager.cwd(agentId)`, which refuses to return a path
until the workspace layout state is schema-v3 `complete`. That ordering is load-bearing: it is
what keeps preparation from installing skills into a workspace still mid-migration.

Preparation runs in `SessionRuntimeManager` at Provider Runtime start, not in workspace
preparation. `verifyAgent` delegates to `prepareAgent` and the preflight calls it on every Turn
admission, so work placed there would run per Turn.

### Concurrency and Session-start budget

The CLI replaces its connection store atomically but without a cross-process lock, so concurrent
read-modify-write can lose unrelated records. OpenTag serializes its own invocations behind one
in-process mutex. Concurrent starts for the same workspace join one in-flight preparation.
Session start races the full pipeline, including shim preparation, against a 5-second budget: if preparation is still running, the
Session receives `PREPARING` and starts without durable memory while the serialized work continues
in the background. A completed success is cached per workspace, repository, and provider. A failure is held in a
one-minute cooldown, limiting an unreachable repository to one attempt per minute per workspace while
preserving retry after a transient fault.

The Turn's `AbortSignal` is deliberately not threaded into preparation. Once work is backgrounded,
cancelling one Turn must not cancel a clone or installation that another Session can use.

The residual risk is a user running the CLI by hand at the same moment. That self-heals: OpenTag
re-connects on every Agent Runtime start, so a dropped record is restored at the next Session. A
cross-process advisory lock upstream remains a worthwhile follow-up, not a prerequisite.

## Sharing one tree across Computers

A GitHub selection gives several Computers the same logical tree using the CLI's existing Git
paths: `connect OWNER/REPO` clones into the managed namespace, `sync` is one `git pull --ff-only`,
and `finish-write` is one `git push`. No new synchronization mechanism exists.

What this costs, stated rather than left implicit:

- Each Computer needs its own GitHub credentials. The failure surfaces as `GITHUB_AUTH`.
- **Every selection reaches the network.** A GitHub selection clones on first use and reaches the
  network on every `sync` and `finish-write`. All of it degrades to unavailable; none of it blocks
  Session start.
- Concurrent writes, whether from two Agents on one Computer or across Computers, collide as
  `WRITE_OUTDATED` on a non-fast-forward push. The write skill retries once and then stops;
  OpenTag adds no retry loop.
- Agents that select the same repository share one checkout, so one dirty checkout blocks all of
  them with `DIRTY_TREE`. The preparation result names it distinctly; it is repaired by the user, never by discarding their
  edits.
- The selection lives on the Agent, so any OpenTag channel (`dev`, `staging`, `prod`) that serves
  that Agent sees the same repository. Agents that select the same repository share the tree;
  Agents that select nothing, or a different repository, do not.

## Reaching the Session

### The CLI shim

`<OPENTAG_HOME>/context-tree/bin/context-tree` is a generated `0700` shim that execs the bundled
CLI with the same Node.js runtime OpenTag itself uses, so a Session cannot resolve a different one
from the user's shell configuration. That directory is prepended to the Provider `PATH` during
Client composition, unconditionally — it is a stable OpenTag-owned path, and a directory that does
not exist yet is inert on `PATH`.

Shim preparation is shared across workspaces and cached after success for the manager's lifetime;
restart the daemon to refresh it. Failed preparation retries after the one-minute cooldown.
Configured package and shim failures replace the durable preparation record and use the workspace
cooldown. Without a selection they remain unavailable statuses without creating a preparation record;
they are distinct from ordinary disabled state.

The shim is prepared before the repository is consulted, so a disabled Context Tree can run
the bundled command without creating or connecting a tree. Preparation failures retain the existing
unavailable statuses. Managed instructions identify command availability failures as runtime setup
problems; a global install is unnecessary.

The package's own `node_modules/.bin/context-tree` is not used for this: npm populates
`<consumer>/node_modules/.bin` but pnpm's virtual store does not, so the location is not portable
between a released install and the dev workspace, and its `#!/usr/bin/env node` shebang would
resolve whatever `node` the Session's `PATH` happens to find.

It is prepended at composition rather than through per-Session workspace environment because a
Session-level `PATH` would replace the value the factory composes, including the discovered
executable directory that lets `codex`, `claude`, and `pi` resolve at all.

Visible Sessions supply their tool directory through workspace `pathPrepend`. Every Provider factory
prepends it after composing its environment, preserving the Context Tree and executable directories.
Internal Sessions retain Context Tree without adding visible-Session tools.

Rollout requires reconnecting existing installations and restarting the daemon and affected Sessions
as described in the upgrade instructions above.

OpenTag's own invocations never rely on the shim: they exec the resolved CLI path directly, so a
broken or shadowed shim cannot change what OpenTag executes.

### Pi

The production Pi factory passes each packaged Context Tree skill directory explicitly with
`--skill <path>`. Automatic skill and context-file discovery remain disabled with `--no-skills`
and `--no-context-files`; supplying the packaged skills does not enable user extensions, hooks,
or ambient workspace instructions. When package assets are unavailable, the factory receives no
skill arguments and memory preparation reports its existing unavailable state.

Pi uses the same Context Tree CLI shim and managed Agent-slug/repository instructions. No host skill
installation into the user's Pi home is needed. Local Pi runs unrestricted, so access to the shared
Tree is governed by the CLI's workflow and the user's OS permissions; this is not per-Session OS
isolation. Cloud distribution and synchronization remain separate Cloud design work.

### Claude Code

Claude Code has no flag for adding a skill directory, and `--setting-sources ""` excludes user
and project skills. It is now spawned with `--setting-sources project`, which is what lets a
Session discover `<workspace>/.claude/skills/context-tree-*`.

That also admits, all scoped to OpenTag's own private workspace directory, that directory's
`.claude/settings.json`, hooks, agents, commands, and `CLAUDE.md`/`AGENTS.md` auto-discovery.
Project MCP servers remain excluded by `--strict-mcp-config`.

Two consequences to hold in view:

- An Agent can write its own `<workspace>/.claude/settings.json` or project hooks. An Agent could
  already run commands within its current Turn under `--permission-mode bypassPermissions`; the
  new durability delta is that it can plant a `SessionStart` or `PreToolUse` hook that persists
  across Sessions, survives managed-instruction revisions, and has no OpenTag-side review point.
  `effectiveSnapshotHash` therefore does not fully determine future Session behaviour. V1 accepts
  this because the workspace is OpenTag's own private per-Agent directory and Claude Code already
  runs there with bypassed permissions.
- Context Tree leaves workspace `AGENTS.md` unchanged. When it is a regular file and no
  `CLAUDE.md` entry exists, connection best-effort creates a `CLAUDE.md → AGENTS.md` symlink.
  OpenTag supplies memory instructions through its managed prompt. Existing instruction
  content, including legacy pointer blocks, is preserved.

### Codex

Codex reads skills from `$HOME/.agents/skills`, independently of the `plugins` and `hooks` features
OpenTag disables, so no marketplace or feature change is required. For `install --host codex`,
OpenTag passes the account `HOME` and resolved `CODEX_HOME` used by the Codex runtime.
The package detects Codex at `CODEX_HOME` and installs skills into `$HOME/.agents/skills`,
including when the Codex home has a custom location or name.
A Codex host the CLI reports as `skipped` is reported as `unavailable` with the
CLI's own reason instead of a reassuring `ready`. OpenTag writes only
`context-tree-*` directories there; the operation is idempotent and reversible.

This mutates user configuration, which an earlier revision of this document rejected in favour of
a managed `CODEX_HOME`. That option was dropped because it changes provider artifact identity,
invalidating existing bindings, and forces a visible one-time `codex login` in the managed home.
Writing one owned, reversible skill directory is the smaller intrusion.

OpenTag creates `~/.context-tree` with mode `0700` before granting read/write access to visible
and internal Sessions, including when no default is selected. The account home is canonicalized,
and a symlink at the managed directory is rejected, matching the standalone CLI. Changing
`OPENTAG_HOME` does not change the selected default; the shim and preparation diagnostics remain
under `OPENTAG_HOME`. If directory preparation fails, OpenTag logs the failure and starts the
provider without that grant, preserving workspace, Slack, and resolved external-tree grants.

The grant is the whole account directory, which is wider than the minimal tree grant it replaces.
It holds every Agent's connection record, every checkout under `trees/`, `connections.json` (which maps every
project on the account to a tree), and the standalone CLI's cleanup state. That last part includes
the launcher executable at `cleanup/launchers/<schedule-id>/context-tree-cleanup`, which the user's
own LaunchAgent or systemd user timer later runs **outside** the provider sandbox. `writableRoots`
cannot express exclusions, and the in-session `context-tree` CLI has to write trees and connection
records, so a Session that can use Context Tree can also rewrite an existing launcher. It cannot
register a *new* schedule, because the plist or unit file lives outside this directory. This is the
accepted trade: without the account directory the CLI's first in-session write fails. The grant is
unconditional — OpenTag issues it for every Session whether or not the Agent has selected a
Context Tree, because Context Tree is a built-in part of OpenTag rather than an optional add-on. No
configuration withholds it today; an explicit opt-out may be added later.

Codex runs `workspace-write`, so a shared tree outside the workspace would be read-only to it.
The resolved tree path is appended to `writableRoots`, composing with the Slack config root rather
than replacing it. `prepare-write` and `finish-write` write inside the tree's `.git`, so the tree
root is required rather than just its content. Claude Code runs unrestricted and is unaffected.

## Agent identity

The slug is `Agent.name`: 1–64 characters, `^[a-z0-9][a-z0-9-]*$`, distinct from `displayName`,
case-insensitively unique per Account among active Agents (`agents_account_name_active_unique`), and
**immutable** — the update contract accepts only `displayName`, `receiveMode`, and `runtimeConfig`.
So `members/<agent-slug>/` cannot orphan through a rename. Deleting an Agent frees the name, so
recreating it under the same name inherits that member directory; that is intended, because member
memory belongs to the role rather than to an Agent instance.

The Server renders it into the trusted platform instruction layer:

```text
You run inside OpenTag. IM output is never sent automatically.

OpenTag Agent slug: researcher-agent
```

`agentConfigHash` already hashes `instructions.platform`, so `effectiveSnapshotHash` changes for
free; the Agent revision tuple hashes the exact rendered string, so two Agents cannot share an
Agent revision. Configuration-time instruction validation budgets the longest platform layer any
Agent can render, so a write accepted there cannot later fail snapshot assembly. A stored name
that is not a usable slug fails closed rather than reaching a Session as a malformed identity.

Tightening `AgentInstructionsSchema` to reserve the worst-case slug-bearing platform line narrows
the formerly accepted 24 KiB boundary by that identity line. `AgentRuntimeConfigSchema` is also the
read path for persisted rows in `EffectiveRuntimeSnapshotAssembler`, so a row accepted at the old
boundary would fail as `INVALID_STORED_CONFIG` after deployment. This lands deliberately without a
migration because OpenTag is not generally deployed and there are no persisted rows to carry
forward. The same schema tightening after general availability would require a compatibility read
or data migration before rollout.

There is no `OPENTAG_AGENT_SLUG` environment variable. The Context Tree CLI reads no environment
at all, so the prompt is the only channel that reaches the Agent's reasoning.

The per-Session Context Tree status carries no slug either. Repeating it would mean parsing it
back out of the rendered prompt or adding a runtime snapshot field; instead the Platform section
states the identity and the Session section states the tree path.

Slug uniqueness is per Account, but a GitHub-backed tree can be shared more widely than one
Account, so two Agents owned by different Accounts could collide on one `members/<slug>/`. V1
accepts that: `members/<slug>/` is a **trust-scoped convention among Accounts that already share a
tree**, not a globally unique identifier and not private isolation. Nothing enforces it at runtime
in any case — the isolation is one advisory prompt line, for every pair of Agents alike — so the
exposure is silent identity collision rather than confidentiality. The fix, when it is needed, is a
tree-side namespace keyed by something Account-stable; that needs an Account handle, which is a
product decision rather than a detail of this design.

## Failure policy

Every failure carries a reason, is logged once, and is reported to the Session through the
managed prompt. The reason is the Context Tree CLI's own error code wherever there is one —
`DIRTY_TREE`, `GITHUB_AUTH`, `GITHUB_PERMISSION`, `INVALID_TREE`, `STALE_CONNECTION`, `CORRUPT_CONNECTION`, and so on —
plus OpenTag's own `PACKAGE_MISSING`, `SHIM_UNAVAILABLE`, `CONNECT_FAILED`, `TIMEOUT`, `CLI_FAILED`
as the fallback, and `PREPARING` when the Session-start budget expires before background work.

Passing the CLI's codes through rather than mapping them onto an OpenTag enum is deliberate.
Nothing switches on the reason — it is rendered into a prompt line — so a
translation layer could only lose information, and an earlier revision of this design did exactly
that, collapsing a dirty shared checkout into a generic failure. The cost is that an upstream
rename changes OpenTag's output text; that is worth less than naming the real fault.

The CLI reports operational failures as one JSON line on stdout, sometimes with exit code 1 and
sometimes with 0, so **the payload is authoritative and the exit code is not**. `verify` in
particular reports an unusable tree as `ok: false` with `findings` and no `error` object at all,
which is why the failure reader honours both shapes.

- Nothing in the Context Tree path throws into Session start.
- The repository comes from the Agent runtime snapshot, and a cached entry is only reused while it
  was recorded under the workspace's current repository and provider. Changing the selection
  invalidates both caches immediately, so a settings change takes effect at the next Session
  without restarting the daemon.
- A success is cached per workspace, repository, and provider. A failure is cached for a one-minute
  cooldown, after which a later Session retries; changing the selection invalidates both caches
  immediately.
- Session start waits at most five seconds. On budget expiry it reports `PREPARING`, starts without
  durable memory, and leaves the joined, serialized preparation running in the background.
- The managed prompt tells the Agent durable memory is inactive and not to repair the tree or
  create one itself.
- `opentag doctor` excludes Context Tree checks; selection and preparation status belong to
  Agent settings and Session prompts.
- Tree contents, credentials, and full command output are never logged.

## Verification

The earlier host-install delivery mechanisms were confirmed against the real CLIs:

- Claude Code under `--print --input-format stream-json --setting-sources project` discovers
  `<workspace>/.claude/skills/context-tree-*`; under `--setting-sources ""` it does not.
- Codex discovers `~/.agents/skills/context-tree-*` with `plugins` and `hooks` disabled. Its
  `skip_host_skill_discovery` feature is separate from both.

Pi production-composition tests cover explicit skill-present and skill-absent paths, inspect the
actual spawned RPC arguments, and preserve disabled automatic discovery.

Automated coverage: repository routing and snapshot round-trip; rendered platform string, revision
identity, snapshot hash, and instruction budget; per-provider argv and `PATH` composition; the
failure reader against every CLI shape, including a zero-exit `ok: false` payload; shim contents
and mode; joined background preparation, Session-start budgeting, failure cooldown, and durable
outcome records; prompt rendering for ready, unconfigured, preparing, and unavailable;
`writableRoots` composition alongside the Slack config root; and non-blocking preparation failures
in every state.

End-to-end tests run offline against the real packaged CLI and a real Git tree, with `HOME`
and `OPENTAG_HOME` redirected: two Agent workspaces selecting the same repository resolving to the same checkout
and invoking `context-tree` by name through the shim; Codex skills landing in the account
home's `.agents/skills` independently of a custom Codex configuration home; one Agent writing `members/<slug>/memory.md` through
the real isolated-worktree protocol while a second Agent in a different workspace reads it back;
and a Session still starting after the configured tree is deleted from underneath it.

## Deferred

- Auto-creating a tree outside the Agent settings action.
- Revalidating a cached `ready` entry against the tree itself, so that deleting the tree or editing
  the CLI's connection store by hand is noticed within a daemon's lifetime. Honouring OpenTag's own
  selection changes is separate and is not deferred.
- A cross-process advisory lock around the CLI's connection store.
- A cheap connectivity probe before an operation dispatches, for example `git ls-remote`.
  Background preparation bounds the Session-start delay; the prompt reports inactive memory meanwhile.
- Sanitizing Claude project inputs (`settings.json`, `settings.local.json`, `hooks/`, `agents/`,
  `commands/`, and `CLAUDE.md`) on every `prepareAgent`, so project settings contribute only
  OpenTag-written content.
- Windows support, which needs Provider lifecycle, path, lock, and isolated-home CI coverage
  first. The shim is POSIX and reports `shim_unavailable` elsewhere.
- Any Provider beyond Codex, Claude Code, and Pi.
