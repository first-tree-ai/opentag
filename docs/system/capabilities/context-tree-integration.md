---
title: "Context Tree integration"
description: "How Agents use repository directories for durable memory on Local and Cloud Computers."
---

# Context Tree integration

Context Tree stores durable knowledge in Markdown. OpenTag supplies Agent settings,
GitHub authorization, and runtime preparation. The packaged Context Tree CLI owns
content validation, read snapshots, and isolated write sessions.

Memory is optional. An unavailable tree is reported to the Agent without stopping its task.

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

Memory shows each connected tree in its own card, with its repository, directory,
branch, and a direct link to the GitHub folder. Disconnect is in the card's action menu.
With no trees connected, the page offers **Connect Context Tree** and
**Create Context Tree**. After the first connection, **Add tree** offers those
choices. Each choice opens a focused dialog; the collection does not show an inline form.
Connect accepts a GitHub repository link and an optional relative directory; an empty
directory means the repository root. GitHub’s default branch is resolved during verification
and saved with the connection. Both Local and Cloud can connect existing trees.
Create accepts an owner and repository name and uses GitHub's default branch.
Neither dialog asks for a branch.
Both Local and Cloud Computers can create private repositories: OpenTag creates the repository,
generates the initial page with the pinned `context-tree init`, and commits it through
GitHub's contents API. Connection verification and creation run exclusively on the Server with the Account's current GitHub
credential; it does not require Computer-side GitHub credentials. The OAuth authorization must allow private repositories, and the connected user
and organization policy must permit creation and content writes. Permission failures
ask the user to check access; only missing or invalid authorization asks them to reconnect.

Failed settings operations display an error banner. When the server has no GitHub OAuth App
configured, the message asks the server administrator to configure it; this does not
mean the bound Computer needs an update.

Operations carry expected Agent/runtime revisions. Changing a
nonempty selection requires a paused Agent. Disconnect only changes the selection;
it preserves cached content and unpublished work. Connecting an already selected source
and disconnecting an absent source are idempotent.
Repository creation never adopts or overwrites an existing repository. Remote writes are
not retried automatically. Rejected repository names prompt the user to choose another name or
connect an existing tree. An uncertain creation asks the user to inspect GitHub: connect a valid
tree, initialize and push the files if the repository is empty, or delete the empty repository
before retrying creation. Retrying an already connected tree is idempotent.

## Preparation

OpenTag writes authorized selections to its own configuration at
`WORKSPACE/.opentag/context-tree/project/.context-tree.json` **before fetching**.
Repository-owned `.context-tree.json` files are left alone. Those files can describe
local directory trees used through the normal repository workflow.

Managed synchronization and write commands route through a per-execution Context Tree command gateway in the trusted Local Daemon or Cloud Runner. Only its pinned CLI child receives a GitHub handle; the Agent receives a Unix socket or fixed Cloud loopback endpoint. The Server separately admits each command against the live parent, current Account authorization and exact selected tree. See [GitHub platform integration](github-platform-integration.md#context-tree-command-boundary).

Preparation uses `context-tree sync --project-path PROJECT` through this gateway. Responses are parsed
with the package's public contracts; OpenTag never reads the package's internal registry.
The path returned by the current sync is the read snapshot. A failed refresh can use
`sync --offline` to recover cached context, explicitly marked stale. Modified snapshots
are unavailable and preserved for recovery.

Local preparation is serialized. Concurrent starts join the same work; a five-second
startup budget lets the Session proceed while preparation continues. Failed sources
observe a one-minute retry cooldown. Changed selections or missing managed authorization invalidate
cached results. Rotating execution tokens preserve ready read snapshots; in-flight work remains
bound to its original token. Providers receive the bounded Context Tree state directory needed to create
write sessions, not just the read snapshot path.

Cloud preparation allows 25 seconds for refresh and reserves a separate five-second
budget for offline recovery. Caller cancellation stops both. A failed source does not
hide successful entries returned by the CLI. Configuration, repository caches, snapshots,
and write sessions live below `.opentag/context-tree` and survive workspace save/restore.
Credentials come from the current execution and are never stored there.

## Authorization and writes

Server-side connection verification checks the selected directory and branch at an exact
remote commit, using the Account's current GitHub authorization. It rechecks authorization
and remote state before accepting the connection. Unrelated repository infrastructure does
not affect subtree validation. Selected content cannot traverse symlinks or submodules.

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

OpenTag pins `@first-tree-ai/context-tree` to `1.0.1`. Portable builds and Cloud images
include its CLI, public contracts, and six skills: init, connect, read, write, cleanup,
and schedule-cleanup. Native cleanup schedules belong on persistent supported hosts,
not ephemeral Cloud sandboxes. Server, Local runtimes, and Cloud images use the same
connection contract. Local connect/create operations require the connected Computer to advertise
`runtime.contextTreeSettings` version 2, before the Server runs GitHub work. An older
runtime receives an upgrade message before remote work or selection persistence. Cloud images
must include the pinned CLI before accepting these selections. Moving an Agent with selected
trees to another Local Computer requires the destination to be online and advertise the same
capability. If it cannot, the move is rejected with an upgrade message and the existing placement
is preserved. Agents without selected trees retain the normal move behavior.

Saved Session snapshots are verified using their original tree shape and hash layout. New
snapshots use the strict source format. Removing or replacing a saved tree starts a fresh Provider
conversation within the same Session while preserving historical snapshots and delivery receipts;
an unresolved Turn must settle first.

Local Sessions prepend the bundled Context Tree CLI at the final Provider launch boundary,
after executable discovery and per-execution environment composition. This applies to
visible and internal Sessions, so an older global CLI cannot take precedence.
