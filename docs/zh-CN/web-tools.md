# Web 工具

> Canonical source: [../web-tools.md](../web-tools.md)
> Last synced with: 2026-09-17

## 范围

Web 工具通过 OpenTag 管理的 Tavily 访问，为 Pi Agent Run 暴露 `web_search` 与 `web_fetch`。该功能**默认关闭**。
代理凭证模式下的本地 Computer 执行可以启用；在真实的逐执行授权签发方（E4）出现之前，原生 Cloud Runner
执行保持关闭，因为现有原生 bootstrap 凭证不是执行授权，绝不会被当作授权使用。

## Server 配置（Tavily 访问）

OpenTag Server 通过固定 HTTPS 路由访问现有 Router，并持有 **Router 的 web-only 租户密钥**。Tavily provider
密钥本身只存在于 Router gateway，OpenTag Server 从不持有它。

| 变量 | 必需 | 含义 |
| --- | --- | --- |
| `OPENTAG_WEB_ENABLED` | 是（默认 `false`） | Server 侧 web 转发总开关 |
| `OPENTAG_WEB_ROUTER_BASE_URL` | 启用时必需 | 仅 Router origin（不得含 path/query/fragment/凭证）。托管环境强制 HTTPS |
| `OPENTAG_WEB_ROUTER_TENANTS` | 启用时必需 | Account → Router 租户的 JSON 数组映射：`[{"accountId":"<uuid>","tenantId":"<router-tenant-slug>","keyEnv":"OPENTAG_WEB_ROUTER_KEY_ACME"}]` |
| `OPENTAG_WEB_ROUTER_KEY_*` | 每个映射必需 | 保存 Router web-only 租户密钥的部署 secret。映射中只出现变量*名*；该名称必须匹配 `^OPENTAG_WEB_ROUTER_KEY_[A-Z0-9_]{1,48}$`（该正则约束的是环境变量名，而不是 secret 值），并在启动时读取 |

合成示例（切勿在本文件或源码中使用真实密钥）：

```text
OPENTAG_WEB_ENABLED=true
OPENTAG_WEB_ROUTER_BASE_URL=https://router.example.internal
OPENTAG_WEB_ROUTER_TENANTS=[{"accountId":"00000000-0000-4000-8000-000000000001","tenantId":"synthetic-tenant","keyEnv":"OPENTAG_WEB_ROUTER_KEY_SYNTHETIC"}]
OPENTAG_WEB_ROUTER_KEY_SYNTHETIC=synthetic-router-web-key
```

启用时缺少 origin、映射或可读密钥材料会导致启动失败，而不是静默回退。

Router 必须已经执行其自身的迁移（新增 `api_keys(scopes)`、web service 定价以及 web request/usage-ledger
列）；该迁移由 Router 仓库负责。OpenTag 不为本功能新增表、service 或数据库迁移。全程不涉及 LiteLLM。

## 本地客户端 opt-in

| 变量 | 位置 | 含义 |
| --- | --- | --- |
| `OPENTAG_WEB_TOOLS_ENABLED` | CLI daemon 环境（`daemon.env`） | 本地 opt-in。只接受精确的 `true`/`false`；其他取值导致启动失败 |
| `OPENTAG_RUNTIME_CREDENTIAL_MODE=proxy` | CLI daemon 环境 | 必需；legacy 模式不会打开执行，也不会启用 web 工具 |
| `OPENTAG_RUNNER_WEB_TOOLS` | 原生 Runner `serve` 环境 | 原生边界 opt-in。只接受精确的 `true`/`false`；其他取值导致启动失败 |

仅打开开关永远不会授予工具：Server 还必须协商版本 1 的 `webTools` capability，并向该执行授予带
`web:search` / `web:fetch` scope 的 `web` service。没有授权时 Pi 扩展不会注册，也不存在任何 endpoint。原生
`serve` 还需要注入的、由 Server 授权的执行授权（`webAuthority` harness seam）；生产目前不提供该授权，因此
E3 仍然禁用。

## 密钥托管与隔离

- Tavily 密钥只存在于 Router gateway。OpenTag Server 只持有 Router 的 web-only 租户密钥，来自 `keyEnv`
  指定的部署 secret。
- 受信任的 CLI/daemon 仍然持有现有的 Computer machine/control 凭证，并在控制边界协商 capability；这一受信任
  主机认证保持不变。**Tavily 密钥与 Router web-only 租户密钥**永远不会离开 Router/Server 托管范围：不会进入
  Agent 进程、Sandbox、请求体、错误信息或日志。Web 请求只携带业务参数与运行时生成的 tool call id。
- 本地执行获得一个全新的、短路径的、私有逐执行 Unix socket；较早执行的陈旧描述符无法到达后续执行，关闭一次
  执行只会移除它自己的 listener。
- 原生执行使用专用 `sandbox exec` stdin/stdout 双工管道，listener 位于 Sandbox 命名空间内部。父进程 socket
  不会挂载进 Sandbox，也不会打开 TCP listener。
- 受信任的 Pi 扩展是构建产物 `dist/pi-extensions/web-tools.mjs`，随 Client 包、npm CLI 和便携版产物一起发布。
  它通过 `pi -e` 显式加载；`--no-extensions` 始终保留，隐式发现永远不会加载任何内容，help/probe 命令也不会
  加载该扩展。

## 预算、错误与产物

- 一条递减的端到端预算贯穿 tool、gateway、受信任 client、Server 与 Router：search **15 秒**，fetch
  **45 秒**。Sandbox 内/受信任 gateway 使用严格的 1–7 位十进制 `x-web-remaining-ms` header（正整数），按操作
  上限截断，在读 body
  **之前**启动 deadline，并在 body 结束后只转发剩余量。受信任 Client → Server → Router 的 HTTP 跳使用
  `x-web-timeout-ms`，采用同样的 1–7 位正整数十进制语法；每一跳都重新构造，绝不重置为完整上限。
- 每一跳的错误都是有界且脱敏的：`request_in_progress`、`request_uncertain`、`insufficient_credit`、
  `idempotency_conflict`、`result_unavailable`、`timeout`、`aborted` 以及共享错误分类。Pi 会把操作失败记录为
  tool 错误，而不是成功文本。
- 边界：请求 ≤16 KiB、URL ≤4 KiB、页面正文 ≤1 MiB、每页模型预览 ≤12 KiB、整个 tool 结果 ≤48 KiB、search
  响应 ≤1 MiB、fetch 响应 ≤3 MiB。
- 抓取到的页面写入 Session workspace 下的 `.opentag/web/<stable-tool-id>/`，采用原子写入并附带 sha256 元数据。
  写入失败时报告缺失的 artifact，绝不伪造路径。

## 验证与限制

单元测试只使用**本地 stub 传输**覆盖 gateway、受信任 Server client、原生 bridge 与 Pi 扩展。父级 cross-chain
运行使用真实的 PostgreSQL 与 Redis 测试实例以及 stub Tavily HTTP 传输，验证实际 Server 与 Router HTTP 栈。
本仓库**没有真实 Tavily 账号验收**，测试也不会调用 vendor。原生 Cloud 验收仍需要 E4 执行授权签发方；在此
之前，原生路径通过注入的测试授权进行验证。
