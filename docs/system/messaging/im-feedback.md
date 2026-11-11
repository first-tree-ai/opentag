---
title: "IM task feedback and safe recovery"
description: "Durable working reactions, offline notices, failure cards, Account confirmations, and conservative recovery of unknown provider outcomes."
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
custody. After sixty seconds the Bot sends one red [card](#cards), placed like a failure card:

| Title | Body |
| --- | --- |
| Agent 所在电脑离线 / The Agent's computer is offline | 电脑恢复后会自动处理 / Messages will be handled after the computer reconnects. |

The card has no link (see [Cards](#cards)); the Agent owner finds the Computer marked **Offline**, with its recovery
page and restore command, on the Agent page. The card names neither the Computer nor an administrator, because
everyone in the conversation reads it; checking the computer, who manages the Agent, and the seven-day expiry belong on
the recovery page, not in the conversation. It follows the same language rule as failure cards.

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
for it. A queued input in that position gets one red [card](#cards), placed like the offline notice:

| Title | Body |
| --- | --- |
| 排队中 / Queued | 前一条完成后处理 / Handled after the earlier message finishes. |

The card has no link and names no earlier message, person or Computer.

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

### Cards

Failures and offline notices are cards. A card has a colored title that says what happened and one short body
sentence on what to do. When the step needs the Web, the body says "在 OpenTag" (in OpenTag). No card shows an error code, says the task did not
finish, or says whether operations ran: codes and technical details appear only on the details page, which is also
where support reads them. The reason: an IM failure is read by people who cannot act on a code, and a short card keeps
a failure from taking more of the conversation than the work did.

| Provider | Shape | Colors |
| --- | --- | --- |
| Feishu | `interactive` card with `update_multi`, title in `header`, body as `lark_md` | `red` failure and waiting notices, `green` done, `grey` in progress |
| Slack | One attachment `{color, fallback, blocks}`, title as a `header` block | `#E01E5A` failure and waiting notices, `#2EB67D` done, `#9E9EA6` in progress |

Slack paints the attachment bar only from a hex color: the `danger` and `good` keywords show a grey bar when the
attachment holds blocks. The message has no top-level `text`, because Slack would show it above the card as a second
copy; the attachment `fallback` is the notification text.

Cards carry no visible link and no button: no settings, task, recovery or details link, and no save or discard button
(product decision, 2026-11-10). The details page stays reachable from the Agent page. The only link a card holds is
the invisible readback identity described under [Message format compatibility](#message-format-compatibility).

| Failure | Title | Body |
| --- | --- | --- |
| Rate limit | 模型请求太频繁 / Too many model requests | 请稍后重试 / Try again later |
| Service unavailable, connection failure | 模型服务暂时不可用 / Model service temporarily unavailable | 请稍后重试 |
| Quota | 模型额度已用完 / Model quota used up | 将于 15:30 恢复 (a later day adds the date, 将于 11月12日 09:05 恢复), in China time, when the report carries a future `retryAt`; otherwise 额度恢复后请重试 / Try again after the quota resets |
| Authentication | 模型未登录或登录已失效 / The model isn't signed in, or the sign-in expired | 请在 Agent 所在电脑登录模型账号 / Sign in to the model on the Agent's computer |
| Access denied | 没有该模型的使用权限 / No permission to use this model | 请在 OpenTag 更换模型 / Choose another model in OpenTag |
| Request rejected | 模型拒绝了这次请求 / The model rejected this request | 请换个说法，或去掉图片和附件后重试 |
| Feishu or Slack connection lost | 飞书连接已失效 / Slack 连接已失效 (The Feishu/Slack connection is no longer valid) | 请在 OpenTag 重新连接 / Reconnect it in OpenTag |
| Model account not signed in on the Computer (`model_login_missing`) | The authentication card above | |
| The Feishu or Slack command line, or its connection, could not be prepared (`tool_setup_failed`) | Agent 运行出错 | 飞书命令行没能准备好，请重试 / Slack 命令行没能准备好，请重试 |
| Other credential failures (a missing Cloud model grant, or a Computer too old to name the cause) | Agent 运行出错 | 请重试 |
| Timeout | 任务超时未完成 / The task timed out before it finished | 回复“继续”，Agent 会接着做 / Reply "continue" and the Agent will pick it up |
| Context limit | Agent 运行出错 / The Agent ran into an error | 对话太长，请重试 |
| Execution limit (cut-off reply) | Agent 运行出错 | 内容太长没写完，请重试 |
| Result too large | Agent 运行出错 | 回复太长，请重试 |
| Environment disconnected | Agent 运行出错 | 云端运行环境断开，请重试 |
| Model failure | Agent 运行出错 | 模型调用失败，请重试 |
| Task outcome unknown | Agent 运行出错 | 处理可能中断，请先确认结果再决定是否重发 |
| Process exit, start failure, protocol error, and every reason not produced as a failure today or unknown | Agent 运行出错 | 请重试 / Try again |
| Workspace save failed | 工作区改动没能保存 / Workspace changes weren't saved | 请在 OpenTag 重试保存或放弃改动 / Retry the save or discard the changes in OpenTag |
| Message expired | 消息已过期 / Message expired | Agent 太久没能处理这条消息，如需要请重发 |
| Message rejected | 消息没能送达 / Message not delivered | 请重试 / Try again |
| A frozen batch that cannot be retried, including a workspace failure | The reason's own title | The reason's own body, then （共 N 条消息） / (N messages); a legacy plain-text message edited later keeps the reason's next step with the same count |

The context-limit, cut-off, too-large, outcome-unknown and workspace bodies are interim: each changes or disappears when
its automatic recovery ships. Cards that will name the Agent's tool or model say "模型" until they can.

Retrying the save or discarding the changes happens on the details page, which owns both operations and their
confirmations (see [Account operations](#account-operations)). Once an operation runs or the task later completes, the
card is edited in place: its title becomes the state (已完成, 处理中，请勿重复点击, 操作失败, 环境已变化，请刷新, 已保存,
已放弃改动, 已重新排队), green on success, with no body: the actor and time stay on the details page. An environment released without
proof of the save reads 操作失败, never 已保存.

### Where a card goes

| Conversation | Feishu | Slack |
| --- | --- | --- |
| Direct message | New message in the chat, no quote | Channel message |
| Group | Quote reply to the failed message | Channel message |
| Input inside a thread | Reply in that thread | Reply in that thread |

The offline and queued notices follow the same rules. A direct message is the Session's `conversation_kind = 'dm'`; a Slack
multi-person direct message counts as a group.

In a group, including its threads, five cards go to the sender's direct message with the Bot instead, because they
concern only that person: the offline and queued notices, and the failure cards for an expired message
(`input_expired`), an undelivered message (`input_rejected` or `input_unsupported`), and used-up model quota (`provider_quota_exceeded`).
The sender is the target's `sender_external_id`: a Feishu card goes to that `open_id`, and a Slack card to the channel
`conversations.open` returns. When the provider refuses that message (the Feishu sender is outside the app's
availability or is a bot, Slack cannot open the conversation, or the call is rejected), the card goes to the group
place above. A rate limit stays a rate limit, and an unknown outcome never falls back, which could post it twice. A
Slack card in a direct message keeps its channel in its stored message ID as `<channel>/<ts>`, which edits use; Slack
timestamps hold no slash. A card sent to the sender opens with a plain-text line naming the group and the first twenty
characters of the message: "你在「{group}」发的：{excerpt}…" (English: `Your message in "{group}": {excerpt}`). The group
name is read from the provider when the card is sent (Feishu chat info, Slack `conversations.info`), within two
seconds so the send keeps most of its deadline; when that read fails or runs out of time the line says "你在群里发的".
A deadline that ends a send before any provider write started is known not to have sent anything, so a waiting
notice is retried rather than lost. Later edits of the card, which only show its state, do not repeat the line. Every other card, including rate limits and workspace failures, stays in the group.

Raw model output, exception messages, credentials, file paths, and stack traces are excluded. Whether operations ran
stays on the details page, which warns that they may have unless authoritative `not_started` evidence says otherwise.

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
are all taken, a Local preparation failure settles immediately. A miss is reported only after the hand-off settles.

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
| It never started | `runtime_unavailable`, `client_busy`, `late` | The first time per cause |
| The hand-off's fate is unknown | `delivery_timeout`, `delivery_uncertain`, `dispatch_failed` | The first time per cause, worded as "may not have run" |
| The schedule turned itself off | `target_invalid`, `invalid_schedule` | Once, saying it stays off until resumed |
| Someone stopped or changed it | `turn_cancelled`, `schedule_disabled`, `agent_suspended` | Nothing |

"The first time per cause" compares the occurrence with the schedule's previous summary, so a Computer that stays offline
posts one message, not one per occurrence. A delivered occurrence or a different code starts over. A Run failure that
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
resubmitted automatically. The original failure card is edited to show only the operation result; the actor and timestamp
appear on the details page. A plain-text message from before cards still shows the actor and timestamp, with the
display name's `<`, `>`, `[` and `]` replaced with lookalikes, as schedule names are, so a profile name can't add a link
or a mention.

New Task Retry admissions are disabled. Existing admitted
retry deliveries, immutable terminal reports, attempt identity and message order remain intact.
Workspace save/discard stays available through the authenticated details page and its existing
confirmation flow. Unsupported steer remains queued until the current Turn settles. The team
decision on #1160 is that new messages always steer in and a runtime that cannot inject is
interrupted and redelivered; that interrupt fallback is not implemented yet, so today feedback
never forces interruption or replays a Turn.

## Message format compatibility

`im_feedback_targets.message_format` keeps its two values and check constraint, so cards needed no migration. Every
new send is a card stored as `interactive_v1`. `text_v1` marks a plain-text failure message sent while failures were
text.

- **A text target that never sent.** Marking the send rewrites the row to `interactive_v1` before any provider request
  exists, so the message, its readback and later edits are all cards.
- **A text message already sent.** It stays text: Feishu cannot turn a text message into a card. A later status change
  or save/discard result edits it as text, with the same three sentences and details link as when it was sent.
- **A card from before the text period.** Those cards were sent with `update_multi`, so a later change edits them in
  place with the current card. On Slack, the edit clears the old top-level text and blocks.
- **Readback.** A failure card is found by an identity the provider returns: on Slack the `opentag_feedback:<id>`
  block ID, in an attachment or (old cards) at the top level; on Feishu the exact details URL. Feishu's message read
  API returns a card's links but not its text formatting or button values, so every failure card carries a zero-width
  link to its details page: invisible, with nothing to click. A text message
  is still found by its details URL.
- **Waiting notices.** An offline or queued notice can precede the failure card of the same target, so it carries a
  different identity: the Slack block ID `opentag_notice:<id>`, and on Feishu no feedback URL at all. Failure readback never binds a notice, so a notice followed by a failure whose send is unknown still binds the
  failure, or stays unknown, without a second send.
- **Where Slack looks.** A thread is read with `conversations.replies`. A card for a top-level input is looked for
  first in the input's replies, where cards from before the text period went, and then in the channel with
  `conversations.history` from a minute before the send was reserved; the stored cursor says which. A text message
  always went into the input's thread.
- **A button on an old card.** The Slack interaction endpoint accepts the `opentag_feedback_*` action IDs and
  acknowledges them without doing anything, so Slack shows no error. A Feishu Retry button gets a toast saying the
  button is no longer available instead of reaching the approval handler.

During a rollout overlap, an older Server can still send a text message: it stores `text_v1`, so a newer worker keeps
editing it as text. A send started by an older Server whose outcome is unknown is read back where that Server put it.

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
abandoned send becomes `send_unknown`. Bounded readback searches the conversation the card was sent to for this Bot
and feedback identity, up to one hundred messages per page on Slack and fifty on Feishu, five pages per pass, retaining a cursor. A confirmed match binds
its native ID. Multiple observed matches are a defect. Negative, inaccessible, or incomplete reads never authorize
another creation. Readback stops at the twenty-four-hour action deadline; unresolved sends become dormant without deletion or another creation. Feishu topic replies are read through the `thread` container without unsupported time-range filters ([provider contract](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list)). An unknown send keeps the reconciliation cursor of the leg whose provider write started, recorded outside the call deadline so a timeout keeps it too: `sender:` for the sender's direct message and `conversation:` for a card that fell back to the conversation. Without a cursor, after a crash or a lost acknowledgement, a group card that goes to the sender is looked for in the conversation first, read-only, and then in the sender's direct message (`either:` and `either-sender:`); an exhausted search starts over from the conversation. A plain-text message from before cards went to the sender is read back in the conversation only. A deadline that ends a send before any provider write started is known not to have sent anything, so it retries instead of reading back. Slack reads the direct message's history; Feishu, which cannot name the chat before a send, repeats the send under the same request `uuid` within fifty minutes of the first attempt, and Feishu answers a repeated `uuid` within an hour with the original message instead of sending another. Past that window Feishu readback sends nothing. A failed Slack `conversations.open` posts nothing, so it is a known-not-sent failure that retries normally. Unknown sends remain in Account diagnostics with sanitized operational warnings. This deliberately
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
