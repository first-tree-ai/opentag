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

The openTag Server is the authoritative control plane for Agent identity and
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
service manager plus per-home ownership evidence. openTag does not introduce a
local socket or named-pipe RPC boundary between product commands and the daemon.

## Client connection

One openTag home has at most one daemon. That daemon manages the Local Computer
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

Computer repair commits installation replacement, old credential revocation,
new credential issuance, and connect-code consumption in one transaction. The
Server then waits at most one second for connection cleanup. A cleanup failure
or timeout is logged separately and does not replace the committed exchange
response. Cleanup targets only the revoked credential IDs, so a delayed close
cannot evict a subsequent connection authenticated with another credential.

Create-code redemption is idempotent per installation. `computer connect` keeps
the home's existing installation ID for the same Server and sends its current
machine token when it has one. Under the Account and code locks (then the target
Agent, for a targeted code) the exchange locks the installation's live Computer
and classifies it:

| Installation's live Computer | Result |
| --- | --- |
| None (never seen, or deleted) | Create a new Computer (`created`). |
| Another Account's, or the presented token belongs to another Account | `COMPUTER_ACCOUNT_CONFLICT` (409). Nothing is consumed or changed. |
| Same Account, online on the same release, untargeted code, current token presented | `already_connected`: no credential rotation or reconnect, no token returned; the code is redeemed by this Computer so the issuing page reaches its connected state. |
| Same Account, otherwise (offline, disconnected, another running release, token stale or absent, targeted code) | Repair in place (`repaired`): same Computer ID, `disconnected_at` cleared, credentials rotated, code consumed. |

The connect command is one command that users and Agents can run again safely: it upgrades openTag first, then
connects, and on an already-connected computer it repairs or confirms instead of adding a duplicate. Rerunning is the
expected fix for a half-finished or broken connection, so it must never make things worse. The upgrade finishes
before connecting starts: overlapping them would save little time and add failures from a connection made by one
version while another is being installed.

- An account conflict stops without taking the computer over and offers no web action to do so. The browser that
  issued the command may be signed in to a different account than the one that owns the computer, and only the
  current owner can release it (by removing it in openTag).
- An already-connected computer still consumes the code, and both the web page and the CLI show the same plain
  “connected” result as a fresh connection. Whether anything changed is an internal detail the reader cannot act on.

The request fields `machineToken` and `reportOutcome` are optional. The Server
answers `outcome` (and may omit the token) only to Clients that sent
`reportOutcome`, so older Clients keep their strict response shape; a newer
Client retries once without the optional fields when an older Server rejects them
as unknown keys, which happens before redemption. Older Clients always send a new
installation ID and therefore still create a new Computer on rerun. A local
identity file that is gone (reinstall) also yields a new Computer; the previous
one stays offline. Repair-mode codes keep their targeted behavior.

The committed repair clears the current instance. Registration, heartbeat,
and queued Runtime business frames independently validate the active credential;
delivery and approval authority also require the current instance and connection.
Closing the old socket is cleanup, rather than the authority that revokes it.
Work already executing on an offline Client cannot be physically stopped by
Server credential revocation alone.

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

### Status state outside the Server process

> **Planned — not yet implemented.** Tracking: #1215

Server services keep no in-process state, so the Server can run as more than one instance. High-frequency state that
can be lost, such as the Computer, runtime and messaging-channel sub-statuses, goes to a TTL key-value cache (Redis,
about one minute); durable data goes to PostgreSQL. A Computer is offline after three missed heartbeats (90 seconds),
which voids its other sub-statuses, and the Agent status is derived on read rather than stored; see
[Agent status pipeline](runtime/computer-status-pipeline.md). This replaces the expiring per-connection observations
described above.

## Explicit Web runtime test

Web may let a user explicitly test the saved Agent runtime configuration by
asking the Agent's bound Computer to make one real, bounded Provider request.
The test creates no Session or Provider binding, changes no readiness
observation, and writes no durable record. The daemon validates a one-time
sentinel locally and returns only pass or a fixed sanitized failure. A pass
proves only that this invocation worked with that configuration on that
Computer; it is not an authentication or readiness claim.

## Response compatibility

The Server and the CLI ship separately. A Server release applies to everyone at
once, while a CLI upgrades only on its next connect, so released CLIs keep
reading responses from newer Servers for a long time. The HTTP contract
therefore follows one convention:

- The Server changes responses additively: it may add fields, but it does not
  remove, rename, or retype an existing field.
- The client (`packages/client`, which the CLI uses) ignores response fields it
  does not know. It parses each response with the strict shared schema and, when
  the only problems are unrecognized keys, drops exactly those keys at the paths
  the schema reports and parses again. Every known field stays fully validated,
  and the dropped key paths (never values) go to the client's debug log so
  version skew is visible when diagnosing.
- Removing, renaming, or retyping a field, adding an enum value, or any other
  change an older client cannot read still needs version negotiation or a client
  capability header (an `x-opentag-*` request header that opts a newer client
  into the new shape). A capability header is not needed for a new field once
  the released CLIs ignore unknown fields.
- Request bodies stay strict on the Server: unknown keys sent to the Server are
  rejected.

The runtime connection negotiates capabilities in its own protocol and is
outside this convention.

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
