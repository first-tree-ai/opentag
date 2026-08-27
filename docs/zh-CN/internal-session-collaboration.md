# Internal Session 协作

> Canonical source: [internal-session-collaboration.md](../internal-session-collaboration.md)
> Last synced with: 2026-08-27

OpenTag Agent 在每个 managed Session 内通过 CLI 委派工作：

```text
opentag session create --message <task>
opentag session send <target-session-id> --message <text>
opentag session list
```

当前 source Session 是隐式身份。Runtime 注入 managed proof 文件，CLI 从
`OPENTAG_HOME/config/computer.json` 读取 Server 绑定；调用者不能传 Agent 或 source Session ID。proof 绑定当前
Session、placement generation、Computer enrollment 与 Client connection。同一绑定下的 reconcile（包括 timeout 或
response 丢失后的重试）会复用同一 proof；placement、connection、Agent 或 IM binding 变化都会使旧 proof 失效。

同一个 daemon OS 用户启动的所有 Provider 进程目前属于同一信任域。文件权限可以隔离其他 OS 用户并减少意外暴露，
但不能隔离以同一用户运行的 sibling Session。在 OpenTag 提供按 Session 的 OS/container 隔离之前，proof 用于让 Server
校验当前 Runtime binding 并移除调用方可选的 source 参数；它不能防御能够读取 daemon 用户文件的受攻击 sibling
Session。

`session create` 会原子创建 internal 子 Session 与首条消息；`session send` 向同一 Agent 和 conversation scope 内的
既有 Session 发消息。两者都支持可选 `--message-id` 做显式重试；结果不确定时必须复用相同 ID 和完全一致的语义输入。
`accepted` 只表示目标已把消息接收入有界 FIFO，不表示任务完成。

`session list` 默认按最近消息活动倒序返回直接子 Session。每页默认 20 条、最多 100 条；`--cursor` 翻页，
`--recursive` 包含全部后代，`--since` 过滤近期活动，`--json` 返回 `{ items, nextCursor }`。不提供无界 `--all`。

Internal Session 与主 Session 共享 Agent 的 tools、MCP、workspace 和默认 Runtime 配置；创建时可以覆盖 model、
reasoning effort 和最长 Run duration。Internal Session 不接收 IM delivery 或临时
`OPENTAG_PROVIDER_ENV_FILE`，而是通过 `opentag session send` 回报。两类 Session 都收到角色化 managed instructions，
也都可以继续创建下一层 internal Session。

Session 协作是实时 best-effort 通道，不是持久 job queue。Server 保存已授权逻辑消息及最近结果用于幂等和冲突检测，
目标投递仍使用有界内存 FIFO，不自动 replay。Agent-facing Session 命令刻意不提供 `end`；管理生命周期失效流程仍可设置
既有 `sessions.ended_at`。Retention 不在本功能范围。

CLI surface 仅协商 `runtime.sessionCollaboration` capability v2；旧 Client 不会协商该 capability，也不会收到 Session
proof。

OpenTag 当前仅在单 Server replica 下支持这条路径。proof-authenticated Session CLI HTTP 与 source/target
SessionMessage Runtime 投递都依赖该 replica 本地的 WebSocket owner。当前不支持普通多 replica 负载均衡、sticky
routing，也不支持跨 replica owner discovery、forwarding 或 delivery relay；启用横向 replica 前必须先完成明确的跨实例
owner-routing 设计。
