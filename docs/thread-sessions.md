# IM Channel and Thread Sessions

[简体中文](./zh-CN/thread-sessions.md)

OpenTag keeps one long-lived Channel Session per Agent, Integration, and IM channel. A top-level message addressed to the Agent is delivered to that Channel Session; OpenTag does not pre-create a Thread Session or require the Agent to reply in a native thread.

The Agent receives the provider-native message reference and per-target `direct` or `ambient` attention in managed context. Attention describes what the inbound message means to that Session; it is independent of receive mode, Session creation, and credential availability.

## Lazy Thread continuity

A Thread Session is materialized only after a real inbound provider event carries a normalized thread key. Routing then depends on the Agent's receive mode:

- In `all_message` mode, a thread-scoped event materializes or wakes the Thread Session even when it does not address the Agent. The Thread delivery remains `ambient` unless trusted direct-continuity evidence exists. The Channel Session receives a separate `ambient` observer copy of the same message.
- In `mention_only` mode, an unaddressed event is delivered to the Thread Session only after trusted direct continuity has been established. Otherwise it is not delivered and does not materialize a Thread Session.

The Thread Session is the reply owner for a message delivered to both scopes. The Channel observer copy provides channel-wide context but must not reply, react, or perform another provider mutation for that message. Reply role does not remove the Channel Session's normal IM credentials or CLI capabilities. If an ended-session fence prevents an ambient Thread delivery, the remaining Channel delivery is an ordinary owner delivery, not an observer copy.

Trusted direct continuity comes only from the current event directly addressing the Agent, a prior direct inbound delivery to the active Thread Session, or a reliable root identifier whose inbound root was delivered directly to the same Agent's Channel Session. Merely creating or waking a Thread Session does not turn ambient messages into direct ones. Ending a Thread Session blocks ambient traffic and old root evidence from reviving it; a new current direct event may create a new active Session.

Slack uses `thread_ts` as both the stable thread key and root message identifier. Feishu keeps `thread_id` as the thread key and uses `root_id` only when the provider supplies it; `parent_id` is never guessed to be the root. A reliable root discovered from an earlier inbound event in the same normalized thread may establish continuity for later events.

## Bootstrap history

The first direct delivery to a newly materialized Thread Session includes bounded, verifiable inbound context: the visible root message when a reliable root identifier exists, followed by prior messages from the same thread. The current message is excluded from history, and sibling threads are not included. Ambient materialization does not by itself add direct bootstrap history or establish direct continuity.

Channel and Thread Sessions remain distinct Runtime scopes. OpenTag does not copy the Channel Runtime transcript, observe Bot outbound messages, or depend on provider CLI send results to create continuity. The Agent can query additional native history with the official provider CLI when needed.
