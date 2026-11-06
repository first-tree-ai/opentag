---
title: "IM Channel and Thread Sessions"
description: "Channel Session versus lazily materialized Thread Sessions, direct continuity, observer copies, and thread history."
---

# IM Channel and Thread Sessions

openTag keeps one long-lived Channel Session per Agent, Integration, and IM channel. A top-level message addressed to the Agent is delivered to that Channel Session; openTag does not pre-create a Thread Session or require the Agent to reply in a native thread.

The Agent receives the provider-native message reference and per-target `direct` or `ambient` attention in managed context. Attention states only whether the message itself addresses the Agent: `direct` is a DM or an @-mention, `ambient` is everything else. It is independent of receive mode, Session creation, direct continuity, and credential availability. The reply rule for each attention is described in the [Agent collaboration model](../../product/agent-collaboration.md).

## Channel Session idle compaction

> **Planned — not yet implemented.** Tracking: #1302

When a Channel Session has been idle for more than 8 hours, its provider context is compacted automatically instead of a
new conversation being started. The Session identity, workspace, and native conversation stay the same.

## Lazy Thread continuity

A Thread Session is materialized only after a real inbound provider event carries a normalized thread key. Routing then depends on the Agent's receive mode:

- In `all_message` mode, a thread-scoped event materializes or wakes the Thread Session even when it does not address the Agent. The Thread delivery is `ambient` unless the message itself addresses the Agent; direct continuity only extends how long the delivery is retained. The Channel Session receives a separate `ambient` observer copy of the same message.
- In `mention_only` mode, an unaddressed event is delivered to the Thread Session only after trusted direct continuity has been established. Otherwise it is not delivered and does not materialize a Thread Session.

When an event omits its provider root, the Inbox selects the newest nonempty root from the same
binding/Channel/Thread's inbound history. It retains occurrence-time, provider-revision and ID
ordering, projecting one root in SQL instead of materializing every stored context. No root keeps
the existing continuity fallback.

If a direct Channel root arrives after its Thread replies, SQL selects the latest
external-message revisions across the original binding/Channel/time scope and
matches each Thread's latest nonempty root before reading full message content.
Cross-Thread revisions still supersede older input; unrelated payloads are not
materialized. Existing ended-Thread fences, delivery retention and queue capacity
remain in effect.

The Thread Session owns the provider reply and the task execution for a message delivered to both scopes. The Channel observer copy is ambient channel context only: it must not reply, react, or perform another provider mutation for that message, and it must not investigate, execute or repeat, delegate, or create artifacts for that task — the observer Turn finishes without tool calls or task work. Reply role does not remove the Channel Session's normal IM credentials or CLI capabilities. If an ended-session fence prevents an ambient Thread delivery, the remaining Channel delivery is an ordinary owner delivery, not an observer copy.

The Server owns working reactions and terminal failure messages for eligible directly addressed human inputs. It projects working when custody accepts the input, removes working on completion, and requests a warning plus one execution-root card on failure. The Agent keeps normal progress silent, apart from milestone messages for long-running delegated work, and sends its final result through the provider CLI. The Channel observer copy and internal Sessions do not publish IM reactions or replies for that input.

Feedback has durable, leased retry work independent of task execution; provider failures never replay a task just to repair a reaction. Frozen batch inputs each own their reaction, while an execution failure owns one root card. Unknown card creation is reconciled before any resend, and Account-owned recovery actions require current authority and generation checks. See [IM feedback and recovery](im-feedback.md) for the complete lifecycle and safety boundaries.

Trusted direct continuity comes only from the current event directly addressing the Agent, a prior direct inbound delivery to the active Thread Session, or a reliable root identifier whose inbound root was delivered directly to the same Agent's Channel Session. Continuity decides admission and retention only; it never turns an unaddressed follow-up into a `direct` message, and merely creating or waking a Thread Session establishes no continuity. Ending a Thread Session blocks ambient traffic and old root evidence from reviving it; a new current direct event may create a new active Session.

Only a real provider thread defines a Thread Session. Slack uses `thread_ts` as both the stable thread key and root message identifier. Feishu uses only `thread_id` as the thread key: a reply in a thread of an ordinary group carries it, and so does every message of a topic group, including the topic's root. A Feishu quote reply in an ordinary group carries `root_id` and `parent_id` but no `thread_id`; it has no thread key, stays in the group's Channel Session, and keeps its quoted message as `replyToExternalId` context. `root_id` is never a thread key; within a real thread it serves only as the root identifier when the provider supplies it, and `parent_id` is never guessed to be the root. A reliable root discovered from an earlier inbound event in the same normalized thread may establish continuity for later events.

## Bootstrap history

Every delivery to a Thread Session carries the bounded, verifiable same-thread history that Session has not yet accepted: the visible root message when a reliable root identifier exists, followed by prior messages from the same thread. The current message is excluded from history, and sibling threads are not included. An ambient follow-up that first materializes a Thread Session therefore still sees the root and earlier replies; ambient materialization does not by itself establish direct continuity.

Channel and Thread Sessions remain distinct Runtime scopes. openTag does not copy the Channel Runtime transcript or depend on provider CLI send results to create Session continuity. Bounded Lark send receipts may appear on the originating Task; they do not create cross-Session continuity. The Agent can query additional native history with the official provider CLI when needed.
