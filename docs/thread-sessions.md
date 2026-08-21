# IM Channel and Thread Sessions

[简体中文](./zh-CN/thread-sessions.md)

OpenTag keeps one long-lived Channel Session per Agent, Integration, and IM channel. A top-level message addressed to the Agent is delivered to that Channel Session; OpenTag does not pre-create a Thread Session or require the Agent to reply in a native thread.

The Agent receives the provider-native message reference and `direct` or `ambient` attention in managed context. Its prompt and conversation context determine whether it replies at the top level, starts or continues a native thread, reacts, sends another message, or takes no provider action. Server routing does not encode Feishu- or Slack-specific reply preferences.

## Lazy Thread continuity

A Thread Session is materialized only after a real inbound provider event carries a thread scope. OpenTag delivers that event directly to the Thread Session when, in priority order:

1. an active Session already owns the same thread;
2. the current event directly addresses the Agent; or
3. the provider supplies a reliable root identifier and that inbound root message was previously delivered directly to the same Agent's Channel Session.

Without that evidence, OpenTag does not infer Thread ownership. In `all_message` mode, the Channel Session still receives its independent ambient delivery. Ending a Thread Session blocks old root evidence from implicitly reviving it; a later event that directly addresses the Agent may create a new active Session.

Slack uses `thread_ts` as both the stable thread key and root message identifier. Feishu keeps `thread_id` as the thread key and uses `root_id` only when the provider supplies it; `parent_id` is never guessed to be the root.

## Bootstrap history

The first direct delivery to a newly materialized Thread Session includes bounded, verifiable inbound context: the visible root message when a reliable root identifier exists, followed by prior messages from the same thread. The current message is excluded from history, and sibling threads are not included.

Channel and Thread Sessions remain distinct Runtime scopes. OpenTag does not copy the Channel Runtime transcript, observe Bot outbound messages, or depend on provider CLI send results to create continuity. The Agent can query additional native history with the official provider CLI when needed.
