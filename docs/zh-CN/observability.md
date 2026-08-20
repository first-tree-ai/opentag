# Server 可观测性

[English](../observability.md)

OpenTag Server 可选地通过 OTLP/HTTP 导出 OpenTelemetry traces。实现遵循 First Tree 已验证的默认关闭、仅 trace 模式，并为 OpenTag 的 provider 连接、IM 入站、持久 delivery、Runtime 和 outbound 边界增加专属 spans。

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
- Provider-neutral 的 `im.inbound.persist`、delivery/recovery、Runtime reconcile/delivery/report 和 outbound spans。

异步任务有意使用独立 roots。请用稳定属性查询，而不是期待一条连续 parent 链：

- `opentag.im.binding.id`
- `opentag.im.provider_event.id`
- `opentag.im.external_message.id`
- `opentag.im.message.id`
- `opentag.im.delivery.id`
- `opentag.session.id`
- `opentag.agent.id`
- `opentag.computer.id`
- `opentag.runtime.instance.id`

消息正文、raw provider event、mentions、resources、sender identity、provider response body、prompt、模型输出、tool payload、authorization header、cookie、token、secret 和 credential 均不会上传或会被 scrub。

## 排查飞书 Bot 无响应

先查看当前状态：

```bash
opentag agent im diagnose <agent-id>
```

然后在事故时间窗口查询 traces：

1. 按 `opentag.im.binding.id` 查询 `feishu.connection.connect`、`feishu.connection.transition` 和 `feishu.connection.error`，确认当前 replica 已连接，且没有持续重连或凭据失败。
2. 用同一 binding 查询 `im.inbound.process`。存在该 span 才能证明 OpenTag SDK callback 被调用；error code 可区分 admission、normalization、fencing 和 persistence 失败。
3. persistence 成功后，使用 `opentag.im.message.id` 和 `opentag.im.delivery.id` 串联 `im.delivery.dispatch`、`runtime.reconcile`、`runtime.delivery` 和 `runtime.report`。
4. 回复失败时，用 `opentag.session.id`、`opentag.agent.id` 或 `opentag.request.id` 查询 `im.outbound.execute`。

没有 `im.inbound.process` 只表示 OpenTag 在已采样时间窗口内没有观测到 provider callback，不能证明飞书已经投递 event。需要结合 `connection`、`lastInboundAt`、`runtimeToolAvailable`、已授权 scopes 和飞书事件订阅状态判断。

## 采样与限制

默认 sample rate 是 `1`。低流量且无响应事故较少时，生产建议保持 `1`；只有测量 trace 量级和成本后再降低这个单一全局值。MVP 没有 route-specific 或 provider-specific sampler。

已知限制：

- 异步 roots 通过业务 ID 关联，不持久化 W3C trace context。
- Server 重启会丢失内存中的 parent context 和 pending connection spans。
- 没有 OpenTelemetry Logs exporter、metrics exporter、Client tracing、Agent trace 转换或 PostgreSQL query tracing。
- Provider callback 未发生时，系统无法生成 message-specific ID 或 message span。
