---
title: "Server and Client Runtime boundary"
description: "Control-plane authority, command paths, the multiplexed Client connection, readiness, and authentication constraints."
soft_links:
  - /system/agent-session-computer-model.md
  - /system/messaging/message-domains.md
  - /system/runtime/runtime-protocol.md
---

# Server and Client Runtime boundary

## Decision

The OpenTag Server is the authoritative control plane for Agent identity and
policy, Session identity, placement, IM facts, authorization, and global
routing. The Client Runtime is an execution node: it prepares Computers and
Workspaces, manages Provider runtimes, injects Session input, performs local
Session message routing, and exposes approved tools. Cloud Computers implement
the same Computer, Workspace, Runtime, and routing boundary through the Cloud
Runner rather than a second Session model.

Session creation and message delivery are separate operations. The Server
supports three Session operations: ensure a channel or thread Session, create an
internal Session, and end a Session. Provider start, resume, suspend, and
teardown are daemon-internal reconcile actions.

Human and script product commands call the Server API. Agent runtime tools call
in-process Client Runtime handlers. Daemon start, stop, and status use the host
service manager plus per-home ownership evidence. OpenTag does not introduce a
local socket or named-pipe RPC boundary between product commands and the daemon.

## Client connection

One OpenTag home has at most one daemon. That daemon manages the Local Computer
and multiplexes its Agents and Session Runtimes over one authenticated
WebSocket. Computer registration uses stable Computer identity; heartbeat and
silence detection describe only the current connection. Connection-instance
fencing prevents an old connection from receiving work or submitting results
after replacement. Protocol versions and capabilities are negotiated as
described in [Runtime protocol compatibility](runtime/runtime-protocol.md).

The connection carries reconcile requests and results, IM message delivery,
remote Session message relay, temporary IM credential grants, heartbeat, and
trace. Credential grant frames are secret-bearing and non-persistent: they are
handled outside ordinary logging and tracing and fenced to the current placement
and connection instance.

For IM message delivery, the Server owns the durable delivery identity and
global custody state. The Client persists the input, exact dispatch identity,
and local Turn binding before reporting acceptance. Retained custody and Turn
reports can then be reconciled after reconnect or Server restart without
starting a second Turn. Placement generation and connection-instance checks
fence every acceptance and report.

## Readiness

Provider readiness, provider CLI artifact readiness, and current Integration
credential execution readiness are separate, fresh, revocable facts of the
current Computer connection instance. A connected daemon or a successful CLI
version probe is not sufficient evidence. An omitted or expired observation is
absence of evidence, never evidence that a Provider is ready.

The Server may project readiness for product status and use fresh `ready`
evidence for routing, but readiness is not durable Agent or Session state.
After a Client accepts custody, it starts or resumes only the Provider pinned by
the effective runtime snapshot; missing credentials and other start failures
settle the Turn as typed, recoverable `not_started` failures. The Client never
falls back to a different Provider.

## Explicit Web runtime test

Web may let a user explicitly test the saved Agent runtime configuration by
asking the Agent's bound Computer to make one real, bounded Provider request.
The test creates no Session or Provider binding, changes no readiness
observation, and writes no durable record. The daemon validates a one-time
sentinel locally and returns only pass or a fixed sanitized failure. A pass
proves only that this invocation worked with that configuration on that
Computer; it is not an authentication or readiness claim.

## Rationale

The Server needs global authority to route across Computers and integrations,
while Provider processes and files are inherently local to execution. A single
multiplexed connection gives the Server real-time reachability without making
connection state a durable Session fact. Direct Server API commands and
in-process runtime tools avoid a second local control protocol and a second
writer of Session truth.

## Constraints

- Computer disconnect changes route availability only; it does not end or
  reassign Sessions.
- Provider credentials never enter prompts, IM messages, Session messages, or
  trace data.
- `direct` and `ambient` attention are input semantics, not credential
  authority: both visible IM Turns receive the temporary provider environment.
- Any Web admin status is timestamped trace or debug output and cannot become
  routing, placement, lifecycle, or reachability authority.
- A Computer first connects with a one-time code whose hash is stored by the
  Server and invalidated after a successful exchange.
- The Server runs checked-in database migrations before listening, holding a
  PostgreSQL advisory lock for the full migration so several Server instances
  cannot become concurrent migration writers.
