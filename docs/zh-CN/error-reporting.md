# 客户端错误上报

[English](../error-reporting.md)

> Last synced with: 2026-09-22

OpenTag 会把发生在 Web App 与 CLI 中的失败经由 server 中继到
[Google Cloud Error Reporting](https://cloud.google.com/error-reporting/)。两端客户端都不持有 Google 凭据，也不直接访问
Google：它们只向自己的 OpenTag server 发送一份小而脱敏的报告，server 再通过官方 `@google-cloud/error-reporting` 库转发。
server 自身的失败不走这条路径，它们由 [Server 可观测性](./observability.md) 覆盖。

本版本中上报始终开启。客户端没有开关、环境变量或配置项可以关闭它。运维人员控制的是目的地：没有配置 Google Cloud
project 的 server 会把每一份报告留在自己的日志里，不转发任何内容。

## 上报内容

每份报告都是一个 `ErrorReportRequest`（`packages/shared/src/error-report.ts`），在 server 端严格校验。未知字段会被拒绝，
因此客户端无法附带 schema 未命名的任何内容。

| 字段 | 来源 | 内容 |
| --- | --- | --- |
| `source` | 两端 | `web` 或 `cli` |
| `message` | 两端 | 脱敏后的错误消息，最多 4 KiB |
| `stack` | 两端 | 脱敏后的堆栈，最多 16 KiB，仅在运行时产生了堆栈时存在 |
| `code` | 两端 | 稳定的诊断代码，例如 `unhandled_error` 或 `REQUEST_FAILED` |
| `version` | 两端 | Web App 构建标识，或 CLI 包版本 |
| `channel` | CLI | 发布渠道：`dev`、`staging` 或 `prod` |
| `environment` | Web App | Vite mode，例如 `production` |
| `url` | Web App | 去掉 query string、fragment 与任何凭据后的页面 URL；server 在解析时会再次剔除它们，并拒绝非 HTTP(S) URL |
| `command` | CLI | 命令路径，例如 `agent create`，绝不包含参数 |
| `userAgent` | Web App | 浏览器 user agent |
| `occurredAt` | 两端 | ISO 8601 时间戳 |

报告中不存在账号标识、session、token、cookie 或 user 字段，server 也不会添加。在 Error Reporting 中，事件以服务
`opentag-web` 与 `opentag-cli` 出现，并以报告的 `version` 作为服务版本，因此回归可以归因到具体发布。

## 报告来源

**Web App。** `apps/web/src/features/error-boundary.tsx` 中的 React error boundary（应用级 boundary、路由错误页与
React root 错误处理器）以及 `apps/web/src/observability/diagnostics.ts` 中的 window 诊断（未处理的 promise rejection
、React 之外的未捕获异常（例如定时器或原生事件监听器中抛出的）以及同源资源加载失败）原本就会把每个失败写到 console；
现在它们还会把失败交给 `src/main.tsx` 中安装的错误上报 sink。只有 error 级别的诊断会被中继；warning 属于已处理或降级路径，
不是缺陷，React 的 recoverable error（例如 hydration 不匹配）也留在 console 路径上，因为 React 已经修复了它们。相同的 code 与 message 组合每 30 秒只发送一次，
因为一次渲染失败会被多个 boundary 观察到；支撑该冷却的表会丢弃过期条目，最多记住 200 个不同的失败。同源资源加载失败只按
code 去重而不按路径：部署之后，仍在运行旧构建的浏览器会请求已不存在的 chunk hash，这会在每个冷却期内产生一份
`resource_load_failed` 报告，而不是每个缺失文件各一份。每次部署后都应预期这份报告；它意味着客户端过期，而不是缺陷。
构建标识在构建时来自 `OPENTAG_WEB_VERSION`，缺省时回退到包版本。

**CLI 与 daemon。** CLI 入口（`apps/cli/src/cli/index.ts`）在呈现命令失败之后才上报，且只在失败描述的是程序本身而非
调用者时上报：类别 `internal`、`dependency` 与 `protocol`。校验、认证、授权、未找到、配置与取消属于答复而非缺陷，不会上报。
同一入口还安装了 `process.on("uncaughtException")` 与 `process.on("unhandledRejection")` 处理器（`@opentag/client` 中的
`installProcessErrorReporting`），它们通过 client logger 记录日志，最多等待两秒让报告发出，把失败写到 stderr 并等待
写入排空（最多一秒，以便通过管道重定向的 stderr 仍保留输出），然后以退出码 1 退出——与 Node 原本使用的退出码一致。由于 daemon 服务通过 CLI 运行（`daemon service-run`），它被同一套处理器覆盖，
并且 daemon 意外的终止性失败会在进程退出前上报。

CLI 报告发往本安装所连接的 server：Account 凭据中的 server URL，或仅有机器凭据时 Computer 身份中的 server URL。从未登录
或连接过的 CLI 不会发送任何内容。每份报告最多等待中继三秒。

## 中继端点

`POST /api/v1/error-reports`（`HTTP_PATHS.errorReports`）是匿名的：登录前的失败同样值得被看到，而 CSRF 双提交校验只适用
于已认证的浏览器写操作。该路由：

1. 按客户端地址限流，每个地址每分钟 30 份报告，超出时答复 `429`。预算按进程计，与浏览器登录路由的取舍相同；共享限流器
   应放在网关层。除非 `OPENTAG_TRUST_PROXY` 指定了反向代理（参见[位于反向代理之后](#位于反向代理之后)），该地址就是 socket
   对端；未设置时，在反向代理之后每份报告都来自代理地址，整个部署共享同一个每分钟 30 份的预算，超出预算的客户端会静默失败。
2. 依据 `ErrorReportRequestSchema` 校验请求体；未知字段、超长值或非 HTTP(S) 的 `url` 答复 `400`。解析时还会剔除 URL 的
   query string、fragment 与凭据，因此即便客户端没有遵守契约，契约在这里仍然成立。
3. 用 `redactForLog` 再次脱敏，并以 `warn` 级别写入 server 日志：消息为 `Client error reported`，带有
   `module=error-reporting`、`source`、`errorCode` 与 `errorReport` 载荷。没有 Google Cloud project 的运维人员仍能在这里看到每份报告。
4. 报告一经接受即答复 `202`（空 body，`cache-control: no-store`）。转发在后台进行。reporter 对每次转发最多等待五秒，
   之后记为失败，因为 Google 客户端自身不设截止时间且会带退避重试。这限制的是等待时长，而不是库自身的 HTTP 请求与重试，
   后者可能仍在后台继续；因此缓慢或被阻断的出口网络不会占住客户端连接。

### 滥用面

该端点按设计是匿名的，因此任何能访问 server 的人都可以提交文本，这些文本会进入运维人员的 `warn` 日志，并在启用转发时以
调用者自选的 `version` 出现在 Error Reporting 控制台的 `opentag-web` 或 `opentag-cli` 之下。schema 限制每个字段的长度并拒绝
未知字段，脱敏执行两次，而按地址限流是唯一的流量控制——并带有上文的代理注意事项。阅读中继来的文本时请将其视为不可信输入；
若部署暴露给恶意流量，请在前面加上网关限流。

## 脱敏

报告会被脱敏两次，一次在客户端、一次在 server，使用 `@opentag/shared` 中 [错误分类](./error-taxonomy.md) 所记载的共享
scrubber（`redactSensitive`、`redactForLog`）。Bearer 与 basic 凭据、`Authorization` 与 cookie header、形如
`token=`/`secret=`/`password=` 的值以及数据库 URL 都会被替换为 `[REDACTED]`。Web App 还会在任何内容离开浏览器前，对消息、
堆栈与 component stack 额外应用其扁平字符串 redactor，URL 的 query string 与 fragment 也在客户端剔除。消息与堆栈超出
schema 上限时会被截断而非拒绝。

## Server 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | 未设置 | 接收转发报告的 Google Cloud project；未设置且下方 key 也未提供 project 时关闭转发 |
| `OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON` | 未设置 | 整个 service account key 文件作为一个值；未设置时使用 Application Default Credentials |
| `OPENTAG_TRUST_PROXY` | `false` | 允许设置 `X-Forwarded-*` 的反向代理；参见[位于反向代理之后](#位于反向代理之后) |

凭据来自以下两处之一：

- `OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON`，适用于能设置环境变量但无法挂载文件的平台，例如 CapRover。把 key 文件的 JSON
  整体作为值粘贴进去。server 只接受 `service_account` 类型的 key，只保留 `client_email`、`private_key` 与 `project_id`，
  从不记录该值；值不是这类 key 时启动失败，错误信息只给出变量名、不含其内容。未设置 `GOOGLE_CLOUD_PROJECT` 时使用 key 中的
  `project_id`，因此仅凭 key 即可启用转发。
- 否则使用 Application Default Credentials：在 Google 托管的计算环境中使用 Workload Identity 或附加的 service account，
  或将 `GOOGLE_APPLICATION_CREDENTIALS` 指向挂载进容器的 key 文件。

无论哪种方式：

- 不要提交该 key、不要把它烘进镜像层，也不要放进 `.env.example`。
- 该身份只需要 project 上的 `roles/errorreporting.writer` 角色。
- 在 project 上启用 Error Reporting API（`clouderrorreporting.googleapis.com`）。

reporter 在第一份报告时才构造，使用 `reportMode: "always"`，使 staging 容器无需 `NODE_ENV=production` 即可上报，并将库自身的
console 输出限制在缺少凭据之类的真实错误。修改该变量后请重启 server。

未设置 `GOOGLE_CLOUD_PROJECT` 时，server 在第一份报告时记录一行 `info`——
`Error reports are logged only; GOOGLE_CLOUD_PROJECT is not set`——其余行为完全相同：中继路由、校验、限流与 `warn` 日志行
全部存在。因此自托管部署运行此功能时完全不依赖 Google。

### 位于反向代理之后

默认情况下 server 忽略 `X-Forwarded-*`，所有按地址计的限流都以 socket 对端为键。位于反向代理之后时，对端就是代理，
因此应把 `OPENTAG_TRUST_PROXY` 设为代理发起连接的地址：

- 逗号分隔的 IP 地址、CIDR 范围，以及预设 `loopback`、`linklocal` 与 `uniquelocal`（`10.0.0.0/8`、`172.16.0.0/12`、
  `192.168.0.0/16`、`fc00::/7`）。CapRover 的 nginx 经 Docker overlay 网络访问应用，因此适合用 `uniquelocal`。
- `true` 信任所有对端。仅在除代理外没有任何东西能访问 server 时使用，否则任何直连客户端都能通过该 header 自选地址。
- 跳数会被拒绝：Fastify 无法凭跳数校验直接对端，会忽略它。

该设置作用于整个 server，而不只是这条路由：浏览器登录限流使用同一个地址；对端受信任时，`request.hostname` 与
`request.protocol` 也改由 `X-Forwarded-Host` 与 `X-Forwarded-Proto` 决定。

## 失败路径

这条路径上的任何环节都不允许影响使用产品的人。

- Web App sink 会吞掉被拒绝或抛出的 `fetch`，且从不写 console，因此一次上报失败不会产生第二份错误报告。
- CLI 在已经呈现失败并设置退出码之后才上报；缓慢或不可达的中继最多让退出延迟三秒，其他一切不变。
- server 在转发开始前就答复 `202`；被 Google Cloud 库拒绝或超过五秒截止时间的转发以 `warn` 级别记录为
  `Forwarding an error report to Google Cloud Error Reporting failed`。
- 被 schema 拒绝的报告是客户端的 bug，以共享的 `VALIDATION_ERROR` envelope 答复，不会被转发。
