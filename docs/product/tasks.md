---
title: "Tasks"
description: "The Account owner's read-only Task view over IM requests: what one Task is, execution status, titles, and cancellation."
---

# Tasks

A Task is the Account owner's read-only view of one piece of work that people asked an Agent to do in
Feishu or Slack. It is a projection over one chat Session's stored inbound `ImMessage` records and
their `im_message_deliveries`; nothing about message delivery, Session materialization, or the
Agent Runtime changes because of it. The Task API lives at `/api/v1/sessions`, and each of its rows
is one chat Session.

## What one Task is

- A group's channel Session is one Task, however many top-level requests it received, so one
  group conversation reads as one Task rather than one per request.
- Each thread Session is its own Task. A Slack thread or a Feishu thread (keyed by `thread_id`)
  that somebody answered in therefore reads separately from the channel it started in. The root
  message stays in the channel Session's Task because the channel Session received it. A Feishu
  quote reply in an ordinary group carries `root_id` and `parent_id` but no `thread_id`, so it has
  no thread key and belongs to the group's channel Session's Task; `root_id` never names a Task. A Session
  that ended and was later replaced, such as a thread revived after its Session ended, is a
  separate Task.
- A private chat is one Task across all of its Sessions, including a thread Session inside it. Its
  Task is read from its live Session first, preferring the channel Session to a thread.
- A channel Session becomes a Task only once somebody addressed the Agent directly in it. Messages
  the Agent only overheard (`ambient` attention) are conversation context, not Tasks, and are not
  counted. A thread Session is a Task once somebody addressed the Agent in the thread or in its
  root message, so a thread that continues a request without mentioning the Agent again is still
  listed. A delivery a newer revision of its message superseded counts for neither.
- A message belongs to the Session whose delivery executed it. The channel Session's `ambient`
  observer copy of a message a thread Session owns is not an execution of the channel Session.
- The Task id is its Session's id: the channel or thread Session, or the Session a private chat is
  read from. Every Task endpoint also accepts:
  - any message id of the Task, including the earliest-message ids that older Task links used;
  - another Session of a private chat;
  - an internal Session id, which opens the Task of the chat Session at the root of its creator
    chain.

  Each endpoint reports the canonical id.
- Outbound IM replies sent through the Server provider proxy append a clickable `Session <shortId>`
  footer linking to `/agents/:agentId/tasks/:sessionId` for the Session that sent them. Group channel
  executions and internal Sessions link too, because the Task routes resolve those Session ids to
  their Task. A footer links only when that Task qualifies under the same rule the Task list and
  detail use, so an emitted link never opens a 404: an ambient-only group channel Session, an
  internal Session whose creator chain reaches one, or a Session that cannot be found gets plain
  `Session <shortId>` text. The check runs before every annotated provider write, so it never reads
  the Task's status rollup: it resolves the Session's Task once and asks whether a qualifying
  delivery exists through a few bounded index-range probes, each stopping at its first match, so a
  Task costs the same whether it qualifies or holds only superseded deliveries, however long the
  history is. Footers that
  older replies carry anchor on a request's message id and keep resolving.
- `createdAt` is the earlier of the Session's creation and its first addressed message.

A Task reports `sessionKind: "thread"` and the Session's thread key for a group thread Session.
A group channel Session and a private chat report `sessionKind: "channel"` with no thread key, so
the Web labels them by the conversation they came from.

## Reading a Task

`GET /api/v1/sessions/:id` is the legacy complete detail: a Turn page bounded by `limit`, plus every
related Internal Session and collaboration message. It stays for readers written against that
contract and is not the contract new readers use, because its section arrays are not bounded.

`GET /api/v1/sessions/:id/detail` is the bounded detail: one page of the sections the caller names
in `sections` — all three when it names none — each with its own `nextCursor`. The three sections
also page independently at `/detail/turns`, `/detail/internal-sessions` and
`/detail/collaboration-messages`, so a reader that needs more of one section asks for that section
alone. Each section returns at most 100 rows and 20 by default. Naming a subset is the point of the
contract: the Web conversation renders the summary and the Turns and asks for `sections=turns`; it
reads the internal Sessions from their own section, page by page, and never reads the collaboration
history it does not show. Reading any of them
resolves the Task and serves the requested sections from one read-only Repeatable Read transaction,
so an authorized Task is read from a single snapshot and no wait spans external I/O. The captured-replies
subresource also resolves its Task and reads replies in one read-only snapshot. It reads chat
Sessions and stored IM messages only, never runtime execution state.

Captured outbound replies name no Session, so each one belongs to the Session that owned its thread
or channel when it was stored. In a private chat that is the chat's Task. In a group it is the
newest thread Session of the reply's thread that already existed, and otherwise the newest channel
Session that already existed. A Session created later never claims an earlier message, so a
message stored before any Session existed belongs to no Task. A reply the channel Session sent into a new thread before anybody answered there
therefore stays on the channel Session's Task. A captured reply to a Feishu quote reply is keyed by
the message it answers, never by the quote chain's `root_id`; that key names no thread Session, so
the reply stays on the channel Session's Task too. A captured reply that earlier versions stored in a
real Feishu thread with the thread's `thread_id` as its thread key but no recorded `threadId` still
matches that thread's Session by thread key, so it stays with the thread it was sent in.

Every section cursor is the exact ordering key of the last row it returned: the timestamp at the
microsecond precision PostgreSQL compares, not the millisecond a browser `Date` would keep, plus the
row id. An ascending page therefore never re-reads the row it just returned and a descending page
never steps over one; equal timestamps are ordered by id alone. The cursor is opaque and validated
strictly, and a cursor that does not match the expected shape is a `400`.

## Executions and status

The Task detail flattens the Session's messages and captured Agent replies into one oldest-to-newest
conversation, including private chats, group channels, and threads. In a group, the messages of every member
that the Agent received in the Session are shown, not only the requester's, because the Agent acted on that whole
context. User follow-ups appear between
replies according to their timestamps. Replies without a usable timestamp retain their captured
position beside neighbouring replies, or at report time when none have timestamps; no send time is
invented for display. Repeated delivery and reply identities across loaded pages appear once, while
distinct messages with identical text and stored message revisions remain separate.

**Load earlier activity** sits above the conversation. The API still retrieves the newest page first;
the Web combines all loaded pages before ordering messages, and keeps the visible message in place
when earlier history or a late report arrives. Task-list sorting is unchanged.

Two kinds of delivery are left out: the channel Session's `ambient` observer copy of a message that a
thread Session owns, and a delivery expired because a newer revision of its message superseded it.
A message steered into a running Turn gets a small annotation on the input; it does not create a
second Agent response or report.

The Task detail exists to diagnose how the Agent ran, so the conversation keeps only what helps that:
each reply once, failures, and gaps in the record. The message list is secondary to the Agent's status
and may shrink as that status becomes more explicit.

The runtime's final text (`finalText`) is not shown: it repeats the reply the Agent already sent, and it
never substitutes for captured sent replies. A Turn report appears in the conversation only when it adds
something the sent replies cannot show — an execution failure or an unavailable or incomplete reply
history; a completed report with nothing else to say leaves no entry, and a Turn that finished without
a reply gets no placeholder text. A Turn still running gets no Agent entry until it sends a real reply.
A repeated reply, an empty-state line or a "work in progress" line adds reading without telling the
reader anything new about the run; the Task's status already says whether it is running or completed. Sent reply bodies, captured
replies and legacy Lark text or rich-text receipts alike, render as chat Markdown: Markdown formatting
applies, a single newline stays a line break, and typed HTML stays literal text, as the IM displays it.
Truncated content remains visible. On Local Computers supporting detailed reports,
recognized provider failures explain authentication,
model access, credit or quota, rate limits, service availability, connection loss, context limits,
execution limits, rejected requests, or unexpected process exits. Unrecognized failures keep the
generic Provider failed label. Only fixed, translated explanations are shown; raw provider error
messages are not exposed. Cloud delivery retains the generic provider failure label for these
newer categories so saved outcomes remain compatible with older Servers.

Inbound attachments show their stored name, type, and any processing availability limitation. The
Task API projects metadata from existing message resources, omitting provider resource keys. Older
messages or Servers without attachment metadata still render normally. This adds no attachment
preview or download endpoint, quoted-message expansion, or source-conversation link.

The status is the Session's latest execution situation, read by precedence:

1. `ended` when the Task's Session has ended (the Integration was disabled).
2. `running` when a delivery is accepted and unreported, its deadline has not passed, its Session is
   alive, and no later Turn was accepted in that Session. A Session runs one Turn at a time, so a
   later acceptance proves the earlier one ended without a report.
3. `queued` when a delivery is still pending.
4. Otherwise the outcome of the latest execution: `completed`, `failed` (including rejected
   deliveries), `cancelled` (a queued delivery the Account withdrew before it ran), or `expired` (a
   delivery that expired unprocessed, or an unreported Turn whose deadline has passed).

The Web reads these in four groups (Queued, Running, Completed, Failed) for filtering: `ended` and
`cancelled` filter with Completed, and `expired` with Failed. A `cancelled` Task still shows its own
neutral **Cancelled** label rather than Completed. Why: the Account withdrew it before it ran, and
"Completed" would claim work that never happened.

### Message handling and failure recovery

Task status remains a projection over existing message and delivery records. The precedence and
terminal distinctions above, Task ordering, placement fences, immutable reports and delivery
idempotency remain authoritative; there is no new Task-status table or independent execution state.
New input follows the existing Session path: it is steered into the running Turn, which every Local
runtime (Codex, Pi, Claude Code) supports; a runtime without steer leaves it queued until the
current Turn settles. Local Session messages (`session send` callbacks, scheduled messages) steer
into a running Turn the same way. The Server does not yet force interruption or replay an accepted
Turn for a runtime that cannot steer.

Failure messages are plain text, as described in
[IM task feedback](../system/messaging/im-feedback.md). New Task Retry admissions are disabled;
the person sends a new message through the ordinary admission path. Previously admitted Retry
attempts and authenticated workspace save/discard recovery retain their original identities,
reports and confirmation requirements.

Each detail Turn exposes `delivery.isRunning` from the same effective predicate as the list. The Web
shows progress only when that value is true; persisted `accepted` alone does not prove liveness.
An unreported inactive Turn, including data from older servers that omit the field, shows that no
execution report is available.

## Titles

A Task is titled from its root message: a thread Session's thread root when it is stored, and
otherwise the earliest message somebody addressed to the Agent in the Task. The latest stored
revision of that message supplies the text. Routing syntax is removed, the addressed Bot mention is
dropped, and the text is bounded, with an ellipsis marking a cut. A manual or generated title
stored on the Task's Session overrides it.

`PATCH /api/v1/sessions/:id` sets or clears the manual title. The id may be anything that resolves
to the Task; the title is written to the Task's own Session, so a group channel Session can be
renamed like any other Task.

## Web presentation

The Task list retains the shared page title. Task titles in both Tasks and Overview use 14px regular
body text; column headings use 14px medium text, and source, Agent and activity-time values use 14px
regular text. Long list titles remain one line on wide containers and at most two lines on narrow
containers, with the full stored title available in the link's title attribute and on the detail page.

The detail title remains the page's `h1` and uses 16px medium text with a 24px line height and natural
wrapping. It displays the complete stored title without an additional clamp. Task facts retain their
order: in one column on the two-column layout, otherwise in two or three columns according to the content
container width. On an Agent's own Task page the facts leave out the Agent, because the page around them
already names it, and the one-column layout can use four columns. The Agent fact appears where Tasks from several Agents mix, and on an Agent's page
that shows another Agent's Task (a stale or mistyped link), where it is the only fact naming the Agent. Where the Agent fact
is shown, the start time spans both columns in the narrow layout so the complete date and time can wrap
without squeezing the other facts.

A running Task reads "运行中" ("Running") in Chinese everywhere, the same word the Agent list uses for its
running-Task count, so one state never has two names.

The conversation follows the facts without a visible Activity heading; its existing Activity heading
remains available to assistive technology. Requests and sent replies use 14px
regular text with a 21px line height. Authors use 14px medium text and timestamps use 12px regular
text. A message header carries no per-message status: a request shows its sender and its time — whether the
conversation is a private or group chat is the Task's source fact, not a per-message label; an Agent message shows the Agent and its time, plus the message
kind only for kinds other than plain or rich text, such as a card or an image. Execution outcomes are left to
the Task's status fact, failures to their explanation in the message body, and an unreported message
explains its state (pending, expired, cancelled or not processed) once, in the body; a message that
could not be processed reads in the failure colour, because the reader may need to act on it. Per-message status,
direct or ambient delivery, and plain-text kind labels repeated facts the page already shows once or did
not help diagnose the run, so they were noise on every line. Operational notices stay at 14px. Message headings, emphasis and monospace code retain their
content formatting. Wide code, native message payloads and message tables scroll locally, with named,
keyboard-focusable regions.

The detail page uses the same content frame as the other Agent pages, with the back link and title across
it. Once the content container reaches 56rem, the conversation takes a shrinkable main column and an 18rem
side column holds the Task facts stacked vertically, the cancel control and the internal Sessions. The side
column stays in view while the conversation scrolls, and scrolls on its own, with a keyboard stop, only when
it is taller than the window. Below 56rem the page is one column, with the overview above the conversation.
Why: this replaces the earlier rule that the facts and conversation all span the full frame. Facts and
internal Sessions above a long conversation scrolled out of sight, and the load-time scroll to the latest
message starts past them, so the status was hidden while reading the record. Lines across the whole frame
were also long to read. The side column keeps the outcome in view beside the record, and the conversation
column still fills the remaining width rather than becoming a narrow chat column beside empty space. The
56rem breakpoint rather than a larger one keeps two columns in a 1280px window, a common laptop width, where
the conversation column still has about 590px.

The overview comes before the conversation in the document at every width, so keyboard and screen reader
order is the back link, the title, the overview, then the conversation. On a wide page Tab therefore reaches
the right column first. This is deliberate: one order at every width reads the outcome before the record,
and placing the conversation first would put the facts after a long conversation on a narrow page.

A request's grey fill follows the width of its message: a long message still spreads across its column, and
Agent replies have no fill. Why: a one-line request in a column-wide panel read as a large empty box. Message
order, paging and scroll anchoring are unchanged.

## Cancelling a queued Task

`POST /api/v1/sessions/:id/cancel` withdraws a Task that is still `queued`. The id may be anything
that resolves to the Task. The withdrawal is all or nothing: every pending delivery of the Task's
Session is expired with reason `cancelled`, its `expiresAt` set to the instant of the cancel, or none of them
is touched. The delivery worker claims only pending rows and recovers expired ones only while they
carry a dispatch correlation, so a withdrawn delivery is never picked up later. The cancel instant
is the withdrawn delivery's activity, and so the Task's latest activity: the response carries the
refreshed Task summary with status `cancelled`, even when an earlier Turn of the Task finished
after the withdrawn message arrived, and the status stays `cancelled` until a later Turn runs in
the Session. The cancel holds the Task's IM binding against admission while it runs, the same row
every inbound admission locks before it queues a delivery: a message admitted before the cancel is
withdrawn with the rest, and one that arrives meanwhile waits and joins the queue after it, so a
message is never left queued beside a withdrawal. A `200` therefore always means that every queued
delivery of the Task was withdrawn and the Task reads `cancelled`; a Task with a running Turn, or with a delivery a worker is
dispatching, answers `409` and nothing of it is withdrawn.

Only a queued Task cancels. A Task that is `running`, or that already finished, answers `409
TASK_NOT_QUEUED`, and so does a queued Task any of whose pending deliveries a worker is dispatching
at that moment — the Runtime may already be running it, and the rest of the queue is left in place
with it rather than withdrawn around it. The pending rows are locked for the check and the update,
so a worker that starts on one of them while the cancel is under way makes the whole cancel a `409`
too — a row it claimed, accepted or steered meanwhile is a Turn in progress, not an exit from the
queue, and the messages queued behind it stay in place. A row that a worker rejected, or that
lapsed, while the cancel waited for the lock is left as
the worker wrote it, and the rows still pending beside it are withdrawn as usual; when nothing is
pending any more, the `409` names the status the Task now reads (`The Task is failed, not queued`).
The Web refreshes the Task on that answer instead of reporting a failure, and tells the two shapes
apart by what the refresh shows: a Task that left the queue is announced as "no longer queued",
while one still `queued` is announced as not cancelled yet — its delivery is in progress or awaiting
confirmation — and keeps its cancel control. That refusal covers two states of the queued message:
a worker holds a live claim on it (delivery in progress, whether or not a Computer has received it
yet), or it was handed to a Computer that has not reported back. A success is announced from the
returned status the same way. Cancelling a Task that is already `cancelled` is a no-op success, so
repeating the request is harmless — including a second cancel that waited behind the first one's
lock.

## Internal Sessions and collaboration messages

A Task includes every internal Session its own Session created, with their descendants. An internal
Session belongs to the Task of the chat Session at the root of its creator chain, whichever Turn
was running when it was created. Collaboration messages are those exchanged by the Task's own
Sessions and its internal Sessions. A scheduled
collaboration message has no source Session: it carries its scheduled origin instead, and belongs to
the Task of the Session it targets. A message whose source and target both belong to the Task appears
once.

Internal Sessions are read earliest first, with ended Sessions included, so paging walks the whole
attributed history rather than only what is alive now. Both sections page on `(createdAt, id)`; a
message or Session is never repeated across pages.

Each internal Session row carries a `title`: its stored manual or generated title, or else the start
of the first collaboration message it received, which is the work it was created for, collapsed to
one line and bounded at 120 characters (code points). The Server does the collapsing, with one
definition of whitespace that includes Unicode spaces such as NBSP and the ideographic space, so a
body that opens with any run of whitespace still yields its words; a title that is only whitespace
counts as absent. It also carries `lastActivityAt`: the latest of its
creation, its end, and the newest collaboration message it sent or received. Both fields are
optional in the shared schema, so a reader still accepts an older Server's rows.

The Web Task detail lists the internal Sessions in its overview, beside or above the conversation, under an **Internal
Sessions** heading, from the `/detail/internal-sessions` section under the canonical Task id. It
shows the first page and loads the next one on **Load more internal Sessions**. Each row shows the
Session's title, or its model or id when it has none. It reads **Active** until the Session ends and
**Ended** afterwards, and shows the relative time of its latest activity. A long title never widens the
page. In the side column it takes at most two lines, with the status and time on the next line. In one column
the status and time stay fixed at the right: the title stays on one line from a 40rem container and takes at
most two lines below that, because one line beside the status left only a few words of what the row exists
to say. The id is not shown on a titled row: hovering or focusing the title opens a tooltip
with the full title and id, and screen readers get the id with the title. Why: the id only helps
someone diagnosing a run, and beside every title it took the room the title needs. Touch screens have
neither hover nor keyboard focus, so the id is not available there; that is accepted because the
reader does not need it to follow the Task. A row named by its id is plain text with no tooltip or
focus stop, because it has nothing more to show. The section appears only when the Task has internal Sessions. A page that cannot
be read says so in the section's place and leaves the conversation in place. Collaboration messages
are not shown.

## Boundaries

- Task reply history uses captured successful Lark outbound receipts from the originating Turn
  report when that snapshot is present. `finalText` is never displayed and never a substitute
  sent reply. A complete capture with no recorded send, or a legacy report without a snapshot, has an accurate
  empty or unavailable state rather than “in progress.” Slack is not collected as Lark. Send receipts
  are not read receipts. Partial capture is labelled independently of the number of replies; content
  truncation and native post/card details remain visible. Replies become available with the terminal
  report and are not backfilled from old runtime transcripts.
- The unavailable Lark-reply notice is limited to Feishu/Lark Tasks. Slack Tasks carry no permanent
  notice about a capture feature they do not support.
- Reply snapshots require `runtime.turnReport` v2 or later on the current connection. A report created on v2
  remains durable during a v1 reconnect and resumes unchanged after v2 or later is negotiated again. The
  server rejects an unnegotiated snapshot with a nonfatal `unsupported_capability` report result.
- A crashed Turn on a group's channel Session stays `running` until that Session accepts another
  delivery or the delivery deadline passes.
- The list is computed per request from the Account's chat Sessions and their deliveries. Rollups
  per Session decide the page before any row resolves its title or source facts, so a page costs the
  rollup plus its own rows. Executions are read through the deliveries' Session index; internal
  Sessions through the Session creator index; and collaboration messages through their source and
  target indexes.
