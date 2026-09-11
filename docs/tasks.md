# Tasks

[简体中文](./zh-CN/tasks.md)

A Task is the Account owner's read-only view of one piece of work that people asked an Agent to do in
Feishu or Slack. It is a projection over the stored inbound `ImMessage` records and their
`im_message_deliveries`; nothing about message delivery, Session materialization, or the Agent
Runtime changes because of it. The Task API lives at `/api/v1/sessions` for compatibility, but its
rows are topics, not Sessions.

## What one Task is

- In a group, channel, or multi-person direct message, a Task is one **topic**: the root message
  plus the reply chain around it. The topic key is `coalesce(thread root, thread_key,
  external_message_id)`. Slack's `thread_ts` is the root message's own id. Feishu threads are keyed
  by `thread_id` when the provider supplies one and by `root_id` otherwise; when a reply carries a
  `thread_id` that differs from its `rootId`, the topic is keyed by the root message so the root and
  its replies stay together.
- In a private chat, the whole conversation is one Task.
- A topic becomes a Task only once somebody addressed the Agent directly. Messages the Agent only
  overheard (`ambient` attention) are conversation context, not Tasks, and are not counted.
- The Task id is the id of the topic's earliest stored message. The detail endpoint accepts the id
  of any message in the topic and reports the canonical id. `createdAt` is the root message's time.

The Account's channel Session for a group is therefore never listed as a Task; a top-level request
that nobody replied to is a topic of one message. A Task reports `sessionKind: "thread"` and its
thread key once a message in its topic carries a thread key, which is the first reply for Slack
and an ordinary Feishu group, and the root itself in a Feishu topic group; a private chat and a
request nobody replied to report `sessionKind: "channel"` with no thread key, so the Web labels
them by the conversation they came from.

## Executions and status

The Task detail lists the deliveries of the topic's messages as its executions, newest first. Two
kinds of delivery are left out: the channel Session's `ambient` observer copy of a message that a
thread Session owns, and a delivery expired because a newer revision of its message superseded it.
A message steered into a running Turn is shown as absorbed by that Turn and shares its report.

The status is the topic's latest execution situation, read by precedence:

1. `ended` when the Session the topic reads from has ended (the Integration was disabled).
2. `running` when a delivery is accepted and unreported, its deadline has not passed, its Session is
   alive, and no later Turn was accepted in that Session. A Session runs one Turn at a time, so a
   later acceptance proves the earlier one ended without a report.
3. `queued` when a delivery is still pending.
4. Otherwise the outcome of the latest execution: `completed`, `failed` (including rejected
   deliveries), `cancelled` (a queued delivery the Account withdrew before it ran), or `expired` (a
   delivery that expired unprocessed, or an unreported Turn whose deadline has passed).

Each detail Turn exposes `delivery.isRunning` from the same effective predicate as the list. The Web
shows progress only when that value is true; persisted `accepted` alone does not prove liveness.
An unreported inactive Turn, including data from older servers that omit the field, shows that no
execution report is available.

## Titles

A Task is titled from its root message through the same derivation the list always used: routing
syntax is removed, the addressed Bot mention is dropped, and the text is bounded, with an ellipsis
marking a cut. A manual or generated title stored on the topic's thread Session, or on a private
chat's channel Session, overrides it.

`PATCH /api/v1/sessions/:id` sets or clears the manual title. The id may be the Task id or one of
its Sessions; the title is written to the Session the Task reads it from. A top-level group request
that nobody replied to has no such Session and returns `404`.

## Cancelling a queued Task

`POST /api/v1/sessions/:id/cancel` withdraws a Task that is still `queued`. The id may be the Task
id or one of its Sessions. The withdrawal is all or nothing: every pending delivery of the topic is
expired with reason `cancelled`, its `expiresAt` set to the instant of the cancel, or none of them
is touched. The delivery worker claims only pending rows and recovers expired ones only while they
carry a dispatch correlation, so a withdrawn delivery is never picked up later. The cancel instant
is the withdrawn delivery's activity, and so the topic's latest activity: the response carries the
refreshed Task summary with status `cancelled`, even when an earlier Turn of the topic finished
after the withdrawn message arrived, and the status stays `cancelled` until a later Turn runs in
the topic. A `200` therefore always means that every queued delivery of the topic was withdrawn
and the Task reads `cancelled`; a topic with a running Turn, or with a delivery a worker is
dispatching, answers `409` and nothing of it is withdrawn.

Only a queued Task cancels. A Task that is `running`, or that already finished, answers `409
TASK_NOT_QUEUED`, and so does a queued Task any of whose pending deliveries a worker is dispatching
at that moment — the Runtime may already be running it, and the rest of the queue is left in place
with it rather than withdrawn around it. The pending rows are locked for the check and the update,
so a worker that starts on one of them while the cancel is under way makes the whole cancel a `409`
too. The Web refreshes the Task on that answer instead of reporting a failure, and tells the two
apart by what the refresh shows: a Task that left the queue is announced as "no longer queued",
while one still `queued` — its message on its way to the Agent — is announced as not cancelled, and
keeps its cancel control. A success is announced from the returned status the same way. Cancelling
a Task that is already `cancelled` is a no-op success, so repeating the request is harmless.

## Internal Sessions and collaboration messages

A Task includes the internal Sessions that inherited its scope (channel and thread key, or the
private chat) from a thread or private-chat Session, plus the internal Sessions a group's channel
Session created while one of the topic's Turns was running, with their descendants. Collaboration
messages are those exchanged by the topic's own Sessions and its internal Sessions.

## Boundaries

- Task reply history uses captured successful Lark outbound receipts from the originating Turn
  report when that snapshot is present. `finalText` is only an execution summary, never a substitute
  sent reply. A complete capture with no recorded send, or a legacy report without a snapshot, has an accurate
  empty or unavailable state rather than “in progress.” Slack is not collected as Lark. Send receipts
  are not read receipts. Partial capture is labelled independently of the number of replies; content
  truncation and native post/card details remain visible. Replies become available with the terminal
  report and are not backfilled from old runtime transcripts.
- The unavailable Lark-reply notice is limited to Feishu/Lark Tasks. Slack Tasks retain their execution
  summaries without a permanent notice about a capture feature they do not support.
- Reply snapshots require `runtime.turnReport` v2 on the current connection. A report created on v2
  remains durable during a v1 reconnect and resumes unchanged after v2 is negotiated again. A v2
  server rejects an unnegotiated snapshot with a nonfatal `unsupported_capability` report result.
- A crashed Turn on a group's channel Session stays `running` until that Session accepts another
  delivery or the delivery deadline passes.
- The list is computed per request from the Account's stored messages. Rollups decide the page
  before any row resolves its title or Sessions; very large Accounts may later need an index on the
  topic key.
