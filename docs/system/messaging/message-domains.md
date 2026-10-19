---
title: "Message domains and routing"
description: "Human-visible IM messages versus Session collaboration messages: guarantees, routing, attention, and the human-visible send path."
soft_links:
  - /product/agent-collaboration.md
  - /system/agent-session-computer-model.md
  - /system/server-client-boundary.md
---

# Message domains and routing

## Decision

OpenTag has two message domains with different audiences and reliability:

- An IM message is the Server-authoritative record of a human-visible Feishu or
  Slack message. Create, edit, and delete are immutable revisions whose current
  state is derived from provider-authoritative ordering rather than arrival
  order. The Server persists and deduplicates them, routes them to the relevant
  existing or ensured chat Sessions, and may perform bounded replay using
  IM-specific delivery records. Clients deduplicate by stable message and
  delivery identity.
- A Session message is an Agent collaboration message between existing,
  unended Sessions of the same Agent and conversation scope. It is best-effort
  and real-time, with no offline queue or exactly-once guarantee. See
  [Internal Session collaboration](internal-session-collaboration.md).

The two domains do not share one persistent message model. After either reaches
a Client, it is normalized into a runtime-only Session input envelope so the same
inbox and Provider adapter can start a Turn, inject into an active Turn when
supported, or process it immediately after that Turn. Provider steering affects
latency, not correctness.

## Routing

An IM delivery is durable custody for one target Session, not message history.
The Client persists the accepted input and its Turn binding before acknowledging
custody. Expiry bounds undelivered work without deleting the immutable message.

Session message routing is location-transparent. An unreachable target fails
visibly; the Server does not retain the message for later delivery. The caller
decides whether to retry an unknown or unreachable result using the same message
identity for best-effort deduplication. Sending from or to an ended Session is
rejected; delivery never revives the Session.

## Human-visible sending

Agent runtimes send human-visible messages by calling the official Feishu or
Slack CLI directly (see [Direct provider CLI messaging](direct-provider-cli.md)).
Provider-native text, cards, Blocks, files, threads, and reactions remain
provider concerns; OpenTag exposes no hosted send, reply, or reaction API.

Provider CLI calls pass through the Server's provider proxy. When a registered
send or reply operation succeeds there, OpenTag captures the platform-confirmed
message identity and a bounded, display-oriented copy of its body as an
outbound IM message. Capture is best-effort: it uses only the verified provider
response, never request text or runtime summaries, triggers no delivery,
Session, or Agent side effects, and a capture failure never turns a confirmed
send into a failure or a resend.

Inbound provider events remain the authoritative message history that drives
delivery. A bound Bot's own provider events are filtered before persistence and
delivery rather than treated as an outbound confirmation. The provider
conversation is the authority for the complete human-visible transcript.

## Rationale

Human conversation needs a durable record and bounded recovery, while Agent
coordination benefits from low-latency failure that the caller can reason about.
Keeping those guarantees separate avoids forcing IM persistence onto internal
collaboration or weakening human-visible message correctness to best-effort
delivery.

Provider CLIs preserve each platform's native message surface without making
OpenTag duplicate or translate it. Recording only what the platform confirmed,
without a hosted send path, gives the owner visibility into replies while
avoiding a second write path and false delivery guarantees.

## Constraints

- Message delivery never implicitly creates an internal Session or revives an
  ended Session.
- A local fast path is an optimization, not a co-location requirement.
- Trace is observational and cannot trigger message replay or Session state.
- `direct` and `ambient` attention are per-target input semantics and remain
  independent from the Agent's `receive_mode` and credential authorization.
- `direct` means the message itself addresses the Agent (a DM or an
  @-mention); `ambient` means everything else, including unaddressed follow-ups
  in a thread with established direct continuity. Continuity decides whether a
  thread Session receives a message and how long the delivery is retained, never
  its attention.
- The reply decision for each attention is stated once, in the managed system
  prompt. Per-Turn context carries only the attention fact and a pointer to that
  rule, never a competing reply mandate.
- Every thread delivery carries the bounded same-thread history its Session has
  not yet accepted, so an ambient follow-up that first materializes a thread
  Session still sees the root and earlier replies.
