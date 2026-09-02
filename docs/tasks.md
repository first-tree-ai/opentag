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
thread key only once its topic actually has a reply chain; a private chat and a request nobody
replied to report `sessionKind: "channel"` with no thread key, so the Web labels them by the
conversation they came from.

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
   deliveries), or `expired` (a delivery that expired unprocessed, or an unreported Turn whose
   deadline has passed).

## Titles

A Task is titled from its root message through the same derivation the list always used: routing
syntax is removed, the addressed Bot mention is dropped, and the text is bounded. A manual or
generated title stored on the topic's thread Session, or on a private chat's channel Session,
overrides it.

`PATCH /api/v1/sessions/:id` sets or clears the manual title. The id may be the Task id or one of
its Sessions; the title is written to the Session the Task reads it from. A top-level group request
that nobody replied to has no such Session and returns `404`.

## Internal Sessions and collaboration messages

A Task includes the internal Sessions that inherited its scope (channel and thread key, or the
private chat) from a thread or private-chat Session, plus the internal Sessions a group's channel
Session created while one of the topic's Turns was running, with their descendants. Collaboration
messages are those exchanged by the topic's own Sessions and its internal Sessions.

## Boundaries

- Outbound messages are not observed, so a Task cannot say whether the Agent replied; it records
  what was asked and how each Turn ended.
- A crashed Turn on a group's channel Session stays `running` until that Session accepts another
  delivery or the delivery deadline passes.
- The list is computed per request from the Account's stored messages. Rollups decide the page
  before any row resolves its title or Sessions; very large Accounts may later need an index on the
  topic key.
