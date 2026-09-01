# Server 可观测性

[English](../observability.md)

OpenTag Server 可选地通过 OTLP/HTTP 导出 OpenTelemetry traces。该能力默认关闭，覆盖 provider 连接、IM 入站、持久 delivery 与 Runtime 生命周期边界。

Tracing 不等于日志上传。Pino 仍将 server 日志写到 stdout；本能力不会把全部 stdout 日志上传到 Logfire。Logfire 只接收 spans、span attributes 和有界的 exception events。

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
