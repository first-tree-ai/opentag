---
title: "Agent collaboration model"
description: "How people invoke long-lived Agents in Feishu and Slack, how visible and internal Sessions cooperate, and when an Agent speaks."
soft_links:
  - /system/agent-session-computer-model.md
  - /system/messaging/message-domains.md
  - /system/messaging/thread-sessions.md
---

# Agent collaboration model

## Decision

openTag's human-facing surface is Feishu and Slack. A person invokes a
long-lived Agent identity by mentioning it in a channel or thread or by
messaging it directly. One Agent may participate in many channels, and one
conversation may involve several Agents. The Agent profile is reused, while
each Agent and conversation have isolated Sessions, resources, and
permissions.

Runtime collaboration creates Sessions, not new Agent identities:

- A channel Session owns the Agent's channel-level conversation and awareness.
- A thread Session owns the Agent's work and replies for one thread.
- An internal Session performs invisible delegated work and reports through
  Session-to-Session collaboration. It cannot publish directly to IM.

Channel and thread Sessions may create internal Sessions, and internal Sessions
may delegate further. See [Internal Session collaboration](../system/messaging/internal-session-collaboration.md).

## Attention and when to speak

`receive_mode` controls which IM traffic an Agent receives: `all_message` is the
default, while `mention_only` wakes the Agent for messages that address it and
otherwise keeps intervening messages as later context. The exception is thread
continuity: once a thread's root or an earlier message in it addressed the
Agent, `mention_only` still delivers that thread's unaddressed follow-ups
immediately, as `ambient` input with the longer direct retention window. See
[IM Channel and Thread Sessions](../system/messaging/thread-sessions.md).

Each delivered input separately carries `direct` or `ambient` attention, and
attention states only whether that message itself addresses the Agent.
Direct input is a DM or an @-mention of the Agent: the visible Session replies
by default and stays silent only when the message merely closes the loop on
work it already finished, asks for no reply, or duplicates input it already
handled. Everything else is ambient, including unaddressed follow-ups in a
thread the Agent was brought into earlier: the Session listens and stays silent
unless the message is clearly meant for it — it names the Agent and asks for
something, answers the Agent's own question, or continues a task the Agent
owns. People talking to each other is not meant for the Agent, even when the
topic is one it could help with. The same rules apply whether the sender is a
person or another Agent, and an Agent never sends a message only to
acknowledge, thank, agree, or restate.

Model output is not automatically published; only an explicit action through
the official Feishu or Slack CLI changes human-visible IM state. When a thread
Session exists, it is the reply owner for that thread. The channel Session may
receive the same thread activity as ambient context under `all_message`, but
must not produce a duplicate reply.

## Setup

Creating an Agent does not wait for a messaging connection or a ready Computer
and Provider route. An Agent can be created first and connected to Feishu or
Slack later. Once recorded, the Agent's Computer and Provider stay stable
through later readiness loss: messaging handoff and Turn dispatch use that exact
Provider and never substitute another one.

## Rationale

Separating long-lived Agent identity from per-conversation and delegated
execution lets people build a stable relationship with one Agent while keeping
concurrent work isolated. Explicit attention and reply ownership let Agents
observe shared conversations without turning every observation into a noisy or
duplicate response.

Attention follows the message rather than the thread because being in a
conversation is not being addressed: treating every follow-up in a thread the
Agent once joined as addressed, with a reply expected, makes the Agent answer
people who are talking to each other. A thread follow-up therefore needs no
attention value of its own; it has the same meaning as any overheard message,
and the Agent judges it from context. DMs and @-mentions share one default and
one set of exceptions, so they need no separate distinction either. Applying
identical rules to people and Agents, with no acknowledgement sends, is what
stops two Agents in one conversation from echoing each other: one side
declining to answer an acknowledgement ends the exchange without any
author-type filtering.

## Constraints

- Feishu and Slack share the same identity, permission, and attention semantics
  even when their thread, mention, and presentation behavior differs.
- Choosing between Feishu and Slack is the team's decision rather than a
  recommendation openTag makes. Surfaces offering the choice give the two equal
  weight; what varies between deployments is availability, not preference.
- Only channel and thread Sessions may modify human-visible IM state.
- Internal Sessions return summaries and artifact references to a visible
  Session, which decides whether and how to reply.
