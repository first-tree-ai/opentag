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

## 失败与恢复检查

Pi runtime 回归测试还覆盖模型未完整结束、进程清理失败、Session 绑定串线、恢复的历史为空、
RPC 事件异常和取消竞态。成功需要同时满足 `agent_settled`、最后一条 assistant 的
`stopReason=stop` 和进程清理成功。长度限制导致的截断、以工具调用结束的运行均标为失败，保留部分输出。

新 Session 可以从空历史开始；Pi 保存对话历史前，绑定保持未物化。首轮在第一条 assistant
消息持久化前中断时，后续 Turn 仍使用同一个 Pi UUID，Client 重启后也如此。只有该 UUID
尚无保存的历史时，Pi 才从空文件开始；如果历史已写入、但 OpenTag 尚未更新绑定，
则恢复已有文件。这用于继续后续工作，不会自动重放中断的 Turn。
绑定一旦完成物化，历史缺失或为空会在提交下一条 prompt 前失败，OpenTag 不会静默重置
已保存的对话。此时需要恢复历史或显式更换 Session。绑定校验的是 Session 身份和文件路径，不是内容校验和：
仍有消息留存的部分历史损坏无法由这些检查发现，本阶段也不实现历史自动修复。

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

# E2 Cloud 身份验收

这是持续维护的 E2 验收入口，用真实 Server 和一次性 PostgreSQL 验证 Cloud Computer 与 Sandbox
身份。它不启动 Pi、不调用模型、不分配 GCP、也不发送 Slack/飞书流量。

```bash
pnpm build
node scripts/e2e/cloud-computer.mjs cloud-identities
```

`node scripts/e2e/cloud-computer.mjs cloud-identities --help` 列出前置条件。只有退出码为 0、全部
断言通过且清理成功，才算该次运行完成。`summary.json` 记录精确 Git HEAD、dirty 标记、断言、
替换项、PID/退出证据和实际清理结果。工作区有未提交改动时的运行属于探索证据，不能代替后续提交的验收。

## 验证内容

1. 空库启动应用当前源码 journal 中的全部迁移，并逐一核对 hash。另一路从合入 E1 的基线提交
   `440dfed53c3bb22a8527cd731f82e9b9006bd9b5` 应用到 idx 41，再由当前 Server 升级；预先写入的
   Local Computer、机器凭证、Pi Agent 与 runtime 配置以及迁移 hash 前缀均保留。
2. 通过重启 `OPENTAG_DEV_AUTH_EMAIL` 完成两次真实开发登录，认证密钥保持不变。`/api/v1/me`
   账户 ID 与 Cookie/CSRF 存在。未认证和缺少 CSRF 的写请求被拒绝，且不插入行。
3. 同账户并发 Cloud ensure（`PUT /api/v1/computers/cloud`）只产生一个 ID 和一行。元数据为
   linux/x64、已配置 CLI 版本、非空稳定安装 UUID。Cloud 行没有 `computer_credentials`、
   `current_instance_id`、`connected_at`、`last_seen_at`。带 `x-opentag-cloud-identity: 1` 的列表
   显示 `kind: cloud` 逻辑在线；同时请求 readiness 时，Pi 仍为不可用且无探测时间。未知 Cloud
   能力版本、旧客户端、无该头或仅 readiness v2 的列表隐藏 Cloud，并保持
   Local 旧形态。
4. 通过 `POST /api/v1/agents` 创建 Pi Cloud Agent。插入带明确测试标记的 Slack installation/binding
   SQL。并发 Sandbox ensure（`POST /api/v1/sandboxes`）幂等。不同 channel、thread、binding、用户得到
   不同 Sandbox/Session/URI。SQL 校验 `sessions → im_bindings → agents` 归属和
   `session_placements` Computer。Sandbox 初始为未分配、环境代次 0、资源字段为空。自报
   `accountId`/`agentId` 以及错误 thread 范围被拒绝。
5. 外部账户 ensure/查询/创建/rebind 得到不泄露信息的拒绝，形态与未知 ID 一致。没有半成品行。
6. Server 重启使用新 PID，并记录旧进程退出。已认证 Cookie 以及 Cloud / Agent / Session / Sandbox
   ID 和 `storage_uri` 保持不变。重启时更改存储前缀/版本不得覆盖已有行。
   `OPENTAG_CLOUD_IDENTITIES_ENABLED=false` 阻止 Cloud ensure、已知 Cloud ID 的 Agent 创建（含
   intent 重放）以及新的 Sandbox ensure；已有读取和 Local 路径仍然可用。
7. Cloud 上创建 Codex/Claude-Code 被拒绝；不能改 runtime provider。Local↔Cloud rebind 被拒绝；
   Local→Local 可用；Cloud 同一 ID rebind 幂等。
8. Local 连接码创建/交换/注册/查询与 repair 保持 Computer ID，轮换凭证并拒绝旧 token。注册走生产
   runtime WebSocket。旧的未标记 exchange 与 Local 列表形态保持不变。针对 Cloud 签发 repair 被拒绝。
   伪造的 repair-code 行和假 Cloud 机器凭证只用于负例，随后删除。与 Cloud 安装身份冲突被拒绝。
   身份不被覆盖。
9. 事务写入重复的 Sandbox 资源名+UID 触发唯一约束并回滚。这是仅数据库所有权测试，不是 GCP 分配证据。

## E2 边界

E2 不分配计算、不写存储对象、不运行 Runner、不调用模型、不投递 IM。这些分别属于 E3（Runner）、
E4（真实 IM）和 E9（默认产品 UI）。此处不增加面向客户的 UI。一次性 Postgres helper 的容器名仍使用
E1 前缀；摘要中的标签为 E2。

E9 扩展此脚本，要求 Cloud setup 与 preparation-refresh 由 Server 返回，不分配 Sandbox、不伪造 Local CLI 观测。
测试环境关闭 Runner 时，可用性须明确执行服务不可用，Computer 仍逻辑在线。Agent 空概览仅归属账号可读。
这些验证真实 HTTP／数据库路径，不代表真实 Provider 授权或云端执行验收。
Sandbox 创建事务会锁住活跃 IM binding 直至提交，确保并发的 Provider 停用能结束刚提交的 Session，
不会留下 binding 已停用但 Session 仍活跃的记录。

| 变量 | 含义 |
| --- | --- |
| `OPENTAG_E2_ARTIFACTS` | 产物目录；默认使用唯一临时目录 |
| `OPENTAG_E2_PORT` | 回环 Server 端口；未设置时自动分配 |
| `OPENTAG_CLOUD_IDENTITIES_ENABLED` | Server Cloud 创建开关（`true`/`false`，默认 `false`） |
| `OPENTAG_CLOUD_STORAGE_BASE` | Sandbox 存储前缀；fixture 默认 `gs://opentag-e2-fixture/sandboxes` |
| `OPENTAG_CLOUD_RUNNER_VERSION` | Cloud Computer `client_version`；fixture 使用 `apps/cli/package.json` |

## E3 原生执行

配置、原生 Sandbox 验收、资源清单、取消和删除确认见 [Cloud Runner 执行](../cloud-runner-execution.md)。
入口为 `node scripts/e2e/cloud-computer.mjs cloud-runner --help`；它会创建真实 Cloud 资源。

## E4 Cloud 投递（仅本地组合）

E4 的控制、凭证／模型、连续性与取消边界见
[Cloud Runner 执行](../cloud-runner-execution.md)。目前没有 GCP／IM 的 E4 验收脚本，
维护的本地检查为：

```bash
pnpm build
pnpm --filter @opentag/shared test
pnpm --filter @opentag/client exec vitest run src/__tests__/cloud-journal.test.ts src/__tests__/cloud-turns.test.ts src/__tests__/cloud-turn-worker.test.ts src/__tests__/cloud-sandbox-credential-bridge.test.ts src/__tests__/runner-serve.test.ts
pnpm typecheck
```

这些用例使用真实 loopback WebSocket、真实本地子进程和一次性 fixture 根目录，但不包含原生
Cloud Run 命名空间、真实 IM provider 或 GCP 分配。因此原生取消／重置、原生 Unix socket 挂载、
连接丢失时的授权撤销以及 IM 回复验收仍需真实环境证据。E4 不新增数据库表。E5 见
[Cloud 工作目录持久化](../cloud-workspace-persistence.md)，其真实验收必须包含释放与替换实例，
不能将本 E3/E4 验收工具当作持久化证据。E6 Session 并发检查与 E4–E6 staging 组合验收步骤见
[Cloud Runner 执行](../cloud-runner-execution.md#e6cloud-session-并发)。E7 生命周期检查见同文档的空闲回收与复用部分；
E8 配置、Tree 和协作边界见 [Cloud Context](../cloud-context.md)。本地证据不能代替原生 Cloud／IM 验收。
