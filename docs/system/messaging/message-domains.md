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

openTag has two message domains with different audiences and reliability:

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

## Durable inbound receipt work

Slack persists recoverable work on its existing receipt before acknowledging an
event. The input contains only the bounded fields used by normalization, the
verified App/Team/Bot identity, the original installation generation and route
snapshot, and the original receive time. Credentials, request headers and the
unrestricted provider envelope are not saved. If the route snapshot is temporarily
unavailable, recovery resolves it only after checking the same installation and
generation. Live and recovered Slack processing consume the same projected event
envelope. If the same installation/generation is still active but its stored grant
lacks required Bot permissions, recovery ends that receipt with `SLACK_INBOUND_SCOPES_MISSING`.
If the stored grant includes all required permissions but this Server cannot read
its credentials, recovery retains the input and backs off rather than treating it as disabled.
Feishu saves its strict normalized input under the current connection
fence before Inbox persistence. Its receipt key remains `(binding, event_id)`;
Slack's remains `(installation, generation, event_id)`. Feishu events without a
provider envelope event ID retain their existing synchronous Inbox path.

Input validation limits durable work to 2 MiB, including identity metadata. Slack
keeps its existing 1 MiB HTTP body limit. The receipt keeps its existing
`processing`, `failed`, and `processed` meanings; processed includes ordinary
ignored events and does not prove a Turn ran or a reply was sent. A 60-second
processing lease and the existing monotonic attempt count allow another worker
to recover failed or abandoned work. Claiming is one atomic PostgreSQL statement
with `SKIP LOCKED`; settlement must match the processing attempt. No receipt row
lock is held while normalization, routing or Inbox processing runs. Permanent Inbox scope or
identity rejection and invalid saved input end the work without another attempt. Retryable failures
use 2, 4, 8, 16, then 30 seconds of backoff.

Slack recovery handles at most eight receipts per five-second sweep. Feishu
recovery handles at most eight per existing connection-maintenance sweep, after
renewing connection leases; only the current durable connection holder can claim
its work. Inbox still verifies the original credential generation and the current
Feishu holder/epoch. Rotation or teardown cannot restore old authority. A repeated
Inbox call uses the existing message and Session uniqueness rules, including when
Inbox committed but receipt settlement was interrupted. This recovery never
replays an accepted Turn or an outbound operation.

Recovery eligibility ends seven days after the original receive time. Inbox uses
that original time for message receive timestamps and direct/ambient deadlines,
so a retry does not restart a 24-hour or seven-day delivery window. Completed work
clears its input immediately. Maintenance clears expired input in bounded batches,
skipping a still-live processing lease, then retains/deletes the diagnostic
receipt under its original retention rules. The eligibility deadline is distinct
from the time a cleanup batch reaches a row. Legacy receipts without saved input
remain deduplicated and cannot be reconstructed; there is no historical backfill.

The nullable-column migration does not make old receipt writers durable. Release
requires a coordinated Server cutover: stop old receipt writers, migrate, and run
the new Server before accepting traffic. Mixed old/new writers can still
acknowledge events without recoverable input. No migration can recreate input
that a previous Server already lost.

## Human-visible sending

Agent runtimes send human-visible messages by calling the official Feishu or
Slack CLI directly (see [Direct provider CLI messaging](direct-provider-cli.md)).
Provider-native text, cards, Blocks, files, threads, and reactions remain
provider concerns; openTag exposes no hosted send, reply, or reaction API.

Provider CLI calls pass through the Server's provider proxy. When a registered
send or reply operation succeeds there, openTag captures the platform-confirmed
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
openTag duplicate or translate it. Recording only what the platform confirmed,
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
