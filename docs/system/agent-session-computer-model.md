---
title: "Agent, Session, and Computer model"
description: "Durable Agent and Session identity, conversation scope, placement, and execution resources."
soft_links:
  - /product/agent-collaboration.md
  - /system/server-client-boundary.md
---

# Agent, Session, and Computer model

## Decision

An Agent is a user-managed, long-lived bot identity and profile. It owns its IM
binding, runtime Provider, default model and reasoning settings, instructions,
skills, tools, MCP Servers, Context Trees, receive mode, credentials, permission
settings, and its Computer once one is bound. Runtime collaboration creates
Sessions under an existing Agent; it does not create another Agent.

An Agent's Computer, runtime Provider, and messaging channel are fixed once set. Moving any of them is not supported;
to change one, create a new Agent and add it to the conversation. Why: an Agent's Sessions are bound to the channel,
the runtime, and the local storage on that Computer (Provider sessions, memory, files), so migration is costly and
risky; what must survive across Agents belongs in shared knowledge (the Context Tree), not in per-Agent memory. Moves
of Cloud sandbox storage are internal and never shown, so no migration concept is exposed for Cloud Agents.

A Session is a stable logical identity, not a Provider process or an activity
status. openTag has channel, thread, and internal Sessions. For Sessions that
have not ended, an Agent has at most one channel Session per Integration and
channel, and at most one thread Session per Integration, channel, and thread.
Multiple internal Sessions may coexist within the same conversation scope.

Every Session has an immutable conversation scope containing its Agent,
Integration, channel, and optional thread. An internal Session inherits that
scope from its creator. A creator Session reference is provenance only; it does
not determine permission, lifecycle, routing, or physical placement. The scope
decides where a Session replies and what it remembers, not who it can message:
[Sessions of one Agent message each other across conversations](messaging/internal-session-collaboration.md#messages-between-conversations).

Channel and thread Sessions are long-lived. Idle time, Turn completion, Provider
Runtime suspension, and Computer disconnect do not end them. Only an explicit
end sets `ended_at`. A later valid ensure for the same chat scope creates a new
Session identity instead of reviving the ended Session.

The Session closure (`session_descendants`) records, per ancestor and descendant
pair, the latest message activity and `descendant_active`, which is defined as
`descendant.ended_at is null`. The transaction that ends a Session writes both
facts, so the pair never disagrees: an ended descendant is inactive in every row
that names it as the descendant, including the rows of its own ancestors. The
flag describes the descendant only — ending an ancestor does not change it.

## Execution and placement

Session, Session Runtime, Computer, and Workspace have independent lifecycles:

- A Session is the durable identity and authorization scope.
- A Session Runtime is a replaceable Codex, Claude Code, or Pi Provider instance.
- A Computer represents execution capacity: a Local Computer or the Account's
  logical [Cloud Computer](../product/cloud-computer.md).
- A Workspace is the code and file view prepared for a Session's work.

Session does not persist runtime or reachability enums. Turn and runtime
activity belongs to the concrete Turn or request result. Computer reachability
belongs to the current Client connection.

Placement is a separate server-owned fact. Each Session has one placement
containing its Computer and the fencing `generation`. The placement policy
derives the Computer from the Agent's bound Computer, so an Agent that has no
Computer has nothing to derive a placement from. A disconnect makes an existing
route unavailable but does not mutate Session identity, end the Session, or
trigger automatic reassignment.

An Account may own zero, one, or several Computers. Which Computer an Agent runs
on is stated explicitly by its owner and recorded as that Agent's binding; no
surface resolves a collection down to one machine on the reader's behalf.

Provider readiness is an observation of the selected Provider on the current
Computer connection, not an admission field on Agent identity. Agent creation
records the explicit Provider, and the Computer when the caller names one,
without consulting readiness. Readiness can affect route availability and Turn
execution, but it cannot silently rewrite the Agent's Provider or create a
Session lifecycle state.

## Configuration identity

An Agent's nonempty Computer, runtime Provider and messaging App/Bot identity cannot be replaced.
The legacy rebind and Feishu replace commands obey the same boundary. An empty Computer can be
bound to an owned target at any revision: editing an unbound Agent never requires recreating it.
Selecting the existing Computer is an idempotent no-op. Same-Computer reconnect, upgrades and
credential repair, same-App reauthorization, and ordinary model, permissions and profile edits
remain available. Configured messaging cannot be replaced by disconnecting and recreating it. After disconnection,
setup names the retired identity and offers a new Agent instead of connection actions. A never-activated
provisioning slot can still be cleared and creation resumed on the same Agent.
Operator transfer rejects an Agent with a Computer or configured messaging identity; it preserves
custody checks and retained data. An unbound, unconfigured Agent may still transfer under the
existing operator preconditions and finish creation under its owner.

## Management writes

Agent rebind and targeted Computer connect-code issuance/exchange lock the Agent
before the Computer, matching scheduled dispatch admission and IM inbound
persistence. Exchange reuses that locked Agent row for binding validation and
mutation; untargeted exchange does not lock an Agent. Computer access mutations
retain their Account guard with
`FOR NO KEY UPDATE`: it serializes those mutations and conflicts with Account
updates/deletion while allowing the KEY SHARE required by existing ownership
foreign keys. Agent creation and rebind add no Account lock or query.

Agent creation and rebind lock their owned target Computer with `FOR NO KEY UPDATE`.
The existing owner, kind and deletion checks stay under that lock, which still excludes
concurrent Computer mutation. It permits the `KEY SHARE` required when a Session CLI
proof is first inserted. Rebind keeps Agent → target Computer → Session placements order;
proof minting keeps its placement lock and existing connection/generation checks. A rebind
to the current Computer retains its no-op semantics and does not rotate an existing proof.

Local scheduled dispatch prepares its Session CLI proof before entering final dispatch admission.
Proof preparation commits its own placement transaction first. Before each reconcile or message
send, admission locks Agent → IM binding → Session → placement → Computer → Schedule and rechecks
authority, placement, schedule enablement, and the claimed schedule revision. It releases these
locks when the send is marked, without waiting for the Runtime receipt. The transport boundary
also checks the current connection and cancellation signal, so delayed preparation cannot bypass
a committed management change or send after the dispatch deadline.

Schedule management follows the same Agent-first admission. Account writes recheck ownership
under that guard. Runtime Skill and Schedule writes retain their complete authenticated Session
source and lock binding → Session → placement → Computer → proof before their own mutation rows.
Final proof validation uses the transaction executor and the existing Local connection or Cloud
execution liveness rules. Their multi-query reads share a read-only snapshot; neither capability
inherits the Agent configuration self-edit opt-in switch.

Retained-report claims skip empty manifests. Nonempty claims lock the live Session with
`FOR NO KEY UPDATE` before its placement with `FOR UPDATE`, matching failed-report recovery.
Claims for a different Session are excluded before locking that Session's placement.

The staging/development reset uses the same weaker guard during Computer access
revocation. Its separate final cleanup verification keeps its existing lock.
Agent creation, placement changes, and credential exchange retain their small
transactions so related durable facts commit together. Connection cleanup and
Runtime notifications run after commit.

Lifecycle stop targets carry the Agent revision produced by suspend, delete or transfer.
Immediately before Local stop or Cloud cancellation enqueue, the caller locks Agent → Session →
placement and requires that exact revision, an inactive Agent and the captured Session placement.
A superseded decision is skipped. Local proof preparation finishes before this admission; its
enqueue is synchronous, so admission releases SQL without awaiting a socket callback or Runner
result. Cloud selects specific delivery/message/execution identities on the guarded executor and
retains durable work until terminal evidence. Proof retirement compares the selected proof ID and
update version; only a successful delete drops that proof's execution correlation. A later reused
or replaced proof survives an older result.

Local and Cloud final stop admission acquires Agent → Session → placement locks through
dependent locking CTEs in one SQL statement, retaining the transaction through enqueue.
Confirmed Local stop retires its captured proof with a single statement that locks the
matching placement before conditionally deleting that exact proof ID and update version.
Unfenced revocation retains separate placement locking and deletion statements so it observes
proofs committed by a preceding mint while it waited for the placement lock.

Local lifecycle stop runs at most 16 complete requests concurrently within one
30-second dispatch window. Deadline expiry or shared-domain capacity stops new
targets; admitted requests retain their result timers. Confirmed stop proof cleanup
remains owned by the Runtime domain through actual settlement even if notification
times out; shutdown joins it before disposing SQL. Late preparation checks the signal before final authority SQL, and
final enqueue checks it again. Unconfirmed targets retain the existing best-effort
failure diagnostic without being marked stopped or automatically retried. This
window starts after existing Cloud cancellation and is not the lifecycle HTTP
response deadline.

AgentService mutation queries select the caller's ownership in the locking
predicate, then validate lifecycle and revision while holding the row lock. A foreign or
missing Agent returns the same not-found result without waiting for a foreign
Agent row lock. Detail and configuration reads apply the same ownership
predicate in their first query. Agent detail and IM binding metadata/activity reads keep
authorization and enrichment in the same read-only snapshot. A concurrent transfer cannot combine
the previous Account's authorization with the new Account's binding or activity facts.

## Rationale

Stable Session identity lets messages and people address work without knowing
where a Provider process is running. Separating placement and transient runtime
observations prevents short-lived connection state from becoming a second or
contradictory Session lifecycle.

What creation must demand follows from what creation cannot take back. A choice
that is unrecoverable once recorded has to be made while the caller is still
deciding. A choice that can be corrected later should not be demanded up front:
requiring it states a precondition the product does not have, and makes an
Agent's identity and configuration wait on something it does not yet need.

## Constraints

- Client code must not silently choose one of an Account's Computers and present
  it as the Account's only one; binding an Agent records the Computer its owner
  selected.
- Internal Sessions inherit their creator's conversation scope and their Agent's
  Provider. Provider inheritance is a Server policy, not a property of the
  Session schema or message transport.
- Provider start, resume, suspend, and teardown are Client Runtime operations;
  they do not create Session state transitions.
- Placement changes fence stale execution with the placement generation.
- Physical co-location and a shared Workspace are policies, not Session-model
  invariants.
- An Agent with no Computer exists and is configurable, but nothing places it.
  Session creation, inbound delivery, and messaging connection are refused until
  a Computer is bound rather than falling back to a default one, because a
  substituted machine runs the Agent somewhere its owner never chose.
- Evidence admits only the subject it was gathered about. That a Computer
  arrived does not identify which Computer answered a particular request; a
  connect code's own Server-side verdict names the machine that redeemed it, and
  that correlation — not proximity in time — is what may place an Agent.
