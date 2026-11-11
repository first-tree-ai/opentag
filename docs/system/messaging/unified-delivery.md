---
title: "Unified delivery model"
description: "Design for one Server-to-Client delivery model: envelope, state machine, receipts, timeouts tied to the transport, retry ownership, deduplication, persistence, and failure notices with correction, with IM, Session, and scheduled messages as sources with their own policies."
soft_links:
  - /system/messaging/server-client-delivery.md
  - /system/server-client-boundary.md
  - /system/database-read-write-standards.md
---

# Unified delivery model

> **Proposal under review, not a decision.** Once the owners named under [Decision points](#decision-points) decide,
> this page is rewritten under the fixed `Planned — not yet implemented` marker with a tracking issue, and the
> rejected options are removed. Until then it must not be read as current or planned behavior.

[Server-to-Client delivery](server-client-delivery.md) describes how an IM message, a Session message, and a scheduled
message reach a Session today and lists eleven gaps. They share one cause: each path owns its own hand-off bookkeeping,
so the same question (was this frame received, who waits for the receipt, who retries, who tells whom when it fails)
has three answers that drifted apart. This page proposes one model that the three paths use as sources with their own
policies, and a plan to get there in small, independently mergeable steps.

## Goal and non-goals

The goal is one hand-off model between the Server and a Local Client or Cloud Runner:

- one **envelope** per hand-off attempt, with the same identity rules for every source;
- one **state machine** from recording to settlement, with the same meaning for `accepted`, `unconfirmed`, `held`,
  and the terminal states on every path;
- **receipts** matched to attempts and still applied when they arrive late, within one window derived from the
  transport's heartbeat rather than a per-path constant;
- **retry ownership** stated once: the Server owns the hand-off until the Client accepts, the Client owns execution
  afterwards, for all three sources;
- one **deduplication identity** on the Client, and one durable store whose pruning follows the Server's retry window;
- one **failure notifier** that knows what it posted, so a notice can be corrected or followed up.

Out of scope: provider ingress and IM message history, Turn execution and the automatic retry of accepted work, the
Cloud Sandbox lifecycle, the Runner journal format, and merging `im_message_deliveries` and `session_messages` into one
table. The model is a layer the three paths call; it does not replace their durable records in the first phases.

## Differences that stay

Unification is about the hand-off, not about making the three inputs the same thing.

- **IM messages** are a projection of an external platform: the provider conversation is the authority, deliveries are
  custody rather than history, a Turn Report settles the delivery, and ingress deadlines, the 99-input queue, batches,
  steers, thread and observer roles, and the IM feedback surface (reactions, cards) stay as they are.
- **Session messages** have a sender that is a Run waiting for an answer inside a 30-second CLI call. Permanent
  rejections (`scope_mismatch`, `target_unavailable`, `message_conflict`) stay immediate. Notices to the sender stay
  SessionMessages with deterministic ids that never bounce between two Sessions.
- **Scheduled messages** have no sender, a fixed target, a management fence (pause, edit, delete win against an unsent
  occurrence), the 30-second claim window, and a successor: once the next occurrence is claimed the earlier one is
  superseded instead of retried. The conversation, not a Session, hears about a miss.
- **Cloud** targets start slowly (a cold allocation takes between 20 and 280 seconds), take custody through the Runner's
  fsynced journal, settle through `session:message:settled` with an ack, and lose work when an allocation is retired.
  There is no Client-registered event that says "the Runner is back", only the Runner's own re-announcement.

## State machines

Today each path has its own vocabulary. The IM delivery row:

```text
pending --claim--> (dispatched, correlation persisted) --accepted--> accepted --report--> reported
   |                     |  timeout: released, correlation kept, retried; 8x -> terminal_rejected | parked
   |                     +--rejected(terminal)--> terminal_rejected
   +--ingress deadline--> expired
```

The Session message row (`last_outcome`, `last_error_code`), ordinary and scheduled:

```text
unknown(attempt n) --receipt--> accepted | rejected
                   --refused before send--> unreachable/<code>      (nobody retries; caller may resend)
                   --timer--> unknown/delivery_timeout               (late receipt ignored)
                   --sent, then failure--> unknown/delivery_uncertain
scheduled only: one attempt; summary on agent_schedules.last_dispatch; miss notice from the outcome
```

The target has one machine for every source. States are written by the Server; the Client and Runner only produce
receipts and reports.

```text
                 +------------------------------------------------------------------+
                 |                                                                  v
recorded --dispatch--> sent --receipt accepted--> accepted --run--> settled{completed|failed|cancelled|unknown}
   |                    |                                               ^
   |                    +--receipt rejected(permanent)--> rejected       |
   |                    +--no receipt within window--> unconfirmed       |  (late receipt still accepted
   |                                   |                                |   until the window closes)
   +--target unreachable--> held <-----+-- redelivery event (register, recovery, periodic)
                              |
                              +--hold limit / next occurrence / target ended--> expired | superseded | rejected
```

- `recorded`: the durable row exists (IM delivery, Session message, scheduled claim). Nothing was sent.
- `sent`: a frame left on an exact connection; the attempt has a `requestId`.
- `accepted`: the Client or Runner persisted the input and answered. From here the Client owns execution.
- `unconfirmed`: the receipt window closed without an answer. The attempt is neither proven delivered nor proven
  lost; a receipt that arrives before the window closes still moves the row to `accepted`.
- `held`: the Server keeps the message and will send it again on a redelivery event. `unreachable` today maps here for
  Local targets; it stays a terminal answer only where nothing can bring the target back (ended Session, foreign
  binding).
- `expired`, `superseded`, `rejected`: terminal without execution. Each carries its code and, where a sender exists,
  produces exactly one notice.

The IM delivery row already has every state above (`expired`, `terminal_rejected`, parked); the Session message row
expresses `held`, `unconfirmed`, `expired`, and `superseded` only through codes. How that row stores them is decision D1.

## Envelope

The envelope is the in-memory and logged shape of one attempt, built by each source from its own row:

| Field | IM delivery | Session message | Scheduled message |
| --- | --- | --- | --- |
| `kind` | `im` | `session` | `scheduled` |
| `messageId` (logical identity, stable across attempts) | delivery id | message id | message id (UUIDv5 of schedule and instant) |
| `requestId` (per attempt) | dispatch request id, persisted | random, in memory | random, in memory |
| `target` | Session, Agent, placement generation, Computer kind | same | same |
| `attempt` | `attempt_count` | `attempt_count` | 1 |
| `inputHash` (conflict detection) | direct input hash | semantic hash (source, target, Agent, content) | semantic hash (origin, target, Agent, content) |
| `deadline` | ingress `expires_at` | hold limit (24 h after recording) | next occurrence or hold limit |
| `receiptWindowMs` | heartbeat window of the transport | same | same |
| `retryPolicy` | capped backoff plus offline term until `deadline` | redelivery events until `deadline` | redelivery events until `deadline` or supersession |
| `notice` | IM feedback target | sender (SessionMessage) | conversation (scheduled task message) |

Nothing in the envelope is new information; today it is scattered across `ImDeliveryWorker`, `RuntimeDomainOwner`,
`SessionCollaborationService`, `ScheduleScheduler`, and `CloudSessionCollaborationOwner`. The first phases only make the
same facts flow through one place.

## Receipts and timing

Rule: a receipt is matched by `requestId`, applied whenever it arrives before the **receipt window** closes, and the
window is the transport's heartbeat window (90 seconds for a Local connection, 45 seconds for a Runner), not a per-path
constant. After the window a connection that has not reconnected is dead by definition, so a later receipt cannot
arrive on it.

| Wait | Today | Target |
| --- | --- | --- |
| Local IM delivery receipt | 30 s operation deadline, late receipt applied through `#expiredDeliveries` | unchanged; the same late-receipt map serves every kind |
| Local Session message receipt | 30 s, late receipt dropped | receipt window 90 s, late receipt applied |
| Local scheduled receipt | 90 s after the send mark, late receipt dropped | receipt window 90 s, late receipt applied |
| Cloud Session and scheduled receipt | 30 s, late receipt treated as a re-announcement | receipt window 45 s |
| `session send` caller wait | up to 60 s against a 30 s CLI timeout | hand-off budget 5 s, then `accepted` with the Server holding the message |
| Scheduled preparation | 60 s Local, 280 s or 20 s Cloud | unchanged; preparation is a source policy |

The caller of `session send` therefore no longer waits for the Client. It gets `accepted` as soon as the Server has
recorded and, within 5 seconds, either handed the message over or started holding it. This is the semantics PR
[#1353](https://github.com/first-tree-ai/opentag/pull/1353) introduces, adopted here for all three sources: `accepted`
means openTag has the message. The response gains an optional `delivery` field (`client` or `server`) so a newer CLI
can say which; released CLIs ignore unknown response fields.

## Retry ownership

| Phase | Owner | IM delivery | Session message | Scheduled message |
| --- | --- | --- | --- | --- |
| Before acceptance | Server | until `expires_at`, capped backoff plus offline term (unchanged) | until the hold limit, on redelivery events: registration, recovery follow-ups at 5 and 20 s, a 60 s pass over connected Computers | until the next occurrence is claimed or the hold limit, same events; an `unconfirmed` occurrence is also redelivered (decision D2) |
| After acceptance | Client or Runner | automatic retry of accepted work, unchanged | inbox retries, unchanged | unchanged |
| Settlement that never arrives | Server | report-acceptance cutoff settles `unknown` (unchanged) | Local: Client reports; Cloud: allocation loss settles `failed / allocation_retired` **and** notifies the sender | same as Session |

Redelivery is safe because the Client deduplicates by `messageId` and `inputHash` and never prunes a finished
Session message record, so a redelivered attempt never starts a second Run. Its answer tells the Server what it
missed: `accepted` while the record is queued, running, retrying, or succeeded, and `rejected` with
`provider_unavailable` once the Run has failed for good. The Server records that answer as the attempt's outcome; a
rejected replay is a terminal failure to notify about, never proof that the message was not accepted the first time.
For IM the frozen dispatch correlation already gives the same guarantee.

## Deduplication and persistence on the Client

Today IM custody lives in the Session binding store with the retry input under `data/runtime/turn-retries/`, and
Session messages in `runtime/durability/session-message.json`, with different keys, capacities, and pruning. The target
keeps the two stores but gives them one contract:

- one dedup key shape, `kind:targetSessionId:messageId`, with the input hash as the conflict check, implemented in one
  helper both owners use;
- one capacity policy per Session and per Client, with the same `client_busy` answer, sized so that a Server hold (256
  per target, 1,024 per Computer in [#1353](https://github.com/first-tree-ai/opentag/pull/1353)) can be taken back on
  recovery;
- pruning tied to the Server's retry window: a finished record is dedup evidence only while the Server may still send
  the message again, so it can leave the file once the hold limit plus a grace has passed; the file stops growing
  without bound and is no longer rewritten whole on every write (decision D5).

## Failure notices and correction

One notifier receives every terminal or uncertain transition and decides, per source, who hears what:

| Transition | IM delivery | Session message | Scheduled message |
| --- | --- | --- | --- |
| `unconfirmed` | nothing (retry continues) | nothing; the sender already has `accepted` | **nothing until the hold ends** (today: "may not have run" at once) |
| `held` longer than a threshold | offline or queued card (unchanged) | nothing | nothing; the schedule summary shows it |
| `expired` / `superseded` | expiry card (unchanged) | one delivery-failure notice to the sender | "didn't run" once per cause (unchanged wording) |
| `accepted` after a notice | expiry card updated or suppressed (unchanged) | n/a | the earlier notice is corrected (decision G1) |
| Run failed | failure card (unchanged) | Run outcome notice (unchanged) | scheduled task failure message (unchanged) |

Correction needs the notifier to remember what it posted. For IM that record is `im_feedback_targets`; for scheduled
misses nothing is stored today. The proposal stores the posted notice's provider message id in the schedule's
`last_dispatch` summary (jsonb, no migration) so a later `accepted` or Run can edit or follow up that exact message.
Whether to correct, and with which wording, is Gandy's call (G1); where to store it is yuezengwu's (D1).

## Protocol and schema

- **No frame changes** are needed for phases 0 to 3. Receipts already carry `requestId`; the late-receipt map, the hold
  state, and the notifier are Server-side. The Client's existing deduplication is what makes redelivery safe.
- **Capability versions**: `runtime.sessionCollaboration` is at v4 on `main` and
  [#1413](https://github.com/first-tree-ai/opentag/pull/1413) takes v5. The design needs a new version only if the
  Client inbox contract changes in phase 5 (for example, a Server-told hold limit for pruning); it would take the next
  free number after #1413 and stay optional, with older peers keeping today's behavior.
- **Response compatibility**: the `session send` response adds an optional field only, following
  [Response compatibility](../server-client-boundary.md#response-compatibility).
- **Schema** (decision D1): the Session message row needs to express `held`, `unconfirmed`, `expired`, and `superseded`.
  Option A keeps the current `last_outcome` enum and encodes states in `last_error_code` with a partial index, as
  #1353 does (`delivery_held`, `delivery_expired`, `delivery_superseded`); no `ALTER TYPE`, one index migration, states
  readable only by code. Option B adds columns (`delivery_state`, `receipt_window_ends_at`, `hold_until`,
  `last_receipt_at`) and leaves `last_outcome` as the compatibility projection; additive, no backfill, but a migration on
  a large table that must be sequenced with #1353's and #1413's `0075` migrations. The recommendation is A for phases 1
  and 2 and B once the model has settled, so the first phases ship without a second schema decision.

## Phases

Each phase is one pull request of about 500 lines, merges on its own, and leaves every older Client working.

| Phase | Scope | Depends on | Size |
| --- | --- | --- | --- |
| 0. Late receipts and one window | One late-receipt map in `RuntimeDomainOwner` for every kind; a `session:message:deliver:result` after its timer updates the row and the schedule summary to `accepted`; the receipt window constant derived from the heartbeat window; `dispatch.sent` and `receipt.late` log fields. | nothing | ~200 lines, Server + tests |
| 1. Server hold for Local targets | Merge [#1353](https://github.com/first-tree-ai/opentag/pull/1353): `delivery_held`, redelivery events, 5-second hand-off budget, 24-hour limit, supersession for schedules, delivery-failure notices. | phase 0 (rebase) | existing PR |
| 2. Hold `unconfirmed` too | After the receipt window, an unanswered Local Session or scheduled attempt becomes `held` instead of `unknown / delivery_timeout`; the miss notice waits for the hold to end. | phase 1, decision D2 | ~250 lines |
| 3. One notifier with memory | Route scheduled misses, delivery failures, and Run outcomes through one notifier that records the posted notice id in the schedule summary and corrects or follows up on a later `accepted`. | phase 2, decisions G1 and G2 | ~400 lines |
| 4. Cloud alignment | Receipt window 45 s from the Runner heartbeat; a `failed / allocation_retired` settlement notifies the sender; the Cloud scheduled path reports through the same notifier. | phase 3 | ~300 lines |
| 5. Client inbox contract | Shared dedup helper and capacity policy for IM custody and the Session inbox; pruning of finished Session records after the hold limit; file writes that append instead of rewriting. | phase 1, decision D5; rebase after [#1406](https://github.com/first-tree-ai/opentag/pull/1406) | ~400 lines, Client |
| 6. Durable hand-off for schedules | Persist the dispatch intent at claim so a Server restart redelivers an unsent occurrence instead of leaving a code-less `unknown`; the stale-claim sweep. | phase 2, decision D4 | ~300 lines |
| 7. Columns (optional) | Option B of D1: explicit state columns and the Web summary reading them. | phases 1 to 6, decision D1 | ~400 lines plus migration |

Phases 0 and 1 remove the #1510 shape for good: a late receipt is applied, and an unanswered hand-off that the Client
never received is redelivered. Phases 2 and 3 remove the false alarm; phase 6 removes the restart loss.

## Relationship to open work

- [#1353](https://github.com/first-tree-ai/opentag/pull/1353) is phase 1 and supplies the vocabulary (`delivery_held`,
  `delivery_expired`, `delivery_superseded`, `delivery_held_full`, `target_stopped`, the delivery-failure notice
  header). It excludes `unknown` hand-offs on purpose; phase 2 revisits that under D2. Its `0075` migration adds a
  partial index only.
- [#1406](https://github.com/first-tree-ai/opentag/pull/1406) keeps a Run open for background work and rewrites parts of
  `session-message-inbox.ts`. It changes no frame; phase 5 rebases after it.
- [#1413](https://github.com/first-tree-ai/opentag/pull/1413) adds provenance, `runtime.sessionCollaboration` v5, a new
  route, and a `0075` migration that adds columns to `session_messages`. Any column of this design comes after it and
  after #1353, and migration numbers are assigned at merge time.
- [#1424](https://github.com/first-tree-ai/opentag/pull/1424) keeps a running Turn's platform access across a
  configuration save. It does not touch delivery.
- [#1510](https://github.com/first-tree-ai/opentag/issues/1510) and #1513: phase 0 generalizes the 90-second scheduled
  receipt wait into the shared window and adds the late-receipt acceptance that #1513 did not include.

## Risks

- **Double execution.** Redelivering an `unconfirmed` or held message relies on Client deduplication. The Client
  never prunes finished Session records today; phase 5 must prune only past the Server's hold limit, and the Server
  must stop redelivering before the Client forgets.
- **Hidden dead links.** A 90-second window delays the first signal of a stuck Client by a minute. The bound is the
  heartbeat window, so a longer wait would need a heartbeat change, which is out of scope.
- **Notice storms.** Correction adds messages. Each notice keeps its deterministic id and its "once per cause" rule.
- **Semantics of `accepted`.** Callers that treated `accepted` as "the Client has it" now get it earlier. Managed
  instructions and the CLI output say what it means (L1).
- **Migrations on a large table.** Option B of D1 and phase 6 write `session_messages` and `agent_schedules`; both
  follow [Database read/write standards](../database-read-write-standards.md#migrations) and are sequenced with #1353
  and #1413.
- **Single replica.** Late-receipt maps and hold bookkeeping stay in one Server process, as today. The design does not
  make multi-replica delivery possible; it does not make it harder either, because every state is in the database.

## Validation

- **Unit and controlled transport**: the #1513 style of test (a receipt at 89 seconds, one after the window, a
  duplicate receipt, a Server restart, overlapping windows) for every kind, plus the hold and redelivery paths of
  #1353.
- **Session Lab** (local): a stalled Server-to-Client link of 60 seconds and of 120 seconds for `session send`, a
  scheduled occurrence, and an IM message, each started at the reconcile and again after the message frame left; a
  Client upgrade during each; a Server restart between a schedule claim and its dispatch; a replay with the same
  `--message-id` after `unknown`, once against a succeeded record and once against a failed one.
- **IM Lab** (local): offline, queued, expiry, and corrected scheduled-task messages on Feishu and Slack; one message
  per cause.
- **Cloud** (staging): a cold allocation under a scheduled occurrence, an allocation retired while a Session message is
  journaled, and the notice the sender receives.
- **Regression catalogue**: `testing/regression/scheduled-tasks.md` gains the late-receipt, held, and corrected cases;
  `testing/regression/session-recovery.md` gains the held-redelivery cases.

## Decision points

Infrastructure and database (yuezengwu):

- **D1** Session message state storage: Option A (codes plus partial index, as #1353) first and Option B (columns)
  later, or B from the start.
- **D2** Whether an `unconfirmed` Local hand-off (sent, no receipt inside the window) is redelivered like a held one,
  relying on Client deduplication, or stays final as today.
- **D3** The receipt window equals the heartbeat window (90 s Local, 45 s Runner). Whether either heartbeat window
  should change is a separate question this design does not raise.
- **D4** Durable scheduled hand-off across a Server restart (phase 6): persist the dispatch intent at claim, with a
  stale-claim sweep, or accept the current loss.
- **D5** Client inbox pruning and file format: prune finished records after the hold limit plus a grace, and stop
  rewriting the file whole.
- **D6** The Cloud `allocation_retired` settlement notifies the sender (phase 4).
- **D7** Migration sequencing with #1353 and #1413.

Product and IM wording (Gandy):

- **G1** Whether a "may not have run" or "didn't run" message is corrected when the occurrence later runs, and whether
  the correction edits the message or follows up in the conversation; the wording of both.
- **G2** How the CLI answer and the Web schedule summary describe a held message ("waiting for the computer").
- **G3** Whether a held scheduled occurrence may still run after its hold ends (today's #1353 drops it once the next
  occurrence is claimed).

Agent configuration and security (刘超):

- **L1** The managed-instruction text that tells Agents what `accepted` means and when to retry with `--message-id`.
- **L2** Whether Agents are told, in the prompt, that a message is held and may arrive late.
