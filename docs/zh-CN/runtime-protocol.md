# Runtime 协议兼容

> Canonical source: [../runtime-protocol.md](../runtime-protocol.md)
> Last synced with: 2026-10-09

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

## Provider readiness 的 provider 范围

Provider readiness 版本与传输协议 v1/v2 独立。Readiness v1 固定只包含 `codex` 和
`claude-code`；v2 加入 `pi`。两个版本都使用明确列表，新增产品 provider 不能自动扩大已有协议版本。

新 Client 同时发送 `x-opentag-provider-readiness: 1` 和
`x-opentag-provider-readiness-v2: 2`。新 Server 只有收到明确的 v2 声明后才选择 v2，
并在 welcome 中确认 `{version: 2, providers: [...]}`。旧 Server 仍能识别原有 v1 header，
返回原有 provider 范围。Client 只上报本连接确认的 provider，Server 拒绝 register 或 heartbeat
中未经协商的观测。

| Client 声明 | 新 Server 响应 |
| --- | --- |
| 无可识别的 readiness header | 不返回 readiness 扩展 |
| 仅 v1 | v1，Codex 和 Claude Code |
| v1 加 v2，或仅 v2 | v2，Codex、Claude Code 和 Pi |
| v2 值不支持，但 v1 有效 | v1，Codex 和 Claude Code |

Account Computer 列表的 HTTP 投影也遵循相同 header：旧调用方保留 v1 provider 列表，
明确声明 v2 的调用方可以收到 Pi，没有可识别声明的调用方不会收到 readiness 扩展。
存储和实时观测仍保持完整；HTTP 兼容过滤不会改变 provider 准入。

Computer 投影同时遵循当前 daemon 连接协商的 provider 范围。范围之外的 provider
显示为 `unavailable`，不生成探测时间；已协商但尚未收到新观测的 provider 仍为 `checking`。
因此，新 Web/CLI 查看仅支持 v1 的 daemon 时，Pi 会显示为不可用，不会无限等待。
连接替换后，支持范围也随之替换。

## 本地模型选项与缓存归属

可选的 `runtime.agentRuntimeOptions` capability（版本 1）服务于
`GET /api/v1/agents/:agentId/runtime-options?model=...`。Server 校验 Account 权限，
读取 Agent 绑定的 Local Computer 和 provider，再向该 Computer 当前 daemon 发送
`agent-runtime:options` 请求。Client 查询原生 provider CLI，返回模型 ID 和所选模型的
推理强度。Server 返回结果前再次核对 Agent 归属的 Computer 和 provider。

| 数据 | 保存位置与隔离标识 | 生命周期 |
| --- | --- | --- |
| Web 查询结果 | 浏览器内存，键包含 `agentId`、`computerId`、provider、model | 30 秒内视为新鲜；可见的模型页面每 30 秒轮询；页面重新激活和网络恢复时重新请求；退出登录清空缓存 |
| Server 请求 | 内存中的待处理 Map，以随机 `requestId` 标识，并校验 `computerId` 和 `instanceId` | 完成、取消或超时后删除；不持久化模型目录 |
| 原生 provider 目录 | CLI 及其本地 provider 配置自行管理 | 随 provider 而异；OpenTag 不清除或持久化此缓存 |
| 用户保存的模型与强度 | PostgreSQL `agent_runtime_configs`，按 `agent_id` 保存 | 仅保存配置时写入，并校验预期 revision |

HTTP 响应使用 `Cache-Control: no-store`。模型页面挂载且可见时自动更新，隐藏页面、
离开页面或 Computer 离线后停止轮询。后台更新保留未保存的选择，不在已确认的选项上
显示加载提示。每次更新会发起一次新的原生查询，不是后台上传模型目录，也不会清除
provider 自身的缓存。不同 Computer 不会覆盖 Server 上的一份
共享模型目录。其他 Computer 或旧 daemon 实例的响应不能完成当前待处理请求。

Web 模型选择器合并原生结果与预置建议并去重，较小的原生目录不会隐藏预置项。
Codex 预置包含当前的 `gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-luna`，以及兼容用的
`gpt-6-sol`，来源见 [OpenAI 模型目录](https://developers.openai.com/api/docs/models)。
旧 ID 仍可通过原生结果、已保存配置或自定义输入使用。建议项不能证明账号权限。
推理强度仍使用所选模型的原生元数据；未知元数据明确标为未确认。

刷新选项不会保存 Agent 配置，也不会修改本地 CLI 默认值。将模型或强度保存为 `null`
表示继承本地配置；它们是每个 Agent 的覆盖值，不是每台 Computer 的模型目录。

## 解析与 fencing

- 基础 v1 握手和控制 schema 保持严格且 byte-compatible。Client 通过 WebSocket headers 提供独立协商版本的可选 Provider readiness 扩展；只有明确确认的 Server 才能增加 welcome 字段，并接受 register/heartbeat 中的 readiness。
- v2 认证、注册、必需能力和 fence 字段严格解析并 fail closed。
- v2 welcome 字段和 Capability offers 允许兼容扩展；未知可选字段和 offer 不会激活行为。
- 未知必需能力、未知控制帧、已知帧格式错误、二进制帧、超大帧和未知业务帧均 fail closed。
- 每个 v2 心跳帧和业务帧都携带 Server 签发的 `connectionId`。双方在领域解析或副作用前拒绝缺失或过期的值。bootstrap/error 帧保持无版本，以便不兼容 peer 能安全拒绝连接；它们仍绑定精确 socket。Transport 在业务帧进入领域 schema 前移除 fence，因此它不会改变领域幂等哈希。
- `instanceId` fence daemon 进程生命周期；`connectionId` fence 单条已注册 socket；placement generation 继续 fence Session placement。Server registry 在发送前后仍校验精确的当前 socket。
- Transport queue 不跨 socket 重放。领域重试按照现有策略复用稳定 `requestId` 和语义 payload hash。

## Channel target 广播

可选的 `runtime.channelTarget` capability（版本 1）让已连接的 Client 获知用于自动升级的 channel 精确最新目标。当该 capability 协商成功后，每个 v2 `heartbeat:result` 都可以携带可选的 `channelTarget` 字段：Server 自身的 release channel，以及它当前广播的精确 SemVer（从该 channel 已发布的 release 指针读取）。该字段是可选扩展且经过协商，因此使用严格 heartbeat schema 的旧 Client 永远不会收到它；连接旧 Server 的 Client 则只是看不到目标。Client 只有在 version 字符串完全一致时才视为已经是当前目标；SemVer precedence 只用于拒绝更旧的目标，而 precedence 相同但 build metadata 不同的目标仍会安装。属于其他 channel 的目标在任何升级决策之前就会被拒绝。

## 对抗性检查

实现与测试覆盖：不匹配错误诱导降级、必需能力缺失、未知可选能力、非法区间、未确认或未准入的 Provider readiness、乱序控制帧、过期 connection ID、替换 socket、帧大小边界和协商结果不一致。认证先于 Capability 使用；Capability 协商不能授予权限或 readiness。

## 发布与回滚

发布门禁包括 v1/v2 兼容矩阵、包测试、build、typecheck、lint/format，以及 Client Agent Runtime coverage gate。先部署双栈 Server，保持 v2 Capability 的现有行为版本，再灰度 v2 Client。

新 Capability 改变持久化数据或语义之前，回滚方式是回退 Server image，并让 Client 使用 v1。激活此类能力后，必须为它单独制定 expand/contract 和回滚方案；协议协商不能替代数据库回滚。保留 v1，直到 fleet telemetry 和明确的废弃决策支持移除。
