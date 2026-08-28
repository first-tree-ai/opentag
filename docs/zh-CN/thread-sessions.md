# IM Channel 与 Thread Session

> Canonical source: [thread-sessions.md](../thread-sessions.md)
> Last synced with: 2026-08-28

OpenTag 为每个 Agent、Integration 和 IM channel 保留一个长期 Channel Session。顶层消息直接寻址 Agent 时，消息会进入该 Channel Session；OpenTag 不会提前创建 Thread Session，也不会要求 Agent 必须在 provider 原生 thread 中回复。

Agent 会在 managed context 中收到 provider 原生消息引用，以及针对当前 target 的 `direct` 或 `ambient` attention。Attention 描述这条入站消息对该 Session 的含义；它与 receive mode、Session 创建方式及凭证可用性相互独立。

## 惰性 Thread 连续性

只有真实 provider 入站事件带有规范化 thread key 时，OpenTag 才物化 Thread Session。之后按 Agent 的 receive mode 路由：

- `all_message` 模式下，即使消息没有直接寻址 Agent，带 thread scope 的事件也会物化或唤醒 Thread Session。除非存在可信 direct 连续性证据，否则 Thread delivery 仍为 `ambient`。Channel Session 会同时收到同一消息的独立 `ambient` observer copy。
- `mention_only` 模式下，未寻址消息只有在已经建立可信 direct 连续性后才投递给 Thread Session；否则既不投递，也不物化 Thread Session。

当同一消息同时进入两个 scope 时，Thread Session 是 reply owner；Channel observer copy 只用于频道级上下文，不得针对该消息回复、Reaction 或执行其他 provider mutation。Reply role 不会移除 Channel Session 原有的 IM 凭证或 CLI 能力。如果 ended-session fence 阻止了 ambient Thread delivery，剩余的 Channel delivery 是普通 owner，而不是 observer。

可信 direct 连续性只来自：当前事件直接寻址 Agent、active Thread Session 过去已有 direct 入站 delivery，或 provider 提供可靠根消息标识且该入站根消息曾 direct 投递给同一 Agent 的 Channel Session。仅仅创建或唤醒 Thread Session 不会把 ambient 消息变成 direct。结束 Thread Session 后，ambient 流量和旧 root 证据都不能复活它；新的当前 direct 事件仍可创建新的 active Session。

Slack 使用 `thread_ts` 同时作为稳定 thread key 和根消息标识。飞书使用 `thread_id` 作为 thread key；只有 provider 提供 `root_id` 时才使用它，绝不把 `parent_id` 猜测成根消息。同一规范化 thread 中更早的入站事件若携带可靠 root，后续事件可以复用该事实建立连续性。

## Bootstrap history

新物化 Thread Session 的首次 direct delivery 会包含有界且可验证的入站上下文：若存在可靠根消息标识，则先包含可见根消息，再包含同一 thread 的历史消息。当前消息不会在 history 中重复，sibling thread 也不会混入。Ambient 物化本身不会附加 direct bootstrap history，也不会建立 direct 连续性。

Channel 与 Thread Session 始终是两个不同的 Runtime scope。OpenTag 不复制 Channel Runtime transcript，不观察 Bot 出站消息，也不依赖 provider CLI 发送结果建立连续性。需要更多原生历史时，Agent 可以直接使用官方 provider CLI 查询。
