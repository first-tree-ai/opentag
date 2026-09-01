# 错误分类与后台监督

[English](../error-taxonomy.md)

OpenTag 将运行时失败报告为小型、结构化的 diagnostic event。事件在跨越日志、指标或 trace 边界前会先脱敏，因此可以安全地发送到这些 sink。Structured error 是运行契约，不是 API response 契约；面向 Client 的 HTTP response 仍使用现有 `ErrorEnvelope`。

## 结构

`StructuredErrorSchema` 要求以下字段：

| 字段 | 含义 |
| --- | --- |
| `code` | 用于 dashboard 和告警规则的稳定、有界标识。尽量使用大写 domain 前缀。 |
| `category` | 下表中的高层失败类别。 |
| `retryability` | 安全 retry 策略。retry 仍需要幂等操作和调用方 deadline。 |
| `phase` | 观测到失败的生命周期边界。 |
| `message` | 简短的人类可读细节；有长度限制，不得包含 credential 或 request 内容。 |
| `requestId` | 可选的 request 或 delivery 关联标识；不得使用 token 或 provider credential。 |
| `cause` | 可选的同样安全的有界 cause 链；原始 exception object 不得跨越边界。 |

类别包括 `validation`、`auth`、`authorization`、`unavailable`、`timeout`、`internal`、`conflict`、`not_found`、`rate_limit`、`protocol`、`configuration`、`cancelled` 和 `dependency`。

Retryability 的值为 `never`、`immediate`、`backoff` 和 `after_auth`。`phase` 可为 `validation`、`authentication`、`authorization`、`configuration`、`startup`、`request`、`transport`、`provider`、`persistence`、`dispatch`、`socket`、`scheduler`、`worker`、`serialization`、`shutdown` 或 `unknown`。

## 脱敏与序列化

使用 `redactSensitive(value)` 获取内存中的脱敏副本，使用 `redactForLog(value)` 获取适合 Pino 的脱敏且逐字符串 UTF-8 有界副本，使用 `boundedSerialize(value)` 获取有界日志或 trace 字符串。Helper 会脱敏包含 authorization、cookie、token、secret、credential、password、API key、request/response body、payload、prompt 或 tool input/output 的 key，也会清理 bearer、其他 authorization scheme、cookie/header value、credential query parameter 和数据库 URL credential。循环、过深结构、大数组和大对象都会被替换或限制；默认序列化预算为 16 KiB UTF-8，日志字段中的每个字符串最多 4 KiB UTF-8。

脱敏是最后一道边界，不代表可以把 secret 放入 diagnostic object。不要记录完整 request body、prompt、provider response、cookie、authorization header、access token、password 或 connection string。保留原始 exception 给业务路径；只有派生的 structured error 可观测。

## 日志词汇与级别

运行日志对每个概念使用固定的 Pino key：`module`、`operation`、`requestId`、`workspaceId`、`agentId`、`computerId`、`sessionId`、`deliveryId`、`provider`、`outcome`、`errorCode`、`attempt`、`durationMs` 和 `status`。其中 structured failure identity 只能使用 `errorCode`；不要把 `reason`、`errorReason`、`failureReason`、`dropReason` 或 `detail` 当作同义词。`error` 表示终止或不可恢复，`warn` 表示已处理或降级，`info` 表示状态转换，`debug` 表示单请求细节。

Client 的 `OPENTAG_LOG_LEVEL` 行为是：测试中未设置时为 `silent`，Service 或显式 file/dual logger 未设置时为 `info`，one-shot logger 未设置时为 `warn`，有效 level 选择对应级别，无效值回退到 `info` 并输出一次安全 warning。支持的值为 `trace`、`debug`、`info`、`warn`、`error`、`fatal` 和 `silent`。

`imAttrs()` 和 `runtimeAttrs()` 输出带点的 OpenTelemetry span key，不是 Pino payload。写日志前请把其中的值转换到固定日志词汇。

## Adoption 指南

在 detached scheduler work、WebSocket 生命周期回调、heartbeat/close 清理和 process signal shutdown promise 外包裹 `BackgroundFailureSupervisor.track`；调用方需要收到原始 rejection 时使用 `supervise`。提供 request 或 delivery ID、runtime phase、稳定 code 和明确 retry policy。

在 provider、database、filesystem 和 child-process 边界捕获失败，在拥有足够上下文的边界分类。传递 error 作为 cause，不要序列化 request 或 response。Provider connection loss 分类为 `unavailable`，deadline 到期分类为 `timeout`，malformed provider data 分类为 `protocol` 或 `dependency`。

CLI command failure 使用同一组 code/category/retryability/phase。向用户展示简短的脱敏消息和 request 或 operation ID；不要输出无界 stack trace。非零 exit status 是 presentation decision，不改变事件的 retryability。

## 当前集成点

初始检查发现以下位置需要在后续 integration pass 采用这些契约：`ImDeliveryWorker.#schedule()`、`KeyedTaskScheduler` pump、Runtime socket business frame、飞书 connection/setup timer 和 lifecycle callback，以及 `packages/server/src/index.ts` 中未等待的 `app.close()`。本 foundation lane 只建立 seam，不修改 runtime、service、API、Client 或 application call site。
