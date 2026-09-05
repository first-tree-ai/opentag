# Server 可观测性

[English](../observability.md)

OpenTag Server 可选地通过 OTLP/HTTP 导出 OpenTelemetry traces。该能力默认关闭，覆盖 provider 连接、IM 入站、持久 delivery 与 Runtime 生命周期边界。

Tracing 不等于日志上传。Pino 仍将 server 日志写到 stdout；本能力不会把全部 stdout 日志上传到 Logfire。Logfire 只接收 spans、span attributes 和有界的 exception events。

## 日志契约

日志使用固定词表。每个概念只用一个 key，避免 dashboard 与后续采纳 lane 还要合并同义字段：

| 概念 | Pino 字段 | 说明 |
| --- | --- | --- |
| 模块 | `module` | 所属 package 或 service 边界。 |
| 操作 | `operation` | 稳定的操作名，不是自由描述。 |
| 请求关联 | `requestId` | HTTP 或 client 请求标识符。 |
| Account 边界 | `accountId` | Agent 及其资源的租户边界。 |
| Agent、Computer、Session、Delivery | `agentId`、`computerId`、`sessionId`、`deliveryId` | 稳定的资源标识符。 |
| Provider | `provider` | provider 名称，例如 `feishu` 或 `slack`。 |
| 结果 | `outcome` | 稳定的状态转换，例如 `accepted`、`failed` 或 `rejected`。 |
| 错误标识 | `errorCode` | 使用 structured error code。不要为同一概念另造 `reason`、`errorReason`、`failureReason`、`dropReason` 或 `detail`。 |
| 尝试次数 | `attempt` | 数值型重试或执行次数。 |
| 耗时 | `durationMs` | 毫秒耗时。 |
| 状态 | `status` | 非 outcome 的协议或 provider 状态。 |

级别具有运维含义：`error` 表示终止或不可恢复，`warn` 表示已处理或降级，`info` 表示状态转换，`debug` 表示单请求细节。message 保持简短，可查询的值放进上表字段。

Client logger 遵循以下 `OPENTAG_LOG_LEVEL` 矩阵：

| 环境 | OPENTAG_LOG_LEVEL | 生效级别 |
| --- | --- | --- |
| 测试 | 未设置 | `silent` |
| Service 模式或显式 `file`/`dual` 目标 | 未设置 | `info` |
| 未配置目标的一次性 client | 未设置 | `warn` |
| 任意模式 | 合法的 `trace`、`debug`、`info`、`warn`、`error`、`fatal` 或 `silent` | 所选级别 |
| 任意模式 | 非法值 | `info`，并输出一条安全告警 |

`imAttrs()` 与 `runtimeAttrs()` 是 OpenTelemetry helper，产出的是点分 span key，例如 `opentag.im.binding.id` 与 `opentag.runtime.connection.id`；**不要**把它们的返回值直接作为 Pino payload，应改为映射到上面固定的 camelCase Pino 词表。

## 配置

`OPENTAG_OTEL_ENDPOINT` 为空时 tracing 关闭。Exporter 会精确使用配置的 URL，并接受任意有效的 OTLP collector headers。

```bash
OPENTAG_OTEL_ENDPOINT=https://logfire-us.pydantic.dev/v1/traces
OPENTAG_OTEL_HEADERS="Authorization=Bearer <write-token>"
OPENTAG_OTEL_ENVIRONMENT=production
OPENTAG_OTEL_SAMPLE_RATE=1
```

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OPENTAG_OTEL_ENDPOINT` | 空 | OTLP/HTTP traces endpoint；非空即启用 tracing |
| `OPENTAG_OTEL_HEADERS` | 空 | 逗号分隔的 `key=value` headers，原样传给 OTLP trace exporter |
| `OPENTAG_OTEL_ENVIRONMENT` | `OPENTAG_ENV` | `deployment.environment.name` resource 标签 |
| `OPENTAG_OTEL_SAMPLE_RATE` | `1` | `[0,1]` 范围内的全局 head sample rate |
| `OPENTAG_LOG_LEVEL` | `info` | Server Pino level：`trace`、`debug`、`info`、`warn`、`error`、`fatal` 或 `silent` |

服务 resource 固定为 `service.name=opentag-server`。每个进程还会把随机启动标识写入 `service.instance.id`，用于区分 replica 和重启。

在 CapRover 中，把四个值添加为应用环境变量，并将 header 标记为 secret。不要把 Logfire token 提交到 `.env.example`、Docker image layer、仓库文件或 CapRover build argument。修改 tracing 配置后重启应用。

endpoint 和 attribute vocabulary 保持 OTLP 语义。Logfire 是当前文档中的 backend，但同样支持 API key、tenant header、非 Bearer authorization 或自定义 trace path 的 collector。格式错误或重复的 header entry 会让 server 启动失败，错误信息不会回显 header value。

Server 自行管理显式的 OpenTelemetry trace provider 和 OTLP exporter，只接受 canonical Fastify instrumentation 与 OpenTag 显式业务 spans。不会安装 Logfire 的进程级自动异常上报或 Node auto-instrumentations，因此 Pino records、PostgreSQL queries、outbound transports 和任意进程异常都不能绕过 telemetry scrubber。

## 观测范围

- 普通 Fastify 请求各有一个 root span，名称使用 route template，并通过响应 `x-trace-id` 关联。health、readiness、静态资源和 Runtime WebSocket upgrade 不观测为普通 HTTP span。
- `runtime.ws.connection` 以及非 heartbeat 的短 Runtime business-frame spans。
- 飞书连接 attempt、transition、error 短 spans。
- 每个飞书 SDK callback 都有独立的 `im.inbound.process` root，覆盖 normalize 和 persistence 失败。
- Provider-neutral 的 `im.inbound.persist`、delivery/recovery 与 Runtime reconcile/delivery/report spans。

异步任务有意使用独立 roots。请用稳定属性查询，而不是期待一条连续 parent 链：

- `opentag.im.binding.id`
- `opentag.im.provider_event.id`
- `opentag.im.external_message.id`
- `opentag.im.message.id`
- `opentag.im.delivery.id`
- `opentag.session.id`
- `opentag.agent.id`
- `opentag.computer.id`
- `opentag.runtime.connection.id`
- `opentag.runtime.instance.id`
- `opentag.runtime.protocol.version`

消息正文、raw provider event、mentions、resources、sender identity、provider response body、prompt、模型输出、tool payload、authorization header、cookie、token、secret 和 credential 均不会上传或会被 scrub。

## 飞书入站去重

飞书入站投递有两个相互独立的去重键：

- 内存 adapter 快速路径把 envelope event ID 以及 message/revision 身份按租户和会话隔离。它限制为
  10 分钟、最多 10,000 条，只保护进程存活期间的即时 WebSocket 重试。
- 持久化 receipt claim 使用 `(im_binding_id, event_id)`。`feishu_inbound_receipts` 上的唯一索引
  负责跨实例选出唯一 winner。claim 成功后在 inbox 持久化完成时标记为 `processed`；处理失败时写入
  受限长度的诊断 code 并标记为 `failed`。
- inbox 持久化另外强制 `(im_binding_id, channel_id, external_message_id, provider_revision_key)`。
  因此不同 envelope event ID 也不能为同一逻辑消息创建第二个 revision，同时编辑或撤回 revision
  仍然可执行。

飞书不一定提供 envelope `event_id`。这种情况下，规范化只为 inbox 创建稳定的 message/revision
fallback，不 claim 持久化 receipt；binding 和会话范围内的语义唯一键仍负责没有 envelope ID 的重试。
Receipt 行是运行证据，应保留 30 天。定时数据库维护任务可以只删除超过该期限的 `processed` 或 `failed`
行；例行清理不得删除 `processing` 行，因为它们代表进行中的投递。

重复结果是脱敏且稳定的：`feishu.inbound.deduplicated` span 记录 binding、可用时的 provider event
ID、external message ID 和 `duplicate=true`，绝不记录 token 或消息内容。重复事件会被确认，不会再次写入
inbox、启动 Session、创建 Task 或追加上下文。

## IM 历史与 delivery 保留

IM delivery worker 默认每 5 秒运行一次有界 expiry 任务；retention 使用独立的有界任务，默认每 60 秒运行一次，
因为 90 天的保留窗口不需要与 expiry 使用相同频率。保留期限分别按 message 的 `occurred_at`、delivery 的
`expires_at` 以及 provider receipt 的 `received_at` 计算。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OPENTAG_IM_DELIVERY_JANITOR_INTERVAL_MS` | `5000` | expiry 任务间隔 |
| `OPENTAG_IM_DELIVERY_RETENTION_INTERVAL_MS` | `60000` | retention 任务间隔 |
| `OPENTAG_IM_DELIVERY_EXPIRY_BATCH_SIZE` | `100` | 每次最多标记为 `expired` 的 pending delivery 数量 |
| `OPENTAG_IM_DELIVERY_RETENTION_BATCH_SIZE` | `100` | 每张历史表每次最多删除的行数 |
| `OPENTAG_IM_MESSAGES_RETENTION_MS` | 90 天 | `im_messages` 保留期限 |
| `OPENTAG_IM_MESSAGE_DELIVERIES_RETENTION_MS` | 90 天 | `im_message_deliveries` 保留期限 |
| `OPENTAG_SLACK_WEBHOOK_RECEIPTS_RETENTION_MS` | 30 天 | Slack receipt 保留期限 |
| `OPENTAG_FEISHU_INBOUND_RECEIPTS_RETENTION_MS` | 30 天 | 飞书 receipt 保留期限 |

维护任务不会删除属于活跃 Session 的 delivery、仍被其他 delivery 作为 steer target 引用的 delivery，或仍在
进行中的（`processing`）receipt。只会删除终态 delivery（`expired`、`terminal_rejected`、已报告的
`accepted` 或已完成的 `steered`），并且只有在没有 delivery 引用时才删除 message。若部署需要不同的审计
期限，请通过环境变量显式设置 retention window 与 batch size；毫秒数和行数都必须是正整数。

## 排查飞书 Bot 无响应

先查看当前状态：

```bash
opentag agent im diagnose <agent-id>
```

然后在事故时间窗口查询 traces：

1. 按 `opentag.im.binding.id` 查询 `feishu.connection.connect`、`feishu.connection.transition` 和 `feishu.connection.error`，确认当前 replica 已连接，且没有持续重连或凭据失败。
2. 用同一 binding 查询 `im.inbound.process`。存在该 span 才能证明 OpenTag SDK callback 被调用；error code 可区分 admission、normalization、fencing 和 persistence 失败。
3. persistence 成功后，使用 `opentag.im.message.id` 和 `opentag.im.delivery.id` 串联 `im.delivery.dispatch`、`runtime.reconcile`、`runtime.delivery` 和 `runtime.report`。
4. 若 Agent 已运行但 provider 中没有回复，检查 Agent trace 与 provider CLI 结果；OpenTag 不接收或追踪 provider 出站写入。

没有 `im.inbound.process` 只表示 OpenTag 在已采样时间窗口内没有观测到 provider callback，不能证明飞书已经投递 event。需要结合 `connection`、`lastInboundAt`、`providerCliReadiness`、已授权 scopes 和飞书事件订阅状态判断。

## 采样与限制

默认 sample rate 是 `1`。低流量且无响应事故较少时，生产建议保持 `1`；只有测量 trace 量级和成本后再降低这个单一全局值。MVP 没有 route-specific 或 provider-specific sampler。

已知限制：

- 异步 roots 通过业务 ID 关联，不持久化 W3C trace context。
- Server 重启会丢失内存中的 parent context 和 pending connection spans。
- 没有 OpenTelemetry Logs exporter、metrics exporter、Client tracing、Agent trace 转换或 PostgreSQL query tracing。
- Provider callback 未发生时，系统无法生成 message-specific ID 或 message span。
