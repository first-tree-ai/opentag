---
title: "Server-to-Client delivery"
description: "How IM, Session, and scheduled messages travel from the Server to a Local Client or Cloud Runner, compared side by side: records, frames, receipts, waits, timeouts, retries, Client deduplication, restart recovery, and failure notices."
soft_links:
  - /system/server-client-boundary.md
  - /system/runtime/runtime-protocol.md
  - /system/cloud/cloud-runner-execution.md
---

# Server-to-Client delivery

Three kinds of input reach an Agent Session from the Server: an IM message, a Session message sent by another
Session, and a scheduled message produced by a schedule. Each has its own page: [Message domains](message-domains.md)
and [IM delivery claim queries](im-delivery-claim.md) for IM, [Internal Session collaboration](internal-session-collaboration.md)
for Session messages, and [Scheduled tasks](im-feedback.md#scheduled-tasks) for schedules. This page compares the three
hand-offs on Local Computers and Cloud Runners: what the Server records, what it sends, what it waits for, what happens
when the wait ends, who retries, how the Client deduplicates, what survives a restart, and when people hear about a
failure. Code is the ground truth; the module paths name where each rule lives.

## Shared transport

A Local Computer has one daemon with one authenticated WebSocket (`packages/server/src/runtime/runtime-session.ts`,
`packages/client/src/runtime/runtime-connection.ts`). Business frames are request and result pairs correlated by
`requestId` in `RuntimeDomainOwner` (`packages/server/src/runtime/runtime-domain-owner.ts`), which keeps a pending
entry per request with a 30-second timer (`requestTimeoutMs`) and rejects the request with `timeout` when no result
arrives. The pending map, the completed-result cache, and the IM late-result map hold at most 1,024 entries each.

- A result that arrives after the timer fired is handled per kind. An `im:deliver:result` still records custody and
  settles the delivery, because the timed-out request stays in `#expiredDeliveries`. A `session:message:deliver:result`
  for a timed-out request is ignored (`#completeSessionMessage` only matches `#pending`), so the message row keeps the
  outcome the timeout wrote.
- Heartbeats run every 30 seconds. The Client terminates its socket after 90 seconds without a frame from the
  Server; the Server reads a Computer as offline after 90 seconds of silence and sweeps the stale socket. A connection
  that stalls for less than 90 seconds therefore delays frames and receipts without a reconnect; a longer stall ends
  the socket on both sides.
- Frames queued on a socket are never replayed on the next socket, and the Server registry refuses a send to a
  replaced instance or connection (`instance_replaced`, `unavailable`). After a reconnect only durable Server-side
  records bring work back: the IM delivery row is redispatched, a Session or scheduled message is not.

A Cloud Session has a per-Sandbox Runner control channel (`packages/server/src/api/runner-connection.ts`, heartbeat
timeout 45 seconds). The Runner journals every input with fsync in trusted parent storage before it answers, executes
each message or delivery at most once, and re-announces its journal when it reconnects; see
[Cloud Runner execution](../cloud/cloud-runner-execution.md#e4-cloud-im-delivery-opt-in). The Server waits for a
Session message receipt in `CloudSessionCollaborationOwner`
(`packages/server/src/services/sandboxes/cloud-session-collaboration-owner.ts`, 30 seconds); for an IM delivery it
has no receipt wait at all, because custody is recorded whenever `delivery:received` arrives.

## Before the Client accepts

| | IM message | Session message | Scheduled message |
| --- | --- | --- | --- |
| Sender and trigger | The IM Inbox persists `im_messages` and a pending `im_message_deliveries` row. `ImDeliveryWorker` (`packages/server/src/runtime/im-delivery-worker.ts`) scans every 500 ms, claims due rows in 8 lanes, and renews a 15-second claim lease every 5 seconds. | `opentag session send` or `session create` from a Run. One HTTP call (30-second CLI timeout) authorizes the message, records it, and delivers it before answering (`packages/server/src/services/sessions/session-collaboration-service.ts`). | `ScheduleScheduler` (`packages/server/src/services/schedules/scheduler.ts`) scans every 5 seconds. A claim inside the 30-second window inserts the message row, writes the `unknown` summary, and advances `next_trigger_at` in one transaction; an occurrence more than 30 seconds late is skipped as `late`. At most 100 hand-offs are in flight. |
| Server record and identity | Delivery state `pending`, `accepted`, `steered`, `expired`, or `terminal_rejected`; `attempt_count`, `next_attempt_at`, and `expires_at`, the ingress deadline (7 days for direct, 24 hours for ambient input). The dispatch correlation (request id, input hash, frozen payload) is persisted before the frame leaves. | `session_messages.last_outcome` is `unknown`, `accepted`, `unreachable`, or `rejected`, with `last_error_code`. Each attempt moves `attempt_count` once; a message already `accepted` or `rejected` is answered from the row without another attempt. | The same table with `scheduled_origin` and a UUIDv5 id over the schedule and the instant. The single hand-off moves `attempt_count` from 0 to 1 and is never repeated. The schedule's `last_dispatch` describes only the latest occurrence. |
| Local frames | `session:reconcile` (ready, with the runtime snapshot), then `im:deliver`, or `im:steer` into the running Turn. The whole attempt runs under a 30-second operation deadline; each request has its own 30 seconds. | `session:reconcile` carrying the message inline when the Client negotiated `runtime.sessionMessageReconcile`, otherwise reconcile then `session:message:deliver`. Each request has 30 seconds and the two run in sequence with no overall budget. | Reconcile, retried every 5 seconds on a transient failure within the 60-second preparation budget, then `session:message:deliver` v3 with `scheduledOrigin` and `sentAt`. The final admission holds the Agent, binding, Session, placement, Computer, and schedule row locks until the transport marks the send, at most 5 seconds (`dispatch_not_marked`). |
| Cloud frames | Ensure the Sandbox and its allocation, then `delivery:run` with `deadlineAt` equal to the Run budget; `delivery:received` records custody and `delivery:verified` carries the model grant (`packages/server/src/runtime/im-delivery-cloud.ts`, `packages/server/src/services/sandboxes/cloud-delivery-owner.ts`). | Dispatches to one target Session are serialized. The owner ensures a ready Runner (20 seconds), sends `session:message:run`, and waits 30 seconds for `session:message:received`; an accepted receipt writes the durable work record and `accepted` before `session:message:verified` leaves. | The same frames with a 250-second readiness wait inside a 280-second budget; 20 seconds when the 75 shared extended slots are busy. |
| Client receipt | `im:deliver:result` with `accepted` and a `turnId`, `absorbed` into a running Turn, or `rejected` with a reason. The Client records custody in the Session binding and writes the Turn's retry input before it answers (`packages/client/src/runtime/turn-custody-owner.ts`). | `session:message:deliver:result` with `accepted` or `rejected`. The inbox writes the record to `runtime/durability/session-message.json` before it answers (`packages/client/src/runtime/session-message-inbox.ts`). | The same frame. A connection that did not negotiate `runtime.sessionCollaboration` v3 refuses it with `configuration_unsupported`. |
| Wait and timeout outcome | The 30-second operation deadline records `IM_DELIVERY_OPERATION_TIMEOUT` and releases the dispatch with its correlation kept, so the next claim resends the same frame. A late acceptance still records custody. | 30 seconds per request. A timeout after the frame left is `unknown / delivery_timeout`; a refusal before it left is `unreachable / runtime_unavailable`. A Client refusal with `client_busy`, `session_busy`, or `agent_busy` is `unreachable`; `stale_generation`, `session_not_ready`, `stale_configuration`, and `session_recovery_required` are `unreachable / runtime_not_ready`; every other reason is `rejected`. | Local: 60 seconds from dispatch entry through the send mark, then a 90-second receipt wait (`LOCAL_SCHEDULE_RECEIPT_TIMEOUT_MS`). A timeout after the send is `unknown / delivery_timeout`; before the send, `unreachable / delivery_timeout`. Cloud: the 280-second or 20-second budget; a failure after the send is `unknown / delivery_uncertain`, except an explicit `client_busy`. The budget also ends at the next trigger. |
| Who retries before acceptance | The Server, until `expires_at`: 2, 4, 8, 16, then 30 seconds, raised by one second per 8 seconds of Computer silence up to 30 minutes; a reconnect makes parked retries due (`packages/server/src/runtime/im-delivery-retry.ts`). Eight consecutive operation timeouts end as `terminal_rejected / retry_exhausted`, or park a correlated dispatch. | Nobody. The caller decides whether to resend with the same `--message-id`; the row is fenced for a new attempt and the Client answers a replay from its durable record. | Nobody. A sent occurrence is never resent, and the next occurrence is the next chance. |

## After the Client accepts

| | IM message | Session message | Scheduled message |
| --- | --- | --- | --- |
| Owner | The Client daemon or Runner. The Server never dispatches accepted input again; see [Delivery and execution responsibility](../server-client-boundary.md#delivery-and-execution-responsibility). | The same. `accepted` means the inbox holds the message, not that the task ran. | The same. |
| Client deduplication | `TurnCustodyOwner` remembers 512 request ids. A repeated delivery id with the same input hash gets the earlier decision; a different hash is `input_conflict`. Custody lives in the Session binding store and the retry input under `data/runtime/turn-retries/`. | The inbox keys records by `targetSessionId:messageId` with a semantic hash, remembers 512 answers, and never prunes finished `session-message` records, so a replay of any age answers `accepted` without a second Run. Capacity is 64 queued per Session and 256 in total; overflow is `client_busy`. | The same inbox; the hash covers the schedule, instant, timezone, and name instead of a source Session. |
| Restart recovery | The daemon reads the retry input and binding, counts the interruption, and sends `session:recover`; the Server moves report ownership and sends a ready reconcile. At most 2 automatic retries, as in [Automatic retry of accepted work](../server-client-boundary.md#automatic-retry-of-accepted-work). Accepted custody that no longer reports is settled `unknown` once the maximum runtime plus one hour has passed. Cloud: the Runner re-announces its journal; a lost allocation settles `unknown`. | A `running` record becomes `retryable` with its interruption and waits for the Server to prepare the Session: `session:recover` is answered within 30 seconds or resent after 10 seconds, a `scheduled` answer must produce the reconcile within 60 seconds, and 30 attempts end in failure with a notice (`packages/client/src/runtime/interrupted-work-recovery.ts`). Cloud: re-announced custody is re-verified; a record whose allocation is gone is settled `failed / allocation_retired`. | The same as a Session message. |
| Failure notice and correction | A working reaction on acceptance; an offline card after 60 seconds on an offline Local Computer, once per outage; a queued card behind a parked dispatch; a failure card on the terminal report; an expiry card at the ingress deadline. A later completion updates or suppresses the expiry card. See [IM task feedback](im-feedback.md). | The sender gets a Run outcome notice only after a terminal non-completed Run: Local through the durable `session:message:outcome` reporter (resent for 24 hours, 5 seconds to 5 minutes between attempts, 120-second acknowledgement timer); Cloud through 3 attempts 30 seconds apart before the settlement is acknowledged. An `unreachable` or `unknown` hand-off produces no notice; the command's answer is the only signal. | The conversation hears one message per cause, compared with the previous occurrence: `unknown` with a code reads "may not have run", `unreachable`, `rejected`, or `skipped` reads "didn't run", and a disabled schedule says so. The send gets 3 in-process attempts; an internal target gets nothing. A failed Run posts its own failure message. No message is edited or followed up when the occurrence is accepted or completes later. |

## Timing boundaries

| Boundary | Value | Where |
| --- | --- | --- |
| Local heartbeat interval and silence timeout | 30 s, 90 s | `runtime-session.ts` welcome; `runtime-connection.ts` silence timer; `services/computers/cloud-computer.ts` presence |
| Runner heartbeat timeout | 45 s | `api/runner-connection.ts` |
| Runtime request timeout | 30 s | `runtime-domain-owner.ts` `requestTimeoutMs` |
| Local scheduled receipt wait | 90 s | `runtime-domain-owner.ts` `LOCAL_SCHEDULE_RECEIPT_TIMEOUT_MS` |
| IM operation deadline and late-settle grace | 30 s, 1 s | `im-delivery-worker.ts`, `im-delivery-deadline.ts` |
| IM retry schedule, offline term, cap | 2–30 s, 1 s per 8 s silent, 30 min | `im-delivery-retry.ts` |
| IM consecutive operation timeouts before termination or parking | 8 | `im-delivery-retry.ts` |
| IM ingress deadline | 7 d direct, 24 h ambient | `services/im/im-message-inbox.ts` |
| Accepted report window | maximum runtime + 1 h | `im-delivery-retry.ts`, `cloud-delivery-owner.ts` |
| Schedule scan, claim window, in-flight slots | 5 s, 30 s, 100 | `schedules/scheduler.ts` |
| Scheduled preparation budgets | Local 60 s (retry 5 s); Cloud 280 s or 20 s; 75 extended slots | `session-collaboration-service.ts` |
| Scheduled admission send mark | 5 s | `sessions/session-service.ts` `SCHEDULED_SEND_MARK_TIMEOUT_MS` |
| Cloud Session message receipt, readiness waits | 30 s; 20 s, 250 s (poll 500 ms) | `cloud-session-collaboration-owner.ts` |
| Cloud Run outcome notice attempts | 3, 30 s apart | `cloud-session-collaboration-owner.ts` |
| Scheduled miss notice attempts | 3, 5–30 s apart | `schedules/scheduled-failure-notifier.ts` |
| Local Run outcome reporter | 5 s to 5 min backoff, 24 h, 120 s ack | `client/runtime/session-message-outcome-reporter.ts` |
| Session recovery request | answer 30 s, resend 10 s, reconcile 60 s, 30 attempts | `client/runtime/interrupted-work-recovery.ts` |
| Session CLI request timeout | 30 s | `client/src/request-policy.ts` |
| Client Session inbox capacity and steer recheck | 64 per Session, 256 total, 512 remembered; 1 s | `client/runtime/session-message-inbox.ts` |

## A stalled link

When the Server-to-Client direction stalls while the socket stays open, the outcome depends only on how long the
stall lasts, because every wait above is a fixed timer rather than a transport fact:

- Under 30 seconds: every receipt arrives inside its request timer; nothing is recorded.
- Between 30 and 90 seconds: no heartbeat deadline fires, so neither side reconnects and the queued frames arrive when
  the link recovers. An IM delivery records an operation timeout and later applies the late acceptance. A Session
  message is recorded `unknown / delivery_timeout` while the Client goes on to run it, and the row never changes. A
  scheduled message waits out its 90-second receipt window and is recorded `accepted` when the receipt arrives inside
  it; a receipt after the window is ignored and the conversation hears "may not have run".
- 90 seconds or more: both sides end the socket; queued frames are lost. The IM delivery is redispatched on the new
  connection. A Session or scheduled message recorded `unknown` was indeed never received, and nothing resends it.

To tell which band an incident was in, read the schedule dispatch log `schedule.dispatched` (`scheduleId`,
`messageId`, `scheduledFor`, `outcome`, `code`), the `Runtime domain request failed` warning with its `code`, the
`runtime.reconcile` and `runtime.delivery` spans, and on the Client the inbox record's `sentAt` against its
`acceptedAt` plus the connection module's disconnect entries.

## Known gaps

Each item names where the behavior lives. None of them loses accepted work; they cost delays, duplicate hand-offs,
false alarms, or silence.

1. A late Session message receipt is dropped. `#completeSessionMessage` in `runtime-domain-owner.ts` matches only
   pending requests, unlike `#completeDelivery`, which keeps timed-out IM requests in `#expiredDeliveries`. The row
   stays `unknown` and a schedule's summary stays unconfirmed although the Client accepted and ran the message.
2. The ordinary Session message request timer (30 seconds) is shorter than the heartbeat window (90 seconds). Only
   the scheduled branch of `requestSessionMessageDelivery` uses the longer wait, so a stall between 30 and 90 seconds
   turns a delivered `session send` into `unknown / delivery_timeout`.
3. A `session send` can outlive its caller. `#deliverLocal` runs a 30-second reconcile and a 30-second delivery in
   sequence with no overall budget, while the CLI gives up after 30 seconds (`OPEN_TAG_API_REQUEST_TIMEOUT_MS`) and
   reports `unknown / transport_error`. The Server may then record `accepted` for a message whose sender already
   treats it as uncertain.
4. Nothing on the Server retries a Session or scheduled hand-off. `unreachable` ends the attempt in `#deliverLocal`
   and `#deliverCloud`; the scheduled fence in `beginScheduledMessageAttempt` allows one attempt. The sender's own
   `--message-id` replay and the next occurrence are the only retries, and a schedule that fires while its Computer
   is briefly offline has no later chance for that occurrence.
5. A scheduled hand-off is not durable across a Server restart or crash. `ScheduleScheduler.stop` aborts in-flight
   dispatches, and a claim committed just before the stop is never dispatched: the row keeps the claim's code-less
   `unknown`, which produces no notice and no retry.
6. Frames queued on a socket do not survive a reconnect, so a Session or scheduled frame sent just before a stall of
   90 seconds or more is lost even though the Server recorded it as sent. IM deliveries survive only because the
   worker redispatches the persisted row.
7. Notices are best effort in memory. `notifyMissed` makes 3 attempts and a Server stop or IM outage loses the
   message; the scheduled Run failure path remembers its send results in `#results` with a 1,024-entry cap, so a
   forgotten result or a restart can post the failure twice where the provider does not deduplicate by request id.
8. A miss notice is never corrected. Nothing in `scheduled-failure-notifier.ts` edits or follows up "may not have
   run" when the occurrence is later accepted or its Run completes; `#recordRunFailure` only rewrites the schedule
   summary.
9. Deduplication differs by kind. IM input is deduplicated by request id and delivery id with an input hash in
   `TurnCustodyOwner` and by custody in the Session binding store; Session and scheduled input by
   `targetSessionId:messageId` with a semantic hash in the inbox, whose finished records are never pruned and whose
   file is rewritten whole on every write. Capacities differ too: 99 pending IM inputs per Session on the Server
   against 64 queued Session messages per Session and 256 in total on the Client.
10. A Cloud Session message whose allocation is lost is settled `failed / allocation_retired` by
    `#reconcileSessionWork` without a Run outcome notice; only `handleSettled` notifies, and it needs a Runner
    settlement that this path never receives.
11. There is one receipt policy per path. Request 30 seconds, scheduled receipt 90 seconds, IM operation 30 seconds,
    Cloud receipt 30 seconds, Cloud readiness 20 or 250 seconds, scheduled budgets 60, 280, or 20 seconds, and the
    5-second send mark are set in five modules with no shared relation to the heartbeat windows they depend on.
