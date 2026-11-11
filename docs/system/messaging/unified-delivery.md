---
title: "Unified delivery model"
description: "Design for one delivery record shared by IM, Session, and scheduled messages: its fields, its states and their writers, how each kind maps onto it, a one-shot rollout with compatibility and rollback, risks, and decision points."
soft_links:
  - /system/messaging/server-client-delivery.md
  - /system/server-client-boundary.md
  - /system/database-read-write-standards.md
---

# Unified delivery model

> **Proposal under review, not a decision.** Once the owners under [Decision points](#decision-points) decide, this
> page is rewritten under the fixed `Planned — not yet implemented` marker with a tracking issue, and the rejected
> options are removed.

[Server-to-Client delivery](server-client-delivery.md) compares the three hand-offs and lists eleven gaps. They share
one cause: three bookkeeping schemes for the same question. This design keeps one of them. The IM delivery record
already holds every hand-off fact (frozen frame, custody, report, retry, deadline, parking); Session and scheduled
messages become rows in it with a few kind-specific fields and are processed by the existing delivery worker. Current
behavior is on the comparison page and is not repeated here.

## One record

`im_message_deliveries` becomes the delivery record for every kind; the table keeps its name. `im_messages` and
`session_messages` stay message bodies (what was said, by whom, when) and never hold hand-off state.

| Field | Meaning | IM | Session | Scheduled |
| --- | --- | --- | --- | --- |
| `id`, `session_id`, `placement_generation`, `execution_origin` | delivery identity, target, and where it executes | as today | same | same |
| `kind` (new, default `im`) | which body table and which policies apply | `im` | `session` | `scheduled` |
| `message_id` (becomes nullable) | the `im_messages` body | set | null | null |
| `session_message_id` (new) | the `session_messages` body: content, source, `scheduled_origin` | null | set | set |
| `schedule_id` (new, no FK) | supersession lookup for the next occurrence | null | null | set |
| `attention`, `steer_target_delivery_id`, `steered_at` | IM input semantics, batches, Server-side steer | as today | null | null |
| `state`, `reason`, `attempt_count`, `next_attempt_at`, `last_error_code` | the shared state machine and worker bookkeeping | as today | same | same |
| `expires_at` | the last moment the Server still tries | ingress deadline, 7 d or 24 h | hold limit, 24 h | next trigger, or 24 h for a one-off |
| `dispatch_request_id`, `dispatch_input_hash`, `dispatch_payload` | the frozen frame, persisted before it leaves and resent as is | `im:deliver`, `im:steer` | `session:message:deliver` | the same frame with `scheduledOrigin` |
| `input_hash`, `accepted_at`, `report_owner_instance_id` | custody once the Client or Runner answered | as today | same | same |
| `turn_id`, `turn_report`, `result_hash` | the Turn and its report | as today | null; the Run outcome report writes `reported_at` and `last_error_code` | same as Session |
| `reported_at` | execution settled | as today | same | same |

## States and their writers

The state enum is unchanged. Two conditions the comparison page names, `unconfirmed` and `held`, are not states:
they are a `pending` row with a frozen frame whose request timer passed, and a `pending` row without a frame whose
`last_error_code` says the runtime is unavailable. The Web and CLI derive them from those columns.

| State | Meaning | Written by |
| --- | --- | --- |
| `pending` | recorded; with a frozen frame the frame was sent and is resent unchanged on every retry; `last_error_code` carries the backoff reason or `IM_DELIVERY_PARKED` | ingress inserts it (IM Inbox, `session send` and `session create`, the schedule claim); the delivery worker writes the frame and the backoff |
| `accepted` | the Client or Runner persisted the input and answered; execution is theirs | the custody store on `im:deliver:result`, `session:message:deliver:result`, `delivery:received`, or `session:message:received`, including a receipt that arrives after the request timer |
| `steered` | IM only: joined a running Turn through `im:steer` | the custody store |
| `expired` | `reason` is `ttl` (past `expires_at`), `superseded` (the next occurrence was claimed), `capacity`, or `duplicate_pending` | the janitor; the schedule claim writes `superseded`; the IM Inbox writes the last two |
| `terminal_rejected` | a permanent refusal: the Client's reason, `retry_exhausted`, `target_stopped`, or a schedule pause, edit, or delete | the worker on a terminal receipt or exhaustion; `session stop`; the schedule admission |

After `accepted`, settlement writes `reported_at` (for IM also `turn_report`); the report cutoffs and recovery stay as
they are. A late receipt moves a `pending` row with a frame to `accepted` whenever it arrives, for every kind, through
the worker's existing late-result map.

## How each kind uses the record

| | IM | Session | Scheduled |
| --- | --- | --- | --- |
| Recorded by | the IM Inbox, as today | `session send` and `session create` insert the body and the delivery row in one transaction, run one immediate worker attempt bounded by 5 seconds, and answer `accepted` (openTag has the message) or `rejected` | the schedule claim inserts the body and the delivery row; the one-shot attempt fence disappears |
| Frame and receipt | unchanged | `session:message:deliver` and its result, unchanged | the v3 frame with `scheduledOrigin`, unchanged |
| Retry before acceptance | the worker's capped backoff, offline term, reconnect wakeup, parking, until `expires_at` | the same, until the 24-hour limit | the same, until the next trigger |
| Running Turn | `im:steer` from the Server | the worker skips the custody fence for this kind and sends the frame; the Client inbox queues or steers as today | same as Session |
| Queue capacity | 99 pending per Session, as today | 256 pending per target Session | 256 |
| Terminal notice | IM feedback, unchanged | one delivery-failure notice to the sender on `expired` or `terminal_rejected`; Run outcome notices unchanged | the "didn't run" message on `expired` or `terminal_rejected`, once per cause; a failed Run posts as today |
| Old readers | unchanged | `session_messages.last_outcome`, `last_error_code`, `attempt_count` are written as a projection of the row in the same transaction | `agent_schedules.last_dispatch` is written as a projection of the row |
| Cloud | the Cloud coordinator, unchanged | the coordinator sends `session:message:run` and takes custody on the Runner receipt; `runtime_durable_work` stays the Runner-side mirror | same as Session |

What this removes: the scheduled preparation and receipt budgets (60, 90, 280, and 20 seconds), the
`delivery_timeout` and `delivery_uncertain` outcomes, the "may not have run" notice and any need to correct it, the
`unknown` outcome of a Local `session send`, and the separate held-delivery worker of
[#1353](https://github.com/first-tree-ai/opentag/pull/1353): a row that was sent but not answered is retried with the
same frame and settled by the late receipt, exactly as an IM delivery is today.

## One-shot rollout

- **One additive migration, no backfill, no data move.** Add `kind` with default `im` (a fast default), drop the
  `NOT NULL` on `message_id`, add nullable `session_message_id` and `schedule_id`, add a partial index on
  `(schedule_id)` for `pending` scheduled rows, and rewrite the two check constraints so that `kind <> 'im'` needs no
  `attention`, `turn_id`, or `turn_report`. The constraints are added `NOT VALID` and validated in the same
  migration; validation does not block writes but scans the table, so it is measured against production row counts
  before the release (D6).
- **The same release switches the writers.** `session send`, `session create`, and the schedule claim insert delivery
  rows; the collaboration service and scheduler hand dispatch to the worker; the worker, custody store, janitor, and
  notifier read `kind` and apply the policies above. Deploying drains the old process first, so no hand-off is left
  half-written.
- **Old data stays as it is.** A `session_messages` row recorded before the release has no delivery row and keeps its
  final `last_outcome`. A replay of such a message id inserts its first delivery row. Nothing is rewritten.
- **Old Clients need nothing.** Frames, result frames, and capability versions are unchanged. A Client that cannot take
  a frame yet (below collaboration v3 for a scheduled frame, or mid-upgrade) leaves the row `pending` with a backoff
  code until it can or the row expires, as `IM_DELIVERY_RUNTIME_UPGRADE_REQUIRED` does today.
- **Rollback is a Server redeploy.** The previous Server ignores the new columns. Its worker joins `im_messages`, so
  it never claims a `kind <> 'im'` row; its janitor expires their `pending` rows at `expires_at` without a notice;
  `accepted` rows already live on the Client. The loss is the Session and scheduled hand-offs pending at that moment,
  bounded by the 24-hour limit and visible as an `unknown` projection. The migration is not reverted.

## Risks

- Constraint validation on a large table: the only non-instant step of the migration (D6).
- Session messages now wait on the Server instead of failing fast: a sender gets `accepted` for a target whose
  Computer stays offline for a day; the CLI output and the managed instructions must say so (G2, L1).
- The custody fence: Session rows must skip it or they wait behind the Session's IM Turn; the Client inbox keeps
  steering them.
- Double execution on a resend is bounded as for IM today: the same frozen frame, Client deduplication by message id
  and hash, and a terminal Client answer recorded as `terminal_rejected` with the Client's reason.
- A rollback silently expires pending Session and scheduled rows.
- Single Server replica, as today.

## Decision points

Infrastructure and database (yuezengwu): **D1** extend `im_message_deliveries` in place rather than a new table, which
would move IM rows; **D2** keep `session_messages.last_outcome` and `agent_schedules.last_dispatch` as projections
written from the delivery row; **D3** the per-kind limits (24-hour hold, 256 per target, next trigger as the scheduled
deadline); **D4** #1353: merge as an interim or close in favor of this design, which removes its held-delivery worker;
**D5** Cloud Session and scheduled dispatch through the Cloud coordinator; **D6** the constraint validation approach
and its measured cost.

Product and IM wording (Gandy): **G1** the sender's delivery-failure notice and the "didn't run" message on an expired
or superseded occurrence; **G2** how the CLI and the Web describe a message the Server still holds.

Agent configuration and security (刘超): **L1** the managed-instruction text for `accepted` and `--message-id`
retries; **L2** whether Agents are told that a message is queued and may arrive late.
