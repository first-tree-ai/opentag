# Internal Session collaboration

> Canonical source: [internal-session-collaboration.md](../internal-session-collaboration.md)
> Last synced with: 2026-08-26

OpenTag Agent 可以通过两个 hosted tool，把工作委托给可复用的 internal Session：

- `create_internal_session` 会创建 internal Session，并原子提交首条文本消息。可选 `messageId` 是幂等键；收到
  `unknown` 或 `unreachable` 后，应使用返回的 ID、完全相同的首条消息与 overrides 重试。
- `send_session_message` 会向同一 collaboration scope 内的既有 Session 发送文本。可选 `messageId` 使用相同的
  显式重试语义。

这里的 collaboration scope 是运行中的 Session 边界：相同 Agent、IM binding、conversation kind、channel 与
thread。它不是 Workspace、Project、Collaboration aggregate 或其他产品管理实体，不授予跨 Agent 所有权，也不拥有
共享文件、长期记忆、Tasks、Secrets、Skills 或 billing。Context Tree 可以独立保存长期上下文，但不会扩大这条实时
Session 消息边界。

Internal Session 继承创建者的 Agent、IM binding、channel 或 thread scope、Computer placement 与共享 Agent work
area。它拥有独立 Agent Runtime，并可在创建时覆盖 model、reasoning effort 与最长 Run duration。它不接收 IM
delivery、provider message reference 或 `OPENTAG_PROVIDER_ENV_FILE`；结果与后续问题只通过
`send_session_message` 返回。

## Delivery 与持久化

Session 消息采用实时、best-effort collaboration。`accepted` 表示目标 Client 已把消息放入有界内存 FIFO，不表示
目标 Agent 已完成工作。目标忙碌时，会在当前 Run 结束后启动新 prompt Run，而不是 steer 正在执行的 Run。

Server 会在 `session_messages` 中只保存一次每条已授权逻辑消息，包括来源与目标 Session、文本 hash、尝试次数和
最近观测到的 delivery 结果。这条持久事实用于跨重启冲突检测与幂等，不是 delivery queue：不存在 pending 状态、
lease、next-attempt 时间、后台 worker、启动扫描或自动 replay。`unknown` 或 `unreachable` 消息只有在调用者使用
相同 `messageId` 再次显式调用 tool 时才会重试。

每次显式尝试都由单调递增的 attempt number fencing，因此旧尝试的迟到结果不能覆盖较新的观测。未授权、已结束、
placement 过期或跨 scope 请求会在创建消息事实前被拒绝。

## Rolling compatibility

Client 与 Server 仅在 runtime protocol v2 协商可选 `runtime.sessionCollaboration` capability 后暴露 collaboration。
既有 v1 连接和未协商该 capability 的 v2 peer 会继续使用现有 IM 与 Agent Runtime 路径，不会看到 collaboration tool
或 internal-Session reconcile 字段。重连改变已协商 hosted-tool 集合时，即使 placement 与 runtime revision 未变，
Client 也会重新 prepare 既有 idle Session。Session 使用新的已协商 tool surface 恢复前，会先关闭旧 provider runtime。

Codex App Server 只在线程启动时注册 dynamic tool。持久 Codex binding 与协商后的 hosted-tool 定义不一致时，Client
会显式选择创建 provider，而不是 resume；只在创建成功后保存新 binding。`AgentRuntimeFactory.resume` 保持精确语义，
遇到 hosted-tool mismatch 会拒绝，不会静默启动另一线程。后续启动会正常 resume replacement thread；provider 默认
native tool 与 hosted tool 仍可并存。对称 replacement 会在不再协商 collaboration 时移除 dynamic tool。OpenTag
Session identity 保持稳定，但每次这种 capability 过渡都会有意重置 Codex provider transcript。
