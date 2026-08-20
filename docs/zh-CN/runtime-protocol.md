# Runtime 协议兼容

[English](../runtime-protocol.md)

## 范围

Runtime 协议 v2 解除 OpenTag Client 与 Server 的同步发布依赖。它为滚动升级冻结并保留现有 v1 方言及其独立协商的 Provider readiness 扩展，同时增加 Capability 协商和逐连接 fencing。Delivery、Turn、Session 的幂等仍由各领域现有的请求身份和哈希负责。

本阶段不增加持久化 drain 状态、最低安全 Client 版本策略或通用持久请求账本。

## 版本分层

- **协议版本**：用于握手、控制帧状态机或连接 fencing 的变化。当前版本为 v2；Server 同时接受冻结的 v1。
- **Schema 版本**：属于单个领域 payload 或持久化 artifact。增加兼容字段不需要提升全局协议；语义或不兼容 payload 变化必须提升对应领域的 schema 或 Capability 版本。
- **Capability 版本**：标识一个 namespaced 行为契约，包括请求/结果 schema 与语义。Offer 使用闭区间 `{min,max}`；未知可选 offer 会被忽略。
- **Provider readiness 版本**：描述动态 Computer+Provider 观测的 schema；它与行为 Capability 独立协商，不能证明权限或持久支持。
- **发布版本**：只用于诊断和策略，不是 wire compatibility 的证明。

## v2 状态机与握手

```text
disconnected -> connecting -> authenticating -> welcoming -> registering -> registered
                         \-> terminal rejection
                         \-> explicit v1 fallback -> connecting
```

1. Client 发送严格的 v2 `auth` bootstrap 帧，并声明支持的协议区间。
2. 认证成功后，Server 发送可扩展的 v2 `server:welcome`，包含协议区间、Capability offers、Client 必需能力、heartbeat 策略，以及对独立 Provider readiness schema 的可选确认。
3. Client 为每项 Capability 选择交集中的最高版本，校验必需能力，再发送严格的 v2 `computer:register`，声明自身 offers 和 Server 必需能力。只有 Server 确认独立 readiness schema 后，Client 才附带动态 Computer+Provider readiness。
4. Server 重算交集，拒绝缺失的必需能力，注册 Computer，生成随机 `connectionId`，返回最终协商结果。
5. Client 重算并比对最终结果，完全一致后才进入 `registered`。

每项能力选择 `min(local.max, remote.max)`，前提是该值不小于 `max(local.min, remote.min)`。必需能力没有交集时，以 `PROTOCOL_CAPABILITY_UNSUPPORTED` 关闭连接。

## 滚动兼容

| Client | Server | 结果 |
| --- | --- | --- |
| v1 | v1 | 冻结的 v1 握手 |
| v1 | v2 | Server 的冻结 v1 adapter |
| v2 | v1 | 仅在匹配的 `PROTOCOL_VERSION_UNSUPPORTED` 响应后，第二条连接使用 v1 |
| v2 | v2 | v2 协商和连接 fencing |

发布顺序必须 Server v2 在先、Client v2 在后。v2 Client 遇到超时、传输失败、TLS 失败、畸形响应、不匹配错误或不兼容 welcome 时绝不回退。旧 Server 明确触发回退后，该 Client 进程在重启前保持 v1，避免拒绝循环；重启后会重新探测 v2。

## 解析与 fencing

- 基础 v1 握手和控制 schema 保持严格且 byte-compatible。Client 通过 WebSocket header 提供可选 Provider readiness v1 扩展；只有明确确认的 Server 才能增加 welcome 字段，并接受 register/heartbeat 中的 readiness。
- v2 认证、注册、必需能力和 fence 字段严格解析并 fail closed。
- v2 welcome 字段和 Capability offers 允许兼容扩展；未知可选字段和 offer 不会激活行为。
- 未知必需能力、未知控制帧、已知帧格式错误、二进制帧、超大帧和未知业务帧均 fail closed。
- 每个 v2 心跳帧和业务帧都携带 Server 签发的 `connectionId`。双方在领域解析或副作用前拒绝缺失或过期的值。bootstrap/error 帧保持无版本，以便不兼容 peer 能安全拒绝连接；它们仍绑定精确 socket。Transport 在业务帧进入领域 schema 前移除 fence，因此它不会改变领域幂等哈希。
- `instanceId` fence daemon 进程生命周期；`connectionId` fence 单条已注册 socket；placement generation 继续 fence Session placement。Server registry 在发送前后仍校验精确的当前 socket。
- Transport queue 不跨 socket 重放。领域重试按照现有策略复用稳定 `requestId` 和语义 payload hash。

## 对抗性检查

实现与测试覆盖：不匹配错误诱导降级、必需能力缺失、未知可选能力、非法区间、未确认或未准入的 Provider readiness、乱序控制帧、过期 connection ID、替换 socket、帧大小边界和协商结果不一致。认证先于 Capability 使用；Capability 协商不能授予权限或 readiness。

## 发布与回滚

发布门禁包括 v1/v2 兼容矩阵、包测试、build、typecheck、lint/format，以及 Client Agent Runtime coverage gate。先部署双栈 Server，保持 v2 Capability 的现有行为版本，再灰度 v2 Client。

新 Capability 改变持久化数据或语义之前，回滚方式是回退 Server image，并让 Client 使用 v1。激活此类能力后，必须为它单独制定 expand/contract 和回滚方案；协议协商不能替代数据库回滚。保留 v1，直到 fleet telemetry 和明确的废弃决策支持移除。
