# Context Tree Integration

Status: implemented

Last updated: 2026-09-01

## Purpose

OpenTag gives Agent Sessions durable memory through `@first-tree-ai/context-tree` without
requiring the user to install or connect it per project.

After one setup step per Computer, every Agent Session on that Computer:

- resolves to the same Context Tree, so Agents share durable memory;
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

`@first-tree-ai/context-tree` is a pinned runtime `dependency` of `apps/cli` — its first. What
OpenTag needs from it is on-disk assets rather than JavaScript exports, so nothing is bundled:
resolution is `createRequire(import.meta.url).resolve("@first-tree-ai/context-tree/package.json")`,
with no static import anywhere. tsdown therefore emits no reference to it, no source map names it,
and `THIRD_PARTY_NOTICES` is unaffected.

This depends on an upstream fix. The package's `postinstall` used to auto-install its skills
whenever `npm_config_global` was set — which npm also sets for the dependencies of a global
install, so `npm i -g open-tag` would have written six skill directories into the user's personal
`~/.claude` and `~/.codex` as an invisible side effect. `@first-tree-ai/context-tree` now also
requires that it is the install *target* rather than a nested copy, so being a dependency has no
side effects. That guard first ships in **0.1.8**, which is the pinned version; **do not relax the
pin below it.** `scripts/cli-pack-smoke.mjs` holds the line empirically: for the production
identity it installs the packed CLI globally under an isolated `HOME`, asserts no `.claude` or
`.codex` appears, and then runs the nested `postinstall` with `npm_config_global=true` to prove the
dependency guard is what kept it inert rather than a script that merely failed to run.

An earlier revision of this design vendored the package into `apps/cli/vendor/context-tree` at
build time to avoid the postinstall. That worked, but it cost a copy script and a bespoke asset
resolver, and it broke the CLI's own assumption that it can find a `package.json` named after
itself by walking up from its entry file — the manifest and `templates/` had to be copied too,
for a version string the CLI reads on every invocation. Fixing the hazard upstream removed all of
it.

## One tree per Computer

### Setup is explicit, once

OpenTag never creates a Context Tree. A user creates or connects one with the Context Tree CLI
(`context-tree create`, or `publish` for a GitHub-backed tree) and names it to OpenTag:

```bash
opentag context-tree connect <managed-name>
opentag context-tree connect OWNER/REPO
opentag context-tree connect --tree-path /srv/trees/shared
```

There is deliberately no `inspect` subcommand. `opentag doctor` already owns diagnostics and has
the injectable-inspector seam, and two surfaces over one piece of state means every future reason
code has to be rendered twice.

The target is recorded machine-locally in `<OPENTAG_HOME>/config/context-tree.json`, mode
`0600`, credential-free. The Server is not involved. The three target kinds mirror
`context-tree connect`'s own argument shape, so OpenTag passes the target through rather than
reinterpreting it.

`connect` validates without side effects: `list` for a managed name, `verify` for an exact path.
It deliberately does not connect a throwaway project directory to test a target, because that
would leave a stale record in the CLI's connection store and write instruction files into it.

**An unconfigured Computer is a normal state, not an error.** Sessions start, the managed prompt
says durable memory is inactive, and `opentag doctor` reports the exact command. Auto-creating a
tree when none is configured is deferred.

### Per-Agent resolution

`ContextTreeManager` (`packages/client/src/runtime/context-tree.ts`) prepares each Agent
workspace once per recorded target, cached in memory:

```text
cwd = await workspace.cwd(agentId)
connect <target> --project-path <cwd>     # clones on first use when the kind is github
install --host claude --project <cwd>     # -> <cwd>/.claude/skills/context-tree-*
install --host codex                      # -> ~/.codex/skills/context-tree-*
```

`connect` is idempotent for an identical connection, so this is the ensure operation. It also
returns the resolved tree under the same schema `resolve` does, so there is no second round-trip:
an earlier revision of this design ran `resolve` afterwards and compared the two, which only
guarded a race that a single call makes impossible.

Every workspace pointing at one target resolves to the same checkout, which is what makes the
tree shared across Agents.

The path always comes from `AgentWorkspaceManager.cwd(agentId)`, which refuses to return a path
until the workspace layout state is schema-v3 `complete`. That ordering is load-bearing: it is
what keeps the connection from writing into a workspace still mid-migration, where an unproven
root `AGENTS.md` would make the transition fail closed.

Preparation runs in `SessionRuntimeManager` at Provider Runtime start, not in workspace
preparation. `verifyAgent` delegates to `prepareAgent` and the preflight calls it on every Turn
admission, so work placed there would run per Turn.

### Concurrency

The CLI replaces its connection store atomically but without a cross-process lock, so concurrent
read-modify-write can lose unrelated records. OpenTag serializes its own invocations behind one
in-process mutex. A record lost to a user hand-running the CLI concurrently self-heals, because
OpenTag re-`connect`s at every Provider Runtime start.

The residual risk is a user running the CLI by hand at the same moment. That self-heals: OpenTag
re-connects on every Agent Runtime start, so a dropped record is restored at the next Session. A
cross-process advisory lock upstream remains a worthwhile follow-up, not a prerequisite.

## Sharing one tree across Computers

A `github` target gives several Computers the same logical tree using the CLI's existing Git
paths: `connect OWNER/REPO` clones into the managed namespace, `sync` is one `git pull --ff-only`,
and `finish-write` is one `git push`. No new synchronization mechanism exists.

What this costs, stated rather than left implicit:

- Each Computer needs its own GitHub credentials. The failure surfaces as `GITHUB_AUTH`.
- **"Startup performs no network access" holds only for local trees.** A GitHub target clones on
  first use and reaches the network on every `sync` and `finish-write`. All of it degrades to
  unavailable; none of it blocks Session start.
- Concurrent writes, whether from two Agents on one Computer or across Computers, collide as
  `WRITE_OUTDATED` on a non-fast-forward push. The write skill retries once and then stops;
  OpenTag adds no retry loop.
- Agents on one Computer share one checkout, so one dirty checkout blocks all of them with
  `DIRTY_TREE`. Doctor names it distinctly; it is repaired by the user, never by discarding their
  edits.
- The target is machine-local, so it is set once per Computer. Server propagation is deferred.

## Reaching the Session

### The CLI shim

`<OPENTAG_HOME>/context-tree/bin/context-tree` is a generated `0700` shim that execs the installed
CLI with the same Node.js runtime OpenTag itself uses, so a Session cannot resolve a different one
from the user's shell configuration. That directory is prepended to the Provider `PATH` during
Client composition, unconditionally — it is a stable OpenTag-owned path, and a directory that does
not exist yet is inert on `PATH`.

The package's own `node_modules/.bin/context-tree` is not used for this: npm populates
`<consumer>/node_modules/.bin` but pnpm's virtual store does not, so the location is not portable
between a released install and the dev workspace, and its `#!/usr/bin/env node` shebang would
resolve whatever `node` the Session's `PATH` happens to find.

It is prepended at composition rather than through per-Session workspace environment because a
Session-level `PATH` would replace the value the factory composes, including the discovered
executable directory that lets `codex` and `claude` resolve at all.

OpenTag's own invocations never rely on the shim: they exec the resolved CLI path directly, so a
broken or shadowed shim cannot change what OpenTag executes.

### Claude Code

Claude Code has no flag for adding a skill directory, and `--setting-sources ""` excludes user
and project skills. It is now spawned with `--setting-sources project`, which is what lets a
Session discover `<workspace>/.claude/skills/context-tree-*`.

That also admits, all scoped to OpenTag's own private workspace directory, that directory's
`.claude/settings.json`, hooks, agents, commands, and `CLAUDE.md`/`AGENTS.md` auto-discovery.
Project MCP servers remain excluded by `--strict-mcp-config`.

Two consequences to hold in view:

- An Agent can write its own `<workspace>/.claude/settings.json`. Under
  `--permission-mode bypassPermissions` with an unrestricted filesystem this is not a privilege
  escalation, but it does mean `effectiveSnapshotHash` no longer fully determines a Session's
  instructions.
- `context-tree connect` writes a marker-delimited pointer into `<workspace>/AGENTS.md` and
  symlinks `CLAUDE.md` to it. With project settings loaded, that block becomes the Session's
  ambient notice of the tree path — OpenTag-controlled text, but a second instruction channel
  alongside the managed prompt. Suppressing it needs a `--no-pointer` flag upstream.

### Codex

Codex reads skills from `$CODEX_HOME/skills`, independently of the `plugins` and `hooks` features
OpenTag disables, so no marketplace or feature change is required. OpenTag writes only
`context-tree-*` directories into the user's real `~/.codex/skills` — the same operation the
package's own global install performs, idempotent and reversible.

This mutates user configuration, which an earlier revision of this document rejected in favour of
a managed `CODEX_HOME`. That option was dropped because it changes provider artifact identity,
invalidating existing bindings, and forces a visible one-time `codex login` in the managed home.
Writing one owned, reversible skill directory is the smaller intrusion.

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
`DIRTY_TREE`, `GITHUB_AUTH`, `INVALID_TREE`, `STALE_CONNECTION`, `CORRUPT_CONNECTION`, and so on —
plus four of OpenTag's own: `PACKAGE_MISSING`, `SHIM_UNAVAILABLE`, `CONNECT_FAILED`, `TIMEOUT`,
and `CLI_FAILED` as the fallback.

Passing the CLI's codes through rather than mapping them onto an OpenTag enum is deliberate.
Nothing switches on the reason — it is rendered into a prompt line and a doctor detail — so a
translation layer could only lose information, and an earlier revision of this design did exactly
that, collapsing a dirty shared checkout into a generic failure. The cost is that an upstream
rename changes OpenTag's output text; that is worth less than naming the real fault.

The CLI reports operational failures as one JSON line on stdout, sometimes with exit code 1 and
sometimes with 0, so **the payload is authoritative and the exit code is not**. `verify` in
particular reports an unusable tree as `ok: false` with `findings` and no `error` object at all,
which is why the failure reader honours both shapes.

- Nothing in the Context Tree path throws into Session start.
- The configuration is read before the cache is consulted, and a cached entry is only reused while
  it was recorded under the Computer's current target. `opentag context-tree connect` writes the
  file and nothing else, so this is what makes a newly configured or retargeted Computer take
  effect without restarting the daemon.
- A success is cached per workspace; a failure is not, so a transient fault retries at the next
  Session start.
- The managed prompt tells the Agent durable memory is inactive and not to repair the tree or
  create one itself.
- `opentag doctor` reports the configured target and the tree's state under a `context-tree`
  scope. Both checks are non-blocking, so neither can change the doctor exit code. There is no
  separate package check: with a real dependency, a missing package is a broken installation that
  fails far louder elsewhere.
- Tree contents, credentials, and full command output are never logged.

## Verification

Both delivery mechanisms were confirmed against the real CLIs before the surrounding work landed:

- Claude Code under `--print --input-format stream-json --setting-sources project` discovers
  `<workspace>/.claude/skills/context-tree-*`; under `--setting-sources ""` it does not. The same
  contrast holds for the workspace `AGENTS.md` pointer, which is inert without project settings
  and ambient with them.
- Codex discovers `~/.codex/skills/context-tree-*` with `plugins` and `hooks` disabled. Its
  `skip_host_skill_discovery` feature is separate from both.

Automated coverage: target routing and config round-trip; rendered platform string, revision
identity, snapshot hash, and instruction budget; per-provider argv and `PATH` composition; the
failure reader against every CLI shape, including a zero-exit `ok: false` payload; shim contents
and mode; serialized concurrent preparation; prompt rendering for ready, unconfigured, and
unavailable; `writableRoots` composition alongside the Slack config root; and doctor's
non-blocking behaviour in every state.

Three end-to-end tests run offline against the real packaged CLI and a real Git tree, with `HOME`
and `OPENTAG_HOME` redirected: two Agent workspaces on one Computer resolving to the same
checkout and invoking `context-tree` by name through the shim; one Agent writing
`members/<slug>/memory.md` through the real isolated-worktree protocol while a second Agent in a
different workspace reads it back; and a Session still starting after the configured tree is
deleted from underneath it.

Beyond the repository gates, the packaged CLI was installed from its own tarball into a throwaway
consumer and driven through `connect`, `doctor` on a configured Computer, an unconfigured
Computer, a deleted tree, and a usage error — confirming that ordinary Node.js resolution finds
the dependency from the published bundle.

## Deferred

- Auto-creating a tree when none is configured.
- A typed reason for a corrupt or unreadable configuration. A Session is told `unconfigured` today,
  although doctor does distinguish it as invalid. This is worth doing now that a repaired
  configuration is actually observed rather than masked by a stale cache.
- Revalidating a cached `ready` entry against the tree itself, so that deleting the tree or editing
  the CLI's connection store by hand is noticed within a daemon's lifetime. Honouring OpenTag's own
  configuration changes is separate and is not deferred.
- A cross-process advisory lock around the CLI's connection store.
- Server-propagated target, so a Computer inherits it when it connects.
- Suppressing the workspace `AGENTS.md` pointer with an upstream `--no-pointer` flag.
- Project-scoped trees, so several Agents share a tree without sharing all Computer memory.
- Windows support, which needs Provider lifecycle, path, lock, and isolated-home CI coverage
  first. The shim is POSIX and reports `shim_unavailable` elsewhere.
- Any Provider beyond Codex and Claude Code.
