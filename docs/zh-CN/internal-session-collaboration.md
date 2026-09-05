# Internal Session 协作

> Canonical source: [internal-session-collaboration.md](../internal-session-collaboration.md)
> Last synced with: 2026-09-05

OpenTag Agent 在每个 managed Session 内通过 CLI 委派工作：

```text
opentag session create --message <task>
opentag session send <target-session-id> --message <text>
opentag session list
```

当前 source Session 是隐式身份。Runtime 注入 managed proof 文件，CLI 从
`OPENTAG_HOME/config/computer.json` 读取 Server 绑定；调用者不能传 Agent 或 source Session ID。proof 绑定当前
Session、placement generation、Computer connection 与 Client connection。同一绑定下的 reconcile（包括 timeout 或
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

OpenTag Internal Session 与 Provider 原生 subagent 是两种不同机制。人明确要求使用 OpenTag Internal Session 时，
可见 Session 必须调用 `opentag session create`，不能以 Provider 原生 subagent 代替。除此之外，OpenTag 本次不强制规定
直接处理、Provider 原生 subagent 与 Internal Session 之间的自动选路策略。

SessionMessage 回传到可见的 channel/thread Session 时，该 callback Run 继续拥有可见 Session 的 IM 权限。credential
grant v2 会原子提供临时 provider 凭证环境，以及由 Server 从 Session 既有 conversation scope 派生的非敏感默认
outbox context。可见 Session 在同一 callback Run 中整理用户可见结果，再通过官方 provider CLI 发布；OpenTag 不会自动
原样转发子 Session 文本。channel callback 使用既有 chat/channel，thread callback 保持既有 thread scope。Internal
Session 目标始终拿不到 provider 凭证或 outbox context。

Session 协作是实时 best-effort 通道，不是持久 job queue。Server 保存已授权逻辑消息及最近结果用于幂等和冲突检测，
目标投递仍使用有界内存 FIFO，不自动 replay。Agent-facing Session 命令刻意不提供 `end`；管理生命周期失效流程仍可设置
既有 `sessions.ended_at`。Retention 不在本功能范围。

CLI surface 仅协商 `runtime.sessionCollaboration` capability v2。可见 callback 投递还要求
`runtime.imCredentialGrant` v2：新 Server 面对旧 Client 时会在投递前返回 `outbox_unavailable`；新 Client 连接旧 Server
时会在 ACK 前拒绝投递，让同一逻辑消息仍可重试。两种升级方向都会在 callback Run 启动前 fail closed，不会静默移除
IM outbox。

OpenTag 当前仅在单 Server replica 下支持这条路径。`OPENTAG_RUNTIME_REPLICA_MODE` 默认是 `single`，Server
启动前会在 PostgreSQL 会话上获取 advisory-lock lease。第二个存活实例会在有界等待窗口内重试；若持有者仍在，
它会带着可执行的 lease-held 错误 fail closed。部署必须使用 recreate 策略，例如 `maxSurge=0`，确保不会同时有
两个存活 replica；滚动重启要等旧进程退出后替换实例才能获取 lease。Lease 属于 PostgreSQL 会话：正常关闭或
进程被非正常 kill 后，该会话关闭，PostgreSQL 会自动释放 lease。`/healthz` 与 `/readyz` 会返回
Lease client 会关闭自动 lifetime recycling，因此不会在 advisory lock 仍由该会话持有时被替换。
`runtimeOwnership.mode`、`runtimeOwnership.status` 以及持有者的 `runtimeOwnership.instanceId`；如果 lease 会话断开，
实例会立即 fence runtime socket、停止后台投递、拒绝 runtime mutation，状态变为 `not_owned`，`/readyz` 会失败。
随后实例会在同一个有界窗口内尝试重新获取 lease；如果恢复窗口到期，进程会以非零状态退出，由 supervisor 重启。
proof-authenticated Session CLI HTTP 与 source/target SessionMessage Runtime 投递都依赖该 replica 本地的 WebSocket owner。
当请求到达不持有该连接的实例时，会返回结构化错误码 `RUNTIME_OWNER_ELSEWHERE`。当前不支持普通多 replica 负载均衡、
sticky routing，也不支持跨 replica owner discovery、forwarding 或 delivery relay；启用横向 replica 前必须先完成明确的
跨实例 owner-routing 设计。
