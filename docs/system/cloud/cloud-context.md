---
title: "Cloud Context Tree and Session collaboration"
description: "What Cloud Sessions share through Agent configuration and published Context Tree knowledge, and what stays per Session."
---

# Cloud Context Tree and Session collaboration

Cloud Sessions share their Agent's current configuration and published Context Tree knowledge.
Each Session keeps its own workspace, Pi history and unpublished work. A logical Cloud Computer
does not imply a shared filesystem or a Local Computer WebSocket connection.

## State ownership

| Information | Source | How another Session obtains it |
| --- | --- | --- |
| Agent identity, instructions, model and Tree selection | Existing Server Agent/runtime configuration | The next Turn's effective runtime snapshot |
| Published knowledge | Explicitly selected GitHub Context Tree | Its own authorized checkout and normal Tree synchronization |
| Pi conversation, task files and unpublished Tree drafts | The current Agent Session workspace | Not synchronized to other Sessions |
| Collaboration messages and authorized conversation information | Existing Session/IM APIs | The managed CLI with current execution authority |
| Provider credentials | Existing Server credential authority | New execution-scoped material, never workspace restoration |

There is no second Agent configuration store, shared Agent Home, background directory replication,
or Context Tree checkpoint history. `sandboxes.storage_uri` still identifies the latest saved
Session workspace. E8 does not turn the Server into a Git hosting service.

## Configuration and recovery

The Server assembles the existing effective runtime snapshot for each new execution. Restoring a
workspace restores user work and Pi continuity; it does not choose an old model, reinstate an old
Tree selection, or reactivate a saved credential. The worker resumes the existing Pi binding with
the current snapshot and fresh execution material.

A running Turn keeps its admitted configuration. Changing an Agent's instructions affects its next
Turn. Credential and resource authorization are independently rechecked at their existing boundaries;
a frozen prompt is not permission to use a revoked integration.

The canonical Agent slug comes from current Server instructions, including after a rename. Agents
must use that identity for `members/<agent-slug>/`; neither the physical Instance name nor the Pi
conversation ID is the Agent identity.

## Context Tree

Connections explicitly select a repository, directory, and branch for each Agent. An empty
selection is normal. Cloud settings connect existing authorized trees. Server verification
checks Account ownership, repository admission, and the selected subtree at the requested
branch before saving. Agent/runtime revisions guard the final update; changing a nonempty
selection requires a paused Agent.

Each Cloud Sandbox owns its cached snapshots and write sessions. Before fetching, preparation
saves the current authorized selection in an OpenTag-owned project configuration. Removed
selections do not delete cached content or unpublished work. One sync refreshes the selected
sources; a separate recovery budget permits offline cached reads after a timeout. Modified
snapshots are unavailable. Partial results remain independent and no tree takes precedence.

The [Context Tree integration](../capabilities/context-tree-integration.md) uses the current
execution's managed GitHub environment. It never falls back to ambient host credentials.
The packaged CLI and skills own reads, validation, isolated writes, and publication.

Only published changes become visible to another Session through its own synchronization. Uncommitted
edits, prepared writes and unpublished commits remain private and participate in the existing
workspace save/restore. A conflict must preserve them and report the problem; the platform never
resets a dirty Tree or force-pushes to make synchronization appear successful.

Tree preparation is optional memory. No selection, a missing grant, a failed fetch, or a conflict must
produce a truthful managed status instead of an assertion that knowledge is current. The basic Pi
task can continue. Previously read knowledge cannot be erased by revocation; new managed remote
access and publication still require current authorization.

If the first clone is interrupted, a partial checkout may remain. The pinned CLI can report it as
unavailable on the next Turn; automatic deletion would risk drafts, so recovery requires explicitly
repairing that checkout. Base tasks can continue without it.

## Session collaboration

The existing managed commands remain the Agent-facing interface:

```text
opentag session create --message <task>
opentag session send <target-session-id> --message <text>
opentag session list
```

The source Session is supplied by the execution, not a caller-selected identity. Cloud proof must
belong to the current Session, placement and live allocation/execution. An always-online Computer,
a guessed sibling Session ID, or material from a retired allocation does not establish authority.

Targets retain the existing same-Agent and conversation scope. An internal Cloud child uses its own
Sandbox and Pi conversation. It does not inherit the parent's workspace or IM outbox credentials.
It reports through Session messages; a visible Session's callback uses that visible Session's
authorized outbox rather than automatically forwarding the child's text to IM.

IM input and collaboration work share the Sandbox's single execution slot and cleanup/save boundary.
They must not start two workers concurrently or let idle reclamation interrupt accepted work. A
message ID is the logical retry identity; an uncertain result is not permission to submit the same
task under a new ID and assume the old attempt never ran.

The Session CLI proof is issued when actual execution opens, after reaching the shared queue head.
A queued message cannot replace an active Turn's proof. Runner terminal results remain journaled
until the Server acknowledges their durable commit. Credential closure alone is not completion.

Cloud delivery still uses one Server owner. E8 adds no cross-Server routing or independent task queue.
Local Session collaboration keeps its current behavior and trust boundary.
