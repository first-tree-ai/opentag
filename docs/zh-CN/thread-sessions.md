# IM Channel 与 Thread Session

> Canonical source: [thread-sessions.md](../thread-sessions.md)
> Last synced with: 2026-08-21

OpenTag 为每个 Agent、Integration 和 IM channel 保留一个长期 Channel Session。顶层消息直接寻址 Agent 时，消息会进入该 Channel Session；OpenTag 不会提前创建 Thread Session，也不会要求 Agent 必须在 provider 原生 thread 中回复。

Agent 会在 managed context 中收到 provider 原生消息引用和 `direct` 或 `ambient` attention。Agent 根据 prompt 和对话上下文自主决定平级回复、创建或继续原生 thread、Reaction、发送其他消息或不执行 provider 动作。Server routing 不编码飞书或 Slack 的回复偏好。

## 惰性 Thread 连续性

只有真实 provider 入站事件带有 thread scope 时，OpenTag 才物化 Thread Session。系统按以下优先级判断是否把该事件 direct 投递给 Thread Session：

1. 已有 active Session 持有同一 thread；
2. 当前事件直接寻址 Agent；
3. provider 提供可靠根消息标识，且该入站根消息此前曾 direct 投递给同一 Agent 的 Channel Session。

没有这些证据时，OpenTag 不推断 Thread 所有权。`all_message` 模式下，Channel Session 仍独立收到 ambient delivery。结束 Thread Session 后，旧的 root 证据不能隐式复活它；后续事件若再次直接寻址 Agent，则可以创建新的 active Session。

Slack 使用 `thread_ts` 同时作为稳定 thread key 和根消息标识。飞书使用 `thread_id` 作为 thread key；只有 provider 提供 `root_id` 时才使用它，绝不把 `parent_id` 猜测成根消息。

## Bootstrap history

新物化 Thread Session 的首次 direct delivery 会包含有界且可验证的入站上下文：若存在可靠根消息标识，则先包含可见根消息，再包含同一 thread 的历史消息。当前消息不会在 history 中重复，sibling thread 也不会混入。

Channel 与 Thread Session 始终是两个不同的 Runtime scope。OpenTag 不复制 Channel Runtime transcript，不观察 Bot 出站消息，也不依赖 provider CLI 发送结果建立连续性。需要更多原生历史时，Agent 可以直接使用官方 provider CLI 查询。
