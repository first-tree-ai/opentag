# Web 工具

> Canonical source: [../web-tools.md](../web-tools.md)
> Last synced with: 2026-09-23

## 范围

Web 工具通过 OpenTag 管理的 Tavily 访问，为 Pi Agent Run 暴露 `web_search` 与 `web_fetch`。Web 访问是**平台默认
能力**——与平台 LLM 访问同级——而不是逐 Account 密钥、opt-in 步骤或用户设置。未配置平台 Web provider 的部署仍
然 fail closed：没有授权、没有 bearer、没有 socket、没有扩展。

同一条 Server 路由服务于两个边界：

- **本地 Computer** 执行：代理凭证模式，且 daemon 启动时带有下述本地 opt-in。
- **Cloud Runner** 执行（IM turn 与内部 Session 协作）：只要 Server 授予 `web` service。Cloud 路径没有 Runner 侧
  开关：授权本身就是闸门。

## Server 配置（Tavily 访问）

OpenTag Server 通过固定 HTTPS 路由访问现有 Router，并持有**唯一一个部署级 Router web-only 密钥**。Tavily
provider 密钥本身只存在于 Router gateway，OpenTag Server 从不持有它。

| 变量 | 必需 | 含义 |
| --- | --- | --- |
| `OPENTAG_WEB_ENABLED` | 是（默认 `false`） | Server 侧 web 转发总开关 |
| `OPENTAG_WEB_ROUTER_BASE_URL` | 启用时必需 | 仅 Router origin（不得含 path/query/fragment/凭证）。托管环境强制 HTTPS |
| `OPENTAG_WEB_ROUTER_KEY` | 启用时必需 | Router web-only 密钥。启动时读取，与其他部署 secret 一样做 trim，且绝不写入日志、Sandbox 或请求体 |

合成示例（切勿在本文件或源码中使用真实密钥）：

```text
OPENTAG_WEB_ENABLED=true
OPENTAG_WEB_ROUTER_BASE_URL=https://router.example.internal
OPENTAG_WEB_ROUTER_KEY=synthetic-router-web-key
```

启用时缺少 origin 或密钥会导致启动失败，而不是静默回退。逐 Account 租户映射
（`OPENTAG_WEB_ROUTER_TENANTS` 及其 `keyEnv` 引用）已移除；只保留该变量的部署没有 Router 密钥，会在启动时
fail closed。

部署启用后，web policy 会向**每一个有效的 active Account 执行**授予 `web:search` / `web:fetch`（前提是该执行
请求了该 service），与平台模型访问完全一致。不存在逐 Account 映射，也不存在面向用户的开关。

本实现中 Router 计费在 Account 之间**共享**；OpenTag 不声称实现了逐 Account 的 Router 计费。OpenTag 保留的是
自己结构化 usage 日志中的已认证 Account ID（`WEB_DISPATCH`：code、Account、execution、operation）以及请求的
Account 归属，且**不含查询内容与凭证**。Account 只来自实时 execution 记录，绝不来自请求体。

Router 必须已经执行其自身的迁移（新增 `api_keys(scopes)`、web service 定价以及 web request/usage-ledger
列）；该迁移由 Router 仓库负责。OpenTag 不为本功能新增表、service 或数据库迁移。全程不涉及 LiteLLM。

## 本地客户端 opt-in

| 变量 | 位置 | 含义 |
| --- | --- | --- |
| `OPENTAG_WEB_TOOLS_ENABLED` | CLI daemon 环境（`daemon.env`） | 本地 opt-in。只接受精确的 `true`/`false`；其他取值导致启动失败 |
| `OPENTAG_RUNTIME_CREDENTIAL_MODE=proxy` | CLI daemon 环境 | 必需；legacy 模式不会打开执行，也不会启用 web 工具 |

原生 Runner **没有** web opt-in。`OPENTAG_RUNNER_WEB_TOOLS` 已移除；Cloud turn 获得 web 工具的条件只有两个：
Server 为该执行授予 `web` service，且 Runner 持有打包好的扩展产物。

仅打开开关永远不会授予工具：Server 还必须协商 `webTools` capability，并向该执行授予带 `web:search` /
`web:fetch` scope 的 `web` service。没有授权时 Pi 扩展不会注册，也不存在任何 endpoint。

## Cloud 执行托管

- 每个 Sandbox 的 Runner 连接会协商 `runtime.webTools`，并在每次真实 IM 与内部 Session 执行打开时请求 `web`。
  Server 只在既有 custody、Session、Sandbox 与连接 fence 全部通过后才授予。
- 执行级 web bearer 通过既有凭证隧道（`runtime:web:gateway`）签发，来自有界、仅存哈希的存储，其生命周期以该
  执行自身的到期时间为上限。它**绝不**出现在 open result、worker stdin 文档、journal 或日志中。
- bearer 只存在于受信任的 Runner **父进程**。`RuntimeWebService` 仍是唯一持有 Router 密钥的组件；父进程用
  bearer 调用两条固定路由，Server 从实时 execution 推导 Computer 身份，并要求请求中的 `executionId` 与 bearer
  一致。
- 这两条路由在本地 machine 认证之外**额外**接受该 bearer。Cloud control 凭证会被拒绝：它绝不会被当作 machine
  token 或 web 授权。
- 原生 gateway 为每个获得授权的执行只打开一个 channel：全新的 `sandbox exec` stdin/stdout 双工管道，listener
  位于 Sandbox 命名空间内部。不挂载父进程 socket，不打开 TCP listener，结果**不**经过 256 KiB 控制
  WebSocket。
- channel 在 Sandbox 被删除或重置之前、以及执行结束时关闭。撤销、控制连接替换、owner 丢失与 stale sweep 都在
  执行关闭的同一处撤销 bearer，因此陈旧的 token 或 socket 无法到达后续执行。
- 只有非密 socket 描述符与固定打包扩展路径（`/opt/opentag/client/dist/pi-extensions/web-tools.mjs`）通过有界
  stdin 传到 Cloud worker。Pi 显式注册该扩展（`provider.webTools`），`--no-extensions` 保持隐式发现关闭。
- 如果 Server 已授予 Web，但执行 bearer、打包扩展或原生 channel 不可用，本轮执行会明确失败，不会在缺少平台默认
  Web 工具的情况下静默完成。

## 密钥托管与隔离

- Tavily 密钥只存在于 Router gateway。OpenTag Server 只持有部署级 Router web-only 密钥。
- 受信任的 CLI/daemon 仍然持有现有的 Computer machine/control 凭证，并在控制边界协商 capability；这一受信任
  主机认证保持不变。**Tavily 密钥与 Router web-only 密钥**永远不会离开 Router/Server 托管范围：不会进入
  Agent 进程、Sandbox、请求体、错误信息或日志。Web 请求只携带业务参数与运行时生成的 tool call id。
- 本地执行获得一个全新的、短路径的、私有逐执行 Unix socket；较早执行的陈旧描述符无法到达后续执行，关闭一次
  执行只会移除它自己的 listener。
- Cloud 执行获得一个全新的逐执行 `sandbox exec` 双工管道；channel 随执行关闭，后续执行会获得自己的 bearer、
  socket 与 channel。
- 受信任的 Pi 扩展是构建产物 `dist/pi-extensions/web-tools.mjs`，随 Client 包、npm CLI 和便携版产物一起发布。
  它通过 `pi -e` 显式加载；`--no-extensions` 始终保留，隐式发现永远不会加载任何内容，help/probe 命令也不会
  加载该扩展。

## 预算、错误与产物

- 一条递减的端到端预算贯穿 tool、gateway、受信任 client、Server 与 Router：search **15 秒**，fetch
  **45 秒**。Sandbox 内/受信任 gateway 使用严格的 1–7 位十进制 `x-web-remaining-ms` header（正整数），按操作
  上限截断，在读 body **之前**启动 deadline，并在 body 结束后只转发剩余量。受信任 Client → Server → Router 的
  HTTP 跳使用 `x-web-timeout-ms`，采用同样的 1–7 位正整数十进制语法；每一跳都重新构造，绝不重置为完整上限。
- 每一跳的错误都是有界且脱敏的：`request_in_progress`、`request_uncertain`、`insufficient_credit`、
  `idempotency_conflict`、`result_unavailable`、`timeout`、`aborted` 以及共享错误分类。Pi 会把操作失败记录为
  tool 错误，而不是成功文本。
- 边界：请求 ≤16 KiB、URL ≤4 KiB、页面正文 ≤1 MiB、每页模型预览 ≤12 KiB、整个 tool 结果 ≤48 KiB、search
  响应 ≤1 MiB、fetch 响应 ≤3 MiB。
- 抓取到的页面写入 Session workspace 下的 `.opentag/web/<stable-tool-id>/`，采用原子写入并附带 sha256 元数据。
  写入失败时报告缺失的 artifact，绝不伪造路径。

## 验证与限制

单元测试只使用**本地 stub 传输**覆盖 gateway、受信任 Server client、执行 web dispatch、原生 bridge、relay
bearer 获取、Cloud turn 接线（有授权/无授权、dispatch、后继执行）、Server 路由（bearer 与 machine 认证）、
Server fence、token 存储以及 Pi 扩展。测试不会调用 vendor。

本次变更**尚未**使用真实 staging 部署（真实 Router、真实 Cloud Runner、真实 Sandbox）对 Cloud web 工具做过端到端
验证。在完成该验证之前，Cloud 路径应视为“已实现且通过单元验证”，而不是“已生产验证”。本地代理模式保持原有
行为；MCP 未变。
