---
title: "IM task feedback and safe recovery"
description: "Durable working reactions, offline notices, plain-text failure messages, Account confirmations, and conservative recovery of unknown provider outcomes."
---

# IM task feedback and safe recovery

The Server owns task reactions and system error messages. The Agent still sends its final reply through the
[provider CLI](direct-provider-cli.md). This is a narrow system feedback surface, not a general hosted message API.

## Normal tasks

Eligible inputs are direct human messages delivered to visible, non-observer Sessions. Ambient observations,
internal messages, duplicate-pending copies, deleted inputs, and a Channel copy owned by a Thread do not gain
feedback merely from receipt. Dispatch-time observer roles and later Thread ownership are rechecked before
projection. Retained custody only reopens feedback for unreported work. A confirmed later completion updates an
existing expiry message, or suppresses it if it has not been sent. Ingress records a queued projection; custody acceptance requests a working reaction
on that exact native input: Slack `eyes`, Feishu `OnIt`. Heartbeats and approval waits do not change it.

A terminal success removes the working reaction without adding a normal-operation message or completion emoji.
The final reply and reaction removal are separate provider operations. A reaction repair never replays execution.
Failure removes working and adds Slack `warning` or Feishu's supported `CrossMark` failure marker; Feishu has no
native `Warning` identifier in its reaction catalogue. Only this application's designated reactions are removed.
Frozen batches retain per-input reactions but publish one failure message at the execution root. Unexecuted steered
children requeued by custody retain their existing execution authority.

Feishu feedback reads the message's complete paginated reaction list once for both designated emojis
([provider contract](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/list)). It filters by App
operator identity and emoji before writing, retains an existing wanted reaction, and removes every distinct owned
unwanted reaction. Invalid, looping, or excessive pagination fails before either writer starts. The two emoji
writers run concurrently, with at most one request per emoji in flight; both settle before a provider failure is
returned. The existing eight-second operation deadline cancels their shared per-operation transport signal, and
each later page or mutation checks cancellation before starting. Each operation still resolves active binding
material and checks its credential generation, and creates a request-scoped Client. The pinned SDK's default
tenant-token cache is shared across Clients by App ID and refreshes 180 seconds before expiry; constructing a
Client does not itself force another token exchange.

The unfiltered read scales with every reaction on the message, including unrelated emojis and operators. Unlike
the earlier per-emoji filtered reads, a sufficiently busy message can exhaust the eight-second deadline before
any writer starts. The worker keeps that projection pending; repeated scans do not guarantee progress when a
complete read consistently exceeds the budget. Incomplete pagination never authorizes a mutation.

A Local Client's [automatic retry](../server-client-boundary.md#automatic-retry-of-accepted-work) of an interrupted
Turn (crash, restart or upgrade, Run timeout, model 429) is part of the same accepted Turn: no report is written
while the retry is pending or running, so the working reaction stays on the input and no failure marker or failure message
appears. Failure feedback appears only once the Turn is terminal — when the one retry also fails, or when the failure
was not recoverable — and then follows the rules above for that final report. A retry that completes removes the
working reaction like any successful Turn.

## Offline notice

A direct message parked on an offline Local Computer otherwise shows nothing, because the working reaction waits for
custody. After sixty seconds the Bot replies once with the reason, how to recover, and that the message is saved:

> The computer running this Agent is offline, so this message can't be handled yet.
> Check that the computer is on and connected, then restore the connection on the Agent page. [Restore connection]
> If you don't manage this Agent, contact its administrator.
> Your message is saved and will be handled after it reconnects. It expires after 7 days.

The link opens the Agent page. For its owner the Computer row shows **Offline** with a link to the Computer recovery
page, which offers the restore command. Signed-out people reach sign-in. Another Account gets a not-found page, or
first-Agent setup if it has no Agents, so the third sentence tells them to contact the administrator. The notice names neither the Computer
nor an administrator, because everyone in the conversation reads it. It follows the same language rule as failure
messages.

- **When.** Sixty seconds after the later of the message's receipt and the Computer's `last_seen_at`, with the Computer
  offline by the same rule the Web uses: disconnected, no current instance, or silent past the presence timeout. A
  message that waited behind a running Turn gets no notice the moment its Computer disconnects, and upgrades and short
  disconnects stay silent. The feedback worker revisits queued targets every fifteen seconds, which is the extra delay.
- **How often.** Once per Session and offline period. `last_seen_at` is frozen while offline and rewritten on
  reconnect, so a feedback send at or after it belongs to the current period. A Computer that never connected has been offline
  since it was created, so that time is its period start. The baseline must not be the message's receipt, which would
  repeat the notice for every later message in one outage. Any send counts, including a failure
  message. `im_feedback_targets.send_started_at` records the reservation, so this adds no table or column. The Session
  row lock makes concurrent targets of a Session take turns, eligibility is read again under it because the Computer
  can reconnect during the wait, and the check walks the Session's deliveries rather than the input's lifetime. An
  outage longer than the ninety-day feedback retention can send another notice.
- **Crash and provider outcomes.** The reservation commits before provider I/O, so a crash or lost acknowledgement can
  lose a notice but never repeats one. A send the provider definitely did not apply, such as a rate limit, is released
  for a later pass. A cooldown-storage failure stops the worker pass, as it does for other feedback calls. The notice does not use the failure message's request identity, which Feishu would deduplicate.
- **Scope.** Local Computers only: Cloud placements never match. A paused or suspended Agent, an expired credential,
  and a deleted Computer are out of scope. Recovery sends no "back online" message, because the working reaction and
  reply are the signal, and an expired message keeps the existing failure message.

## Parked-dispatch notice

A dispatch whose operation never settles is [parked](im-delivery-claim.md#parking-a-correlated-dispatch). It keeps
custody until its ingress deadline, so later input of the same Session waits up to seven days with nothing to show
for it. A queued input in that position gets one plain reply, built like the offline notice:

> This Agent's computer hasn't confirmed an earlier message, so this message is waiting behind it and can't be handled yet.
> If this lasts, check that computer on the Agent page. [Open the Agent]
> If you don't manage this Agent, contact its administrator.
> Your message is saved and will be handled once the earlier one finishes or expires. It expires after 7 days.

- **When.** Sixty seconds after the input's receipt. The input's Computer must be online: an offline Computer gets the
  offline notice instead. Another pending delivery of the same Session must carry `IM_DELIVERY_PARKED`. Other Sessions
  of the Agent get no notice: whether they also wait depends on the Client (one that runs one Turn per Agent blocks
  them too), and the notice must not claim a wait that is not happening.
- **How often.** Once per Session for each parked input. The period starts at the parked input's receipt. As with the
  offline notice, any feedback send of the Session since then counts, including an offline notice or failure message.
  It reuses the same `send_started_at` reservation, Session row lock, re-check under the lock, and release of a send
  known not to have applied. While the Session still waits behind that parked input, the offline notice's period also
  starts no later than the parked input's receipt, so a reconnect followed by an outage does not send a second waiting
  notice for the same wait, whether from a later input or from the parked input's own target.
- **Scope.** Local Computers only, like the offline notice. The parked input itself gets no notice: its working
  reaction stays until it settles or expires.

## Failure messages

Every failure is plain text in the original conversation or thread; the Server sends no cards and no buttons. A
message has three sentences: what happened, whether operations ran, and what to do next, followed by the
authenticated details link as clickable words, never a raw URL: Feishu `text` with `[words](url)`, or Slack
`<url|words>`. Sentences are separated by a blank line. No message shows an error code: codes and technical details
appear only on the details page, which is also where support reads them. The reason: an IM failure is read by people
who cannot act on a code, and a plain message keeps a failure from taking more of the conversation than the work did.

A workspace failure is text too. Its next step says the save can be retried or the changes discarded from the
details page, which owns both operations and their confirmations (see [Account operations](#account-operations)).
Buttons in the conversation would add nothing: confirmation always happened on that page.

The roughly twenty-four failure reasons map onto five next steps, so the reader is told what to do rather than why
the runtime stopped:

| Next step | Reasons |
| --- | --- |
| Send again later | Rate limit, model service unavailable, connection failure |
| Ask the Agent owner | Authentication, access denied, quota, credentials unavailable |
| Split the task | Context limit, execution limit, time limit, result too large |
| Send again, then ask the owner | Process exit, start failure, environment disconnected, client stopped, and every other reason |
| Check the result first | Task outcome unknown |

Raw model output, exception messages, credentials, file paths, and stack traces are excluded. Only authoritative
`not_started` evidence permits the claim that no task operations ran. All other outcomes warn that operations may
already have run; missing outbound capture proves nothing about those operations.

Copy follows the language of the input that started the task: Chinese when the sender's text contains Chinese,
otherwise English. It is derived from that exact stored input revision on every render, so it needs no setting, adds
no storage, and behaves the same on Slack and Feishu. Mentions are ignored, so a Chinese Bot name does not switch an
English request. A mixed-language message can pick the less expected language; the only consequence is the wording.

A workspace failure pauses that Session rather than the entire Agent. New input remains queued for the Session.
Saving or discarding files does not undo messages, pull requests, or other external operations. The existing Runner
owns automatic save retries; this feedback layer adds no automatic save or task retry loop.

### Task Retry

New Task Retry admissions are disabled; a Retry button on an old card does nothing. To try again, a person sends
a new message, which follows ordinary admission and is steered into the running Turn; every Local
runtime (Codex, Pi, Claude Code) accepts steered input, and a runtime that cannot stays queued. Existing admitted retries and workspace save/discard keep their original recovery
and confirmation semantics.

## Scheduled tasks

A scheduled message goes to the Agent only and posts nothing in IM when it starts or succeeds
([#1352](https://github.com/first-tree-ai/opentag/issues/1352)). It has no sender and no native input, so neither the
sender notice nor a feedback target can carry its failure. This section covers a visible target; for an internal Session, see
[Schedules on an internal Session](internal-session-collaboration.md#schedules-on-an-internal-session). The Server instead posts one plain message from the Session's
Bot in the Session's own chat or thread. It has the same shape as other [failure messages](#failure-messages): what
happened with the task name and scheduled time, whether operations ran, what to do next, and a clickable link to the schedule.
Stable codes stay out of the message; the schedule page shows the reason. A schedule has no sender, so the language follows
its task text by the same rule. Brackets in the task name are replaced with lookalikes, so a name can't carry a mention or a
disguised link; a bare URL in a name can still be linked by Feishu, but it shows its real address. The Server stores no IM
feedback state for this and adds no column.

A claimed Local occurrence retries connection lookup and reconciliation after transient preparation failures, every five
seconds until it is ready, the next trigger arrives, or 60 seconds have elapsed since dispatch started. It keeps the same
message ID and dispatch slot, and tries the business send at most once. A pause, edit, or deletion still wins at send
admission. The final result distinguishes runtime assembly failure, reconcile timeout, other reconcile failures, and
an explicit not-ready reply. Local retries and extended Cloud hand-offs share 75 slots per Server. If those slots
are all taken, a Local preparation failure settles immediately. A Local occurrence still unreachable at that point is
[held](internal-session-collaboration.md#held-delivery) when its Client supports it, rather than missed. A miss is
reported only after the hand-off settles.

A claimed Cloud occurrence can wait for its Sandbox to finish releasing, allocate a replacement, and restore the
workspace before sending. It retains the original message identity and dispatch slot. The hand-off ends within
280 seconds of dispatch entry or at the next trigger, whichever comes first. When the shared slots are full, Cloud
hand-offs have up to 20 seconds so they free scheduler slots
within the 30-second claim window. A pause, edit, or deletion still
wins at final send admission. Once sent, the occurrence is never resent, even if the receipt is lost. A Server
restart does not recover an unfinished scheduled hand-off.

| What happened | Example codes | Conversation hears |
| --- | --- | --- |
| The Run failed, timed out, or was interrupted | `provider_unavailable`, `turn_timeout` | Every time, with a warning that some work may already have happened |
| The Client rejected the message | `configuration_unsupported` | The first time per cause |
| It never started | `runtime_unavailable`, `client_busy`, `late`, `delivery_superseded`, `delivery_expired`, `delivery_held_full` | The first time per cause |
| The hand-off's fate is unknown | `delivery_timeout`, `delivery_uncertain`, `dispatch_failed` | The first time per cause, worded as "may not have run" |
| The schedule turned itself off | `target_invalid`, `invalid_schedule` | Once, saying it stays off until resumed |
| Someone stopped or changed it | `turn_cancelled`, `schedule_disabled`, `agent_suspended` | Nothing |

"The first time per cause" compares the occurrence with the schedule's previous summary, so a Computer that stays offline
posts one message, not one per occurrence. A Local occurrence the Server held has no result yet, so it posts nothing until
[held delivery](internal-session-collaboration.md#held-delivery) gives it up, usually within 5 minutes of the next occurrence,
and is then compared with the occurrence before it. A delivered occurrence or a different code starts over. A Run failure that
keeps recurring posts every time, as it would for repeated human messages.

Delivery is best effort:

- A failed Run uses the Client's or Runner's existing outcome report. The Server answers `retry` while the send can safely
  be repeated. A Local report frame does not wait for the send: it answers `retry`, at most 16 sends run in the background,
  and a later report receives the result, following the same backoff as
  [creator notices](internal-session-collaboration.md). The result is kept in memory only, so a Server restart can
  repeat the send. Shutdown starts no new send and waits for running ones. Cloud settlement waits for the answer. Feishu drops a repeat of the same notice through its request `uuid`, which differs from the occurrence's
  "may not have run" notice, so a hand-off that was in doubt and then failed posts both. A lost report acknowledgement can
  duplicate the message on Slack. A Feishu thread is reached by replying to its latest known message that was not
  recalled; with none known, the message is dropped rather than posted to the chat.
- A missed occurrence has no reporter. The Server tries up to three times in-process, so a Server stop or a long IM outage
  loses the message. The Agent schedule page still shows the miss from `last_dispatch`.
- A Client that never returns never reports a message it accepted; its next occurrence reports the miss instead.

The message links to the schedule, whose last run shows the reason. A Run that failed after delivery writes its code to
the summary's existing `last_dispatch.code` with the outcome still `accepted`, and the page reads as failed. A slower
hand-off result for the same occurrence does not replace it, since the Run's report may be gone by then. The summary only
describes the latest occurrence: once the next one is claimed, the link shows that one, and an older report writes
nothing. A cancelled Run leaves the summary alone.

## Account operations

The details link opens an authenticated Account page. Opening a URL and refreshing details are read-only. The page shows
the original Task link, exact Session, workspace generation, effects warning, selected operation, and the last-save boundary; when its
time cannot be verified, the page says so. The Agent detail page also exposes recovery notices when a failure message cannot
be delivered. Lists are owner-scoped and paginated in batches of twenty.

The final CSRF-protected POST rechecks the current Account owner, active binding and installation generation,
source-message revision, Session, placement, expiry, and allocation tuple. A five-minute signed confirmation binds
the Account, feedback revision, and operation. Discard requires a second confirmation with an explicit permanent-loss
acknowledgement, enforced by the strict HTTP schema and service admission as `permanentLossAcknowledged: true`. The placement generation must still match the feedback target even when the workspace allocation is unchanged. Concurrent save/discard requests admit one operation per revision. Cloud calls run after commit,
using the existing generation-bound sandbox service; the action is persisted before submission.

A verified save says that the environment was saved and released and will restore on the next allocation, never that
execution resumed in place. Save success requires the exact generation's sealed archive proof. An unallocated
environment alone yields an unverified release message. Unknown or restarted operations are queried, never
resubmitted automatically. The original failure message is edited to show the operation result, actor, and timestamp. The actor's display name has its
`<`, `>`, `[` and `]` replaced with lookalikes, as schedule names are, so a profile name can't add a link or a mention.

New Task Retry admissions are disabled. Existing admitted
retry deliveries, immutable terminal reports, attempt identity and message order remain intact.
Workspace save/discard stays available through the authenticated details page and its existing
confirmation flow. Unsupported steer remains queued until the current Turn settles. The team
decision on #1160 is that new messages always steer in and a runtime that cannot inject is
interrupted and redelivered; that interrupt fallback is not implemented yet, so today feedback
never forces interruption or replays a Turn.

## Message format compatibility

Failure messages were once interactive cards. `im_feedback_targets.message_format` and its check constraint remain,
with `interactive_v1` as the column default, so removing cards needed no migration. New targets are written as
`text_v1`, and every new send is text. There is no setting to bring cards back.

Rows from the card era are handled without a second message:

- **A card was sent.** It is never refreshed: Feishu cannot turn a card into text, and a fresh text reply would
  repeat the failure in the conversation. A later status change or save/discard result settles in storage and shows on
  the details page, which the card's details button still opens. Its save and discard buttons open the same page.
- **Nothing was sent yet.** Marking the send rewrites the row to `text_v1` before any provider request exists, so the
  message, its readback, and later edits are all text.
- **The send's outcome is unknown.** Readback keeps the stored format. Feishu matches the details URL, which cards also
  contained; Slack matches the card's `opentag_feedback:<id>` block ID. A confirmed match binds the card, which is then
  left as above.
- **A button is clicked.** The Slack interaction endpoint still accepts the old `opentag_feedback_*` action IDs and
  acknowledges them without doing anything, so Slack shows no error. A Feishu Retry button gets a toast saying the button
  is no longer available instead of reaching the approval handler.

Known-message updates and unknown-send reconciliation use the stored format and the same native identity; text lookup
matches the installed Bot and exact details URL, which is why the link target stays inside the text on both providers.
During a rollout overlap, an older Server can still turn an unsent workspace failure into a card. It stores
`interactive_v1` with it, so a newer worker then treats it as a legacy card. Save/discard and historical admitted
operation results remain accessible.

## Projection, unknown outcomes, and retention

`im_feedback_targets` stores source scope, desired reaction, message identity, message format, revisions, and bounded worker claims.
`im_feedback_actions` independently stores confirmation, idempotency, and operation outcome. Existing custody remains
the only execution authority. Terminal report and feedback transitions commit together; feedback cannot make an
invalid report acceptable. Reads use a short owner-authorized snapshot. Mutation admission locks Agent custody,
Agent/binding, Session/placement/delivery, then feedback/action; no provider I/O holds database locks.

One worker processes at most eight due targets per pass, with up to four independent native inputs in flight.
Claims remain sequential and exclude inputs already active in that process (binding, channel, and external input ID),
so separate attempts for the same input do not overlap locally or block other inputs. Selection retains due-time/ID
ordering, `SKIP LOCKED`, a random ninety-second claim, and the shared provider call policy. The existing claim fences
each target across replicas; input exclusion is local, not a cross-replica native-message lock. The worker checks authority
again before I/O and cannot settle a newer desired revision as its own. Binding rotation fences new calls and callbacks;
it cannot revoke a request already in flight. Timer ticks and explicit wakeups join the active pass; performance logging
records `ImFeedbackWorker.runPass` once per actual pass. Provider failures are rescheduled independently. A claim or
settlement storage failure stops further admission while joining every projection already in flight.
Cooldown-storage failure stops admission as soon as it is observed, before waiting for its settlement write; a blocked
settlement does not permit more targets to start.
Shutdown stops new claims, releases a claim that finishes admission after shutdown, and drains every admitted projection.

Before a new message request, the worker persists `sending` and a stable request identity. A lost acknowledgement or
abandoned send becomes `send_unknown`. Bounded readback searches the original conversation for this Bot and feedback
identity, up to one hundred messages per page on Slack and fifty on Feishu, five pages per pass, retaining a cursor. A confirmed match binds
its native ID. Multiple observed matches are a defect. Negative, inaccessible, or incomplete reads never authorize
another creation. Readback stops at the twenty-four-hour action deadline; unresolved sends become dormant without deletion or another creation. Feishu topic replies are read through the `thread` container without unsupported time-range filters ([provider contract](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list)). Unknown sends remain in Account diagnostics with sanitized operational warnings. This deliberately
does not promise unconditional eventual delivery or exactly-once external sending. Known-message updates use that
same native ID. If completion arrives while creation is in flight, a definitely-not-applied result suppresses the new message, while a confirmed or ambiguous send retains its binding/reconciliation path. Slack rate-limit responses are classified within the call-policy boundary so they do not count toward the shared outage circuit; the existing installation timestamp also gates subsequent feedback calls across targets, Server processes and restarts. Old buttons cannot authorize a stale operation.

New workspace actions expire after twenty-four hours. Previously admitted task retries retain the original input deadline. Confirmed,
settled projections and actions retain ninety days of diagnostics; cleanup is bounded to one hundred records per
retention tick. Unknown sends and operations survive expiry. Referenced source deliveries/messages remain available
until their feedback is safely removed. No historical failure-message backfill runs.

The shared call policy distinguishes rejection before capacity admission from a request already started. Queue overflow,
queue deadline, queued cancellation, and an open circuit are definitely not submitted and keep an unsent message pending
for a later bounded retry. A deadline after the provider action begins remains unknown and requires readback.

## Slack rate-limit coordination

The feedback transport reuses `slack_installations.working_status_not_before_at`, which also gates legacy native
status cleanup. It adds no cooldown table, column, index, migration or cleanup job. Immediately before each
reaction add/remove, message creation/update or history read, it checks the active installation at the target's
credential generation and reads the remaining deadline using the database clock. A future deadline defers the
operation as definitely not submitted. A confirmed 429 extends the same timestamp with `greatest(current,
database-now + Retry-After)` in a short generation-checked installation-row transaction. No database lock spans
provider I/O. Rate-limit and cooldown-storage outcomes do not count toward the shared provider outage circuit.

This is deliberately installation-wide: a rate limit on one feedback method also delays other feedback methods
of that installation. Other installations and Feishu remain independent. It conservatively honors Slack's
[per-method/App/workspace limits](https://docs.slack.dev/apis/web-api/rate-limits/), rather than providing separate
method deadlines. A request already admitted before the deadline was persisted may still finish.

Success, completion, target retention and legacy cleanup cannot shorten the deadline. Reauthorizing the same
installation preserves an already committed cooldown, while old-generation responses cannot extend it afterward.
Expired timestamps remain on the installation and need no cleanup. A cooldown read failure prevents submission.
If recording a confirmed 429 fails, the current worker pass stops claiming new work, drains its admitted calls, and retains a definitely-unsent pending message;
coordination is not claimed successful while storage is unavailable. Other replicas and in-flight calls cannot be
revoked by that local failure. Unknown provider sends retain their separate reconciliation rules.

## Writer cutover

New Server processes stop creating Slack native thread-status projections. The old worker only drains known status
indicators; outbound capture no longer refreshes them. The old reaction notifier is disabled in the Server composition root. Its module and synthetic fixtures remain temporarily for the existing queue-policy and legacy reaction regression suites; they provide no production fallback and must not be reconnected alongside durable feedback. Old and new writers
must not overlap during rollout, and old writers must not insert deliveries after explicit retry attempts are enabled.
Coordinate this through the existing compatible release process without scaling the service to zero. The migration
alone does not establish deployment or native Slack/Feishu acceptance.

On shutdown, the Server first joins admitted HTTP requests and background producers, then drains feedback workspace
operations before closing the shared SQL pool. A submission already waiting on SQL can still create such an operation;
closing the feedback service before its producers settle would miss it.
