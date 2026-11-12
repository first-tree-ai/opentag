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
Session workspace. The Server does not host Git repositories.

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
branch before saving. Agent/runtime revisions guard the final update. A running Agent can
change its selection; the change applies from the next turn.

Each Cloud Sandbox owns its cached snapshots and write sessions. Preparation saves the current
authorized selection in an OpenTag-owned project configuration and writes the packaged CLI shim;
it performs no remote synchronization or automatic offline recovery. Removed selections do not
delete cached content or unpublished work. The Agent runs `context-tree sync` through the command
gateway at task boundaries and uses `sync --offline` after a failed refresh, reporting cached
content as possibly stale. A source is available only when both its command gateway and packaged
Skills are present. Partial results remain independent and no tree takes precedence. See
[Preparation](../capabilities/context-tree-integration.md#preparation) and
[Read freshness](../capabilities/context-tree-integration.md#read-freshness-and-prompt-placement).

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
opentag session stop <internal-session-id>
opentag session list
```

The source Session is supplied by the execution, not a caller-selected identity. Cloud proof must
belong to the current Session, placement and live allocation/execution. An always-online Computer,
a guessed sibling Session ID, or material from a retired allocation does not establish authority.

Targets are any live Session of the same Agent, in any conversation; see
[Messages between conversations](../messaging/internal-session-collaboration.md#messages-between-conversations). A Cloud
Session shares nothing else with its peers, so here this is a new channel. An internal Cloud child uses its own
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
Terminal results and allocation retirement compare-and-set the exact record already validated or
scanned, using the existing durable-work transaction. A conflicting update is neither overwritten
nor acknowledged; an identical terminal replay remains acknowledgeable. Busy/grant cleanup follows
a successful or identical commit and names that exact Turn, preserving newer work.

On a Runner collaboration-v3 channel, the settled frame also carries the Run's failure reason (for
example `turn_timeout`), journaled with the immutable settlement. A Runner sends it only after a
v3 welcome; a Server that negotiated v1 or v2 receives the exact older frame. After a non-completed
terminal commit (new or identical replay), the Server notifies the message's sender and
withholds that settlement's ack until the notice has a final answer, so the journaled settlement
remains the replay owner; see
[Run outcome notices](../messaging/internal-session-collaboration.md#run-outcome-notices).

While that ack is withheld, the settling allocation (Sandbox, environment generation and resource
name) stays in the Session-work reclaim barrier. The custody is held before the record turns
terminal, so idle reclamation and same-account borrow see no gap. It is released only when the ack
is handed to the exact current connection of that allocation: the original one, or the connection
that receives the replayed settlement. A detach before the ack keeps the barrier until the replay
is acknowledged. Each settlement handler (the original and every replay) holds its own share of the
custody: a handler whose terminal commit lost, such as a stale connection racing its replay, drops
only its own share, and the exact ack ends every share. The barrier reads the durable rows first
and checks the custody after those reads, so a settlement that commits while the barrier is reading
is still seen. The custody never pins a replacement allocation, and a retired allocation's
custody is dropped with its journal. There is no timeout, matching the durable barrier: a Runner
that never returns is handled by allocation-loss recovery.

The custody is in Server memory. After a Server restart the Runner replays the journaled settlement
on reconnect, which holds the custody again. A borrow needs a ready Runner, and a
workspace-persistent Runner replays before it reports ready. The Server handles a connection's
frames in order, so the barrier is back before any borrow can see the Runner. An idle claim made
while the Runner is away still needs a sealed workspace before release. The Runner's seal drains
its journal and waits for every settlement ack, so the release cannot destroy an unacknowledged
settlement. A v3 Runner
image requires a v3 Server, so the Server must be deployed first, as with earlier versions.

Cloud delivery still uses one Server owner, with no cross-Server routing or independent task queue.
Local Session collaboration keeps its current behavior and trust boundary.

Scheduled handoffs carry their existing cancellation signal through the per-Session FIFO and
preparation stages. Cancelled unsent entries skip model, database and allocation preparation;
readiness polling stops without starting later stages. Already-issued database and allocation
operations keep their own bounds, and a late result cannot restart preparation. Cancellation after
the first frame preserves receipt processing and durable custody; it does not prove that execution
stopped or authorize a replay.
