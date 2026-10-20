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

A Session is a stable logical identity, not a Provider process or an activity
status. OpenTag has channel, thread, and internal Sessions. For Sessions that
have not ended, an Agent has at most one channel Session per Integration and
channel, and at most one thread Session per Integration, channel, and thread.
Multiple internal Sessions may coexist within the same conversation scope.

Every Session has an immutable conversation scope containing its Agent,
Integration, channel, and optional thread. An internal Session inherits that
scope from its creator. A creator Session reference is provenance only; it does
not determine permission, lifecycle, routing, or physical placement.

Channel and thread Sessions are long-lived. Idle time, Turn completion, Provider
Runtime suspension, and Computer disconnect do not end them. Only an explicit
end sets `ended_at`. A later valid ensure for the same chat scope creates a new
Session identity instead of reviving the ended Session.

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

The staging/development reset uses the same weaker guard during Computer access
revocation. Its separate final cleanup verification keeps its existing lock.
Agent creation, placement changes, and credential exchange retain their small
transactions so related durable facts commit together. Connection cleanup and
Runtime notifications run after commit.

AgentService mutation queries select the caller's ownership in the locking
predicate, then validate lifecycle and revision while holding the row lock. A foreign or
missing Agent returns the same not-found result without waiting for a foreign
Agent row lock. Detail and configuration reads apply the same ownership
predicate in their first query.

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
