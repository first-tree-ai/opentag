# E1 本地 Pi 验收

[English](../../testing/cloud-computer.md)

这是持续维护的 E1 验收入口，通过生产 Server 和 CLI daemon 验证本地 Pi Computer。
先构建待验收代码，再运行：

```bash
pnpm build
node scripts/e2e/cloud-computer.mjs local-pi
```

`node scripts/e2e/cloud-computer.mjs --help` 列出前置条件和选项。只有退出码为 0、全部断言
通过且清理成功，才算该次运行完成。产物记录 Git SHA 与 dirty 标记；工作区有未提交改动时
的运行属于探索证据，不能代替后续提交或构建的验收。

## 验证内容

1. 启动一次性 PostgreSQL，应用当前迁移，启动仅监听回环地址的生产 Server。
   通过 Server 开发登录认证，申请 Computer 连接码，再由真实 CLI 交换凭据。
2. 启动 CLI daemon，观察已注册且在线的 Computer，要求实时 Pi readiness 为 ready。
   通过 Account API 创建 Pi Agent 并修改 runtime 配置。另对 Codex/Claude 做创建、暂停、
   删除的窄回归，确认 API 准入，不调用其模型。
3. 将随机 nonce 写入私有 fixture 文件。Pi 必须读取该文件，并写出完全匹配的输出。
   核对真实文件、Pi 工具历史、持久化 Session 绑定和 Server 已记录的 Turn 回执。
4. 删除含 nonce 的输入文件和输出文件。在同一 Session 中要求回忆 nonce，仅允许调用
   write 工具。要求输出匹配，Pi 绑定保持不变。
5. 停止 Client 进程，使用同一隔离 home 启动新进程。要求新 PID 和新连接 `instanceId`。
   删除上一轮输出，再做一次仅调用 write 的回忆，验证进程重启后的 Pi 持久化对话历史。
6. 启动前台子进程，记录自身 PID，并计划在 15 秒后写文件。确认 Pi 和子进程存活时，
   对真实 daemon 发送 SIGTERM。要求 daemon、Pi 和子进程在 10 秒内退出，并在原定截止
   时间后确认没有延迟写文件。重启 Client，让待提交的持久化回执能够恢复上报；要求 Server
   记录 `outcome=cancelled`、`errorReason=client_shutdown`。
7. 停止自有进程，删除私有工作目录，清理一次性 PostgreSQL 容器。清理失败会使命令失败。

## 前置条件

- 符合本仓库要求的 Node、pnpm，以及成功的 `pnpm build`。
- Docker，用于一次性 `postgres:17-alpine` 容器，数据库端口仅绑定回环地址。
- PATH 上有与生产 adapter 兼容的真实 `pi`，并已配置可用模型凭据。Harness 从
  `PI_CODING_AGENT_DIR` 或 `~/.pi/agent` 复制指定配置文件到私有 fixture；本工作区已授权
  测试使用现有 DeepSeek 配置。模型调用会消耗所配置 provider 的额度。
- 可用的本地 Server 端口，默认 `8131`。

构建后的 Shared、Server 准入和生产 Client 组合都必须支持 Pi。缺少准入或可用 provider
readiness 时，验收失败。

## 产品路径与 E1 边界

真实 CLI `computer connect` 获取 machine token。Daemon `service-run` 通过 Client 公共
导出组合 `RuntimeConnection` 与 `createClientRuntime`。Server 组装 runtime snapshot，
并在 PostgreSQL 中管理 delivery 的可靠接收与结果记录。

E1 通过仅供 harness 使用的 `tsx` helper 导入 Server 源码，将规范化合成 IM 事件传入
`ImMessageInbox.ingest`。随后由真实 Server `ImDeliveryWorker` 经 `RuntimeDomainOwner`
和在线 runtime WebSocket 下发。该源码导入仅用于测试组合，不增加生产包依赖。

可见 Session 当前需要 IM 凭据授权。E1 插入隔离 Slack installation 和 binding，使用
加密的占位凭据，再走生产授权服务。E1 专用 `slack` 可执行文件仅在本地回答版本、命令能力
和 `auth.test` 探测；其他 Slack 命令失败。不会请求 Slack/飞书或向外发送消息。
真实 IM 接入、认证与外部送达验收属于 E4。

现有 Agent suspend 会拒绝停止活跃 Turn（`busy/active_turn`），Server 可能在 API 返回
成功时记录 `AGENT_SESSION_STOP_FAILED`。因此 E1 验证 Client runtime 关闭，不宣称已支持
按 Session 在界面中取消任务。可靠的 Server stop/status 控制仍是 E4 需要解决的限制。

## 隔离与产物

Server 和 Client 均使用隔离 HOME；OPENTAG_HOME、Pi sessions、Codex home、Claude config
及 Provider CLI 状态都留在自有 fixture 内。不配置或访问 canonical Context Tree。
不会对真实账户的 Provider CLI 文件做快照、修改或恢复。Pi 配置静默复制到权限 `0700` 的
目录，文件权限为 `0600`；清理时删除，即使选择保留 PostgreSQL 也不保留这些配置。

产物目录包括：

- `summary.json`：源码身份、Pi/client 版本、模型名、工具名、回执 ID、结果与哈希、
  runtime ID/PID、停止耗时、断言和明确的替换边界。
- 脱敏的 Server/daemon 标准输出与错误日志。
- 合成入口事件 JSON，包含 fixture 路径和任务指令，不含模型凭据。

摘要不包含对话正文或 nonce。不会主动将凭据写入产物。非零退出保留失败阶段及已取得的
脱敏证据。

| 变量 | 含义 |
| --- | --- |
| `OPENTAG_E1_ARTIFACTS` | 产物目录；默认使用唯一临时目录 |
| `OPENTAG_E1_PORT` | 回环 Server 端口，默认 `8131` |
| `OPENTAG_E1_KEEP` | `on` 时仅保留一次性 PostgreSQL 容器，用完后需手动删除 |
| `PI_CODING_AGENT_DIR` | 可选的 Pi 配置源，复制到私有 fixture |
