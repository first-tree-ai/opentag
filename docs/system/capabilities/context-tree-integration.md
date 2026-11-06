---
title: "Context Tree integration"
description: "How Agents use repository directories for durable memory on Local and Cloud Computers."
---

# Context Tree integration

Context Tree stores durable knowledge in Markdown. OpenTag supplies Agent settings,
GitHub authorization, and runtime preparation. The packaged Context Tree CLI owns
content validation, read snapshots, and isolated write sessions.

Memory is optional. An unavailable tree is reported to the Agent without stopping its task. Its navigation entry stays visible without GitHub authorization; users resolve authorization in the current Agent’s Connectors. Account settings has no independent GitHub authorization.

## Connections

Each Agent stores up to 32 Git sources in `contextTrees`:

```json
[
  { "kind": "git", "repository": "acme/project", "path": "docs", "ref": "main" }
]
```

Repository, directory, and branch together identify a tree. Repository names are
case-insensitive; directory and branch names are case-sensitive. Names shown in
settings come from the directory or repository. Multiple directories or branches
in one repository are allowed. Array order gives no tree precedence.

Memory uses the same page header and collection layout as other Agent resources, without a primary
header action or capacity counter. The centered empty state offers a short sentence with blue inline
**Connect an existing tree** and **create a new one** actions for both Local and Cloud Agents.
Each complete action phrase stays together when wrapping. Private repository creation is explained
in the creation dialog. Connected Context Trees appear as divided rows in one
surface, with repository/directory, branch, and a direct GitHub-folder link. A trailing secondary
**Connect another Context Tree** action keeps additional connections available inside the collection.
The trailing action is absent at the connection limit rather than presenting an unexplained disabled control.
These are saved selections, not runtime-ready indicators. Each choice opens a focused dialog. Before showing repository fields, the dialog checks
the current Agent’s GitHub MCP authorization and Computer compatibility through an authenticated,
uncached Server read. Missing deployment configuration directs the user to the server administrator;
missing, disabled or unsupported Agent authorization links to that Agent’s Connectors. Read-only
authorization permits connecting but blocks repository creation. Retry rechecks readiness after setup,
and Cancel remains available while checking. An unavailable or older Server does not expose a form
whose prerequisites could not be checked. The collection does not show an inline form. Disconnect lives in the Context Tree action menu and confirms
the exact Context Tree and preservation impact.
Cancel receives initial focus, pending requests block dismissal and repeated submissions, and failures
stay inside the confirmation. A confirmed removal returns focus to a surviving neighbour or the empty-state
connection shortcut. Successful first connections return focus to the collection's trailing connection action
and leave visible, concise feedback.

Connect accepts a GitHub repository link or a folder link copied from GitHub
(`…/tree/<branch>/<folder>`), plus an optional relative directory that overrides the link's folder; with neither,
the tree is the repository root. A folder link connects the branch it names, and the dialog says so, because silently
using another branch would connect content the reader did not point at. A repository link uses GitHub's default
branch, resolved during verification and saved with the connection. The branch is read as the link's first segment
after `tree/`, so a branch whose name contains `/` is connected from the repository link with the folder typed in.
Both Local and Cloud can connect existing trees. Create accepts an owner and repository name and uses GitHub's
default branch. Neither dialog asks for a branch.
Both Local and Cloud Computers can create private repositories: OpenTag creates the repository,
generates the initial page with the pinned `context-tree init`, and commits it through
GitHub's contents API. Connection verification and creation run exclusively on the Server with the current Agent's GitHub MCP OAuth
credential; it does not require Computer-side GitHub credentials. The OAuth authorization must allow private repositories, and the connected user
and organization policy must permit creation and content writes. Permission failures
ask the user to check access; only missing or invalid authorization asks them to reconnect.

Initial settings read failures retain the page identity and offer explicit retry for transient failures.
A transient refresh failure retains the existing collection and form draft, marks the data unconfirmed,
and disables writes until a successful read. Connector and restriction-recovery links open a new tab so
an in-progress form stays available in the original tab. Terminal authorization/resource failures hide stale settings.
Invalid directories associate their error with the field. The offline restriction notice links to the
existing Computer settings.

Readiness checks are advisory: submissions still recheck current revisions, Computer capability and
GitHub authority. They do not call GitHub, refresh credentials or start authorization. Disconnect never
requires readiness or GitHub authorization.

Failed settings operations display an error banner and the current Agent's Connector or repository destination. When the server has no GitHub MCP OAuth client
configured, the message asks the server administrator to configure it; this does not
mean the bound Computer needs an update.

Operations carry expected Agent/runtime revisions. Connecting and disconnecting do not require
pausing the Agent. A saved change advances the Agent revision, so it applies to the next turn
like any other Agent settings change; a turn already running keeps the prompt and workspace it
started with, while its later Context Tree commands fail closed against the stale revision and
never reach a tree outside the current selection. Disconnect only changes the selection;
it preserves cached content and unpublished work. Connecting an already selected source
and disconnecting an absent source are idempotent.
Repository creation never adopts or overwrites an existing repository. Remote writes are
not retried automatically. Rejected repository names prompt the user to choose another name or
connect an existing tree. An uncertain creation asks the user to inspect GitHub: connect a valid
tree, initialize and push the files if the repository is empty, or delete the empty repository
before retrying creation. Every unresolved creation is retained by case-insensitive repository identity.
While an outcome remains uncertain, creation of that repository is disabled, including after trying another
repository or closing and reopening the dialog. A successful connection clears only the matching unresolved
repository. Open repository and Connect existing are explicit recovery actions; the latter prefills the matching
repository without issuing a request and moves focus to its input. Recovery guidance is secondary to those actions.
An uncertain create response is recorded even if a background config refresh changes the revision while the request
is pending; other stale response state is still discarded.
Retrying an already connected tree is idempotent.

Remote verification checks its existing cancellation signal after the final SQL authority read,
before returning a completed result that admits selection persistence. Cancellation or close during
that read cannot start a later selection write. Once repository creation may have succeeded, the
same cancellation retains the publication-uncertain result and never retries the remote write.

## Preparation

OpenTag writes authorized selections to its own configuration at
`WORKSPACE/.opentag/context-tree/project/.context-tree.json`. Repository-owned
`.context-tree.json` files are left alone. Those files can describe local directory trees
used through the normal repository workflow.

Preparation is local. OpenTag does not run `context-tree sync` when it prepares or starts an
Agent, in the foreground or background, on Local or Cloud. Preparation writes the project
configuration, the `context-tree` shim, and the packaged Skills, and supplies the managed GitHub
transport. Missing managed authorization, a missing package, an unwritable shim, or a failed Skill
installation reports each selected source as unavailable; Local retries an unwritable shim after a
one-minute cooldown. On Cloud, a Runner without the package opens the execution without the command
gateway, and the Turn still runs; a source is advertised as available only when the gateway is
present and the packaged Skills were assembled, otherwise it is reported unavailable. Because the result depends only on the selection and this local state, it is
the same for every preparation of an unchanged selection.

Managed synchronization and write commands route through a per-execution Context Tree command gateway in the trusted Local Daemon or Cloud Runner. Only its pinned CLI child receives a GitHub handle; the Agent receives a Unix socket or fixed Cloud loopback endpoint. The Server separately admits each command against the live parent, current Agent GitHub MCP authorization and exact selected tree. See [GitHub platform integration](github-platform-integration.md#context-tree-command-boundary).

A gateway `sync` without `--tree` runs one CLI child per selected source concurrently, each with
its own child execution and handle. Proxied GitHub traffic reaches the child execution whose
handle the request carries. The combined output keeps source order; when any source fails, the
first failing source in that order is returned, and a thrown failure stops the other children.

Gateway close returns one memoized cleanup Promise to parent-abort and owner callers,
including failures. It joins the active command and attempts directory cleanup even
if closing the listener fails. Local CLI stdout uses Node's UTF-8 stream decoder,
counts incoming bytes before retaining each chunk, and stops collection permanently
on overflow. The existing process-group TERM/KILL cleanup still joins owned descendants.

Configuration, repository caches, snapshots, and write sessions live below
`.opentag/context-tree` and survive Cloud workspace save/restore. Credentials come from the
current execution and are never stored there. Providers receive the bounded Context Tree state
directory needed to create write sessions.

## Read freshness and prompt placement

The cross-host sync contract and the CLI's cache and fetch behavior are recorded in the team
Context Tree; OpenTag follows the same contract as Claude Code and Codex.

- The managed system prompt names each connected tree (name, repository/directory, branch, and
  selector), the project path, and the rule to read Context through the `context-tree-read` skill:
  run `context-tree sync --project-path PROJECT` at each task boundary and keep the returned
  `treeRoot` for that task. It carries no snapshot path or commit SHA, because those change with
  every new revision and would invalidate the provider's prompt cache; its wording is stable
  across Turns.
- Agents run `context-tree sync` through the same command gateway on Local and Cloud. Responses
  follow the package's public contracts. A failed sync is reported; `sync --offline` returns the
  cached snapshot, which the Agent reads as possibly stale. Modified snapshots are reported by the
  CLI and preserved for recovery. Writes keep using `context-tree write prepare` and `write finish`
  through that gateway.
- Cloud workspace persistence keeps the Context Tree repository caches and snapshots; see
  [Cloud workspace persistence](../cloud/cloud-workspace-persistence.md).

## Authorization and writes

Server-side connection verification checks the selected directory and branch at an exact
remote commit, using the current Agent's GitHub MCP authorization. It rechecks authorization
and remote state before accepting the connection. Unrelated repository infrastructure does
not affect subtree validation: Git entry enumeration is scoped to the literal selected path and
its ancestors under the existing process output bound. Root selection covers the repository.
Selected content cannot traverse symlinks or submodules.

Before reconnecting, run `context-tree verify --tree-path DIRECTORY` in the selected tree.
Remove symlink entries such as `CLAUDE.md` or `README.md` links, keeping any ordinary target files,
and remove submodules from the selected directory. Commit and push the repairs before connecting
again. A failed connection names the symlink repair and the verification command.

Managed prompts identify each source, its exact selector, project path, and availability.
Remote snapshots are for reading. Agents use `write prepare` to create an isolated worktree,
then `write finish` to commit and optionally publish. Local directory trees use direct edits
and their host repository's Git workflow. Agent member directories remain a convention,
not a confidentiality boundary.
Cache and publication identity checks use the stored origin URL, so the managed Git
transport's URL rewrite does not change the selected repository's identity.

## Distribution

OpenTag pins `@first-tree-ai/context-tree` to `1.1.1`. New managed repository caches
are treeless partial clones (`--filter=tree:0`). Git subtree snapshots and write sessions
use a literal non-cone sparse checkout of only the selected directory with a full Git
index, requiring Git 2.36 or newer. Snapshot identity includes the selected directory and
commit; repository-root sources use full checkouts. Existing snapshots and unpublished
write sessions are preserved. `sync` reuses a fetch made within the last 60 seconds on
the same machine (`--max-age <seconds>`, `0` forces a fetch); `connect` and
`write prepare` always fetch. A publish advances that machine's cached branch, so an
immediate `sync` resolves the published commit. A `sync` removes that repository's other
clean, unlocked snapshots that have not been resolved for 24 hours; a removed snapshot is
recreated at the same path when resolved again. Repository-cache and snapshot locks wait
up to two minutes before failing. Portable builds and Cloud images
include its CLI, public contracts, and six skills: init, connect, read, write, cleanup,
and schedule-cleanup. Native cleanup schedules belong on persistent supported hosts,
not ephemeral Cloud sandboxes. Server, Local runtimes, and Cloud images use the same
connection contract. Local connect/create operations require the connected Computer to advertise
`runtime.contextTreeSettings` version 2, before the Server runs GitHub work. An older
runtime receives an upgrade message before remote work or selection persistence. Cloud images
must include the pinned CLI before accepting these selections. An Agent's bound Computer cannot
be replaced, with or without selected trees; see [Configuration identity](../agent-session-computer-model.md#configuration-identity).
Same-Computer reconnect and upgrades retain the selection and its compatibility requirements.

Saved Session snapshots are verified using their original tree shape and hash layout. New
snapshots use the strict source format. Removing or replacing a saved tree starts a fresh Provider
conversation within the same Session while preserving historical snapshots and delivery receipts;
an unresolved Turn must settle first.

Local Sessions prepend the bundled Context Tree CLI at the final Provider launch boundary,
after executable discovery and per-execution environment composition. This applies to
visible and internal Sessions, so an older global CLI cannot take precedence.
The shared Local/Cloud proxy environment sets `OPENTAG_CONTEXT_TREE_MANAGED=1`.
Codex shell commands retain this non-secret marker and the execution's Context Tree manifest path.
The Codex adapter pins shell inheritance to `all` to retain Session routing metadata across native
default changes, without replacing the operator's filter table.
Custom environment policies must retain this routing metadata for managed commands.
When either identifies a proxy-managed execution, sync and write commands without a usable gateway
route are rejected rather than running the standalone CLI, including when the manifest is missing.
Local legacy mode does not set this marker or publish a manifest; its sync and write commands
retain their existing pinned-CLI behavior. General Session variables such as `OPENTAG_HOME` do not
identify proxy mode. Read and verification commands remain local even when routing is unavailable.
