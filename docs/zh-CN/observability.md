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
- 每个 Slack Events API 投递都有一个 `im.inbound.process` span，嵌套在请求 span 下，覆盖 acknowledged、ignored、rejected 和 failed 四种结果。
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

Slack ingress 在 `im.inbound.process` 上额外记录有界属性：`slack.envelope_type`、`slack.event_type`、`slack.subtype`、
`slack.ignored_reason`、`slack.retry_num`、`slack.retry_reason` 和 `slack.ingest.duration_ms`。所有由 Slack 控制的 label
都必须匹配 `^[a-z0-9_.]{1,64}$`，否则记为 `other`；`slack.retry_reason` 只取 Slack 文档列出的取值。因此 Slack 侧的任意字符串
不可能造成属性基数失控。

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
4. 若 Agent 已运行但 provider 中没有回复，检查 Agent trace 与 provider CLI 结果；OpenTag 不接收或追踪 provider 出站写入。

没有 `im.inbound.process` 只表示 OpenTag 在已采样时间窗口内没有观测到 provider callback，不能证明飞书已经投递 event。需要结合 `connection`、`lastInboundAt`、`providerCliReadiness`、已授权 scopes 和飞书事件订阅状态判断。

## 排查 Slack Bot 无响应

和飞书一样，先查看当前状态：

```bash
opentag agent im diagnose <agent-id>
```

Slack ingress 由请求驱动而非长连接驱动，因此没有 connection spans 可查。请在事故时间窗口内查询
`opentag.im.provider = slack` 的 `im.inbound.process`，并读取 `opentag.operation.outcome`：

| Outcome | 含义 | 下一步 |
| --- | --- | --- |
| `succeeded` | event 已 normalize 并落库。 | 用 `opentag.im.message.id` 串联 delivery 与 Runtime spans。 |
| `ignored` | OpenTag 有意返回 `200`，且没有 ingest 任何内容。 | 读 `slack.ignored_reason`。 |
| `rejected` | OpenTag 返回了非 2xx。调用方不应原样重发该请求。 | 读 `opentag.error.code`。 |
| `failed` | 处理过程抛错，Slack 会重试。 | 读 `opentag.error.code`。 |

带类型的失败 code 如下：

- `SLACK_INBOUND_SIGNATURE_INVALID` — 签名无法用已存储的 Signing Secret 验证通过。
- `SLACK_INBOUND_UNROUTABLE` — 没有匹配到 binding，或 body 根本无法确定路由。
- `SLACK_INBOUND_IDENTITY_MISMATCH` — envelope 的 App 或 Team 与 binding 不一致。
- `SLACK_INBOUND_UNSUPPORTED_EVENT` — 结构合法且可路由，但不是 OpenTag 会 ingest 的 event type 或 subtype。
- `SLACK_INBOUND_NORMALIZE_FAILED` — 已验证的 event 无法 normalize。
- `SLACK_INBOUND_DATABASE_FAILED` — 落库失败。
- `SLACK_INBOUND_FAILED` — 未分类的处理失败。

### 事件订阅的失败预算

当 60 分钟窗口内约 95% 以上的投递失败时，Slack 会停用该 App 的事件订阅，并且把每个非 2xx 响应都计为失败。因此 Bot 无响应
往往是**订阅已被停用**（由更早的错误累积导致），而不是当前请求路径有问题。

OpenTag 只把非 2xx 留给「调用方不应原样重发」的请求：签名失败、binding 不可路由或未知、App/Team 身份不一致，以及结构非法的
body。这些响应还会带上 `x-slack-no-retry`，因为重发必然同样失败。对于结构合法、可路由，但 event type 或 subtype 属于
OpenTag 有意忽略的回调，则返回 `200` 和 `{"ok":true,"ignored":"<reason>"}`，并记录 `slack.ignored_reason`，这样普通的系统
消息流量就不会消耗失败预算。

订阅一旦被停用，请求根本不会到达，也就不会有 span。缺少 `im.inbound.process` 不能证明 Slack 投递过任何东西：请到 App 的
**Event Subscriptions** 页面确认订阅是否被停用，再结合 `lastInboundAt`、`providerCliReadiness` 和已授权 scopes 判断。

### Signing Secret 被重新生成

在 Slack App 配置里重新生成 Signing Secret，会使 OpenTag 能验证的所有签名立即失效。典型症状是：此前健康的 binding 突然出现
一批带 `SLACK_INBOUND_SIGNATURE_INVALID` 的 `rejected` spans；而由于它们是非 2xx，失败预算会立刻开始消耗。恢复方式是在 IM
页面用 **Edit credentials** 提交新的 secret，见 [Slack App 接入](./slack-app-setup.md)。OpenTag 无从知晓的 secret 轮换与攻击者
伪造签名不可区分，因此只能拒绝而不能确认。

### `app_rate_limited`

当某个 workspace 在一分钟内超过事件投递上限时，Slack 会发送 `app_rate_limited` envelope 而不是 events。OpenTag 会以 `200`
确认，记录携带 `slack.minute_rate_limited` 的 `slack.app_rate_limited` span event，并输出 `SLACK_APP_RATE_LIMITED` 告警日志。
没有任何 binding 字段存储它，所以 span 是唯一的持久记录。该分钟内的 events 已被 Slack 丢弃且不会重发，因此这类 span 附近出现
消息历史缺口是预期行为，而不是 OpenTag 的缺陷。

### 重试与重复

在收到非 2xx 或响应过慢后，Slack 最多重发一个 event 三次，并带上 `X-Slack-Retry-Num` 和 `X-Slack-Retry-Reason`。这两个 header
在签名验证之前就被读取，因此按不可信输入处理：数字长度受限，reason 只收敛到 Slack 文档列出的取值。它们会被记录到 ingress 和
persistence 两个 span 的 `slack.retry_num` 和 `slack.retry_reason`。provider-event 唯一性让重试成为 no-op，所以同一个
`opentag.im.provider_event.id` 出现多个 `200` 而只落库一条消息是预期形态，不是重复投递。

## 采样与限制

默认 sample rate 是 `1`。低流量且无响应事故较少时，生产建议保持 `1`；只有测量 trace 量级和成本后再降低这个单一全局值。MVP 没有 route-specific 或 provider-specific sampler。

已知限制：

- 异步 roots 通过业务 ID 关联，不持久化 W3C trace context。
- Server 重启会丢失内存中的 parent context 和 pending connection spans。
- 没有 OpenTelemetry Logs exporter、metrics exporter、Client tracing、Agent trace 转换或 PostgreSQL query tracing。
- Provider callback 未发生时，系统无法生成 message-specific ID 或 message span。
