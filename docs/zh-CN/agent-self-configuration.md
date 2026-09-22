# Agent 自我配置

> Canonical source: [agent-self-configuration.md](../agent-self-configuration.md)
> Last synced with: 2026-09-22

运行在 OpenTag managed Session 内的 Agent 可以通过 CLI 查看并修改自己的部分配置，无需 Account 登录：

```text
opentag agent self show
opentag agent self update [--instructions <text> | --instructions-file <path>]
                          [--model <model> | --clear-model]
                          [--reasoning-effort <effort> | --clear-reasoning-effort]
opentag agent self mcp list
opentag agent self mcp available
opentag agent self mcp attach <server> [--disabled]
opentag agent self mcp enable <server>
opentag agent self mcp disable <server>
opentag agent self mcp detach <server>
```

所有命令都支持 `--json`。`<server>` 是 MCP Server 的名称或 ID。

## 身份

这些命令使用 [内部 Session 协作](./internal-session-collaboration.md) 中描述的 managed Session proof 认证。
任何命令都不接受 Agent ID：Server 从 proof 解析 Agent，从 Agent 记录读取其所属 Account，再调用支撑
`agent update` 与 `agent mcp` 的同一套 Account 作用域服务。因此请求无法指向其他 Agent，所有权校验、revision
冲突与 Cloud 模型校验的行为与人工操作完全一致。在 managed Session 之外，命令会在任何网络调用之前以
`AGENT_SELF_SESSION_REQUIRED` 失败。

Server 路由位于 `/api/v1/runtime/agent` 之下，并在读取请求体之前先认证 proof。

## Agent 可以修改的内容

| 设置 | `agent self` | 原因 |
| --- | --- | --- |
| Instructions、model、reasoning effort | 可以 | 决定 Agent 如何工作；由用户要求 Agent 调整。 |
| 挂载、启用、停用或卸载 Account MCP Server | 可以 | 只在 Account 已注册的 Server 中选择。 |
| 显示名称、接收模式 | 不可以 | 会改变人和 IM 看到的 Agent。 |
| 最大 Turn 时长 | 不可以 | 会让 Agent 提高自己的资源上限。 |
| MCP endpoint 与 header 覆盖 | 不可以 | 会把已有 bearer 凭证转发到其他 origin。 |
| MCP 凭证、OAuth、Server 定义 | 不可以 | 凭证始终由人决定。 |

人仍可通过 `agent update`、`agent mcp`、`mcp` 与 Web 应用使用完整能力。

## 生效时机

- Instructions、model 与 reasoning effort 在组装每个 Turn 时从实时 Agent 配置读取，因此修改会从每个已有 Session
  的下一个 Turn 开始生效。这些字段属于 effective runtime snapshot hash，所以该 Turn 会开启新的 provider
  会话而不是恢复旧会话：之前的对话上下文不会延续。带有自身 model 或 reasoning effort 覆盖的内部 Session
  保留该覆盖。
- MCP gateway 在每次请求时读取 MCP 挂载，因此挂载、启用或停用 Server 会在下一次 MCP 请求时改变工具目录。
  原本没有可用 Server 的 Agent 会在下一次 execution 时获得 MCP 访问。
- 卸载 Server 会删除该 Agent 在此 Server 上的凭证；之后重新挂载需要人重新授权。若之后可能还会用到，
  优先使用 `disable`。

`agent self update` 会先读取当前 revision 并作为 `expectedRevision` 发送。并发修改会返回
`AGENT_REVISION_CONFLICT`；重新读取后重试。`--instructions` 会替换整段 instructions，因此先用
`agent self show` 读取当前值并保留仍然适用的部分。

## 可观测性

Server 以 `info` 级别记录 `agent_self.config_updated`、`agent_self.mcp_attached`、
`agent_self.mcp_binding_updated` 与 `agent_self.mcp_detached`，包含 Agent ID、Session ID，以及修改的字段名或
MCP Server ID。Instructions 文本永远不会被记录。
