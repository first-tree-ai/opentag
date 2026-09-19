# Cloud Runner 执行（E3–E8）

[English](../cloud-runner-execution.md)

E3 将现有 Agent Session 的 Sandbox 身份连接到真实 Cloud Run Instance 和原生 Sandbox。
功能默认关闭，显式开启后每个分配使用一个 Instance、一个原生 Sandbox、1 vCPU / 1 GiB。
Runner 属于 Client，沿用 CLI 发布版本；不新增数据表或迁移。

## 边界

- Computer 是 Account 的逻辑 Cloud 身份，固定在线不代表物理实例健康。
- Agent Session 复用现有执行会话，由 IM binding 与 channel/thread 定位，不新增对话模型。
- sandboxes 关联 Session 与当前资源，使用 generation、确定的资源名、provider UID、operation name
  防止晚到回调影响新分配，storage_uri 保留稳定持久化地址。
- 单独的 E3 不保存或恢复 storage_uri。E5 增加[最新工作目录保存与恢复](./cloud-workspace-persistence.md)，
  包括 Pi 会话状态。IM 可靠投递属于 E4，空闲回收与同账号物理实例复用属于 E7；E3 验收本身不证明 Cloud 的持久化能力。

## 生命周期与控制

沿用 unallocated → preparing → ready → releasing → unallocated。Server 在云 API 调用前记录
资源名，并发请求核对同一个分配。创建或删除结果不明时保留归属和错误状态；创建仍可能到达时，
GET 404 不代表已清理。删除同时校验 UID 和 etag，避免误删同名替换资源。

Instance 内运行 opentag-runner serve。声明唯一的容器端口 8080；原生就绪验证通过后，Runner 默认
监听该**声明端口**（注入的 PORT 仍是显式覆盖），因此即使运行时未提供 PORT，平台默认 TCP 启动探针
也一定有可用 socket。该监听器只接受连接并立即结束，不读写数据，也不提供命令、HTTP 或凭证接口。
控制通道仍是 Runner 主动连接 /api/v1/sandbox-runners/ws 的 WSS；Instance 不开放父容器 HTTP
控制接口。令牌在首帧发送，绑定当前 Sandbox、Session、generation、资源名，不进入 URL。
Server 回复心跳，通过当前已认证连接续期令牌。重连使用父进程内存中的新令牌；接收工作及结果前
校验当前归属、placement 与执行权限。

云实例就绪不等于 Sandbox 就绪。Runner 必须报告真实原生执行、工具版本、Runner 版本及文件系统／
凭证隔离检查。旧连接不能替代当前连接报告就绪或完成任务。

Account 接口为 GET /api/v1/sandboxes/:sandboxId/runner，以及 POST 后缀 /runner/start、
/runner/stop、/runner/acceptance。继续使用 Cookie、CSRF 和归属检查。acceptance 只执行有期限的
offline / DeepSeek 验收任务，不是通用任务提交 API；同一 Sandbox 同时只执行一个。

E3 的连接和待返回验收结果保存在对应 Server 进程内，使用单个测试 Server。多副本路由、持久化任务
重放与可靠 IM 投递尚未由这些接口解决；Server 重启需要 Runner 重连，不会可靠重放进行中的验收请求。

Bootstrap 令牌保存在 Instance 的环境变量中，有权读取实例配置的主体也能读取它，因此 E3 必须使用
可信运维项目。拒绝抢占活跃连接不能防止有权限的读取者抢先建立首次连接。同一分配存在仍在发送心跳的
连接时，新连接不能替换它；续期时发现权限已明确撤销则关闭连接，已知配置校验失败的分配不能认证或续期。
就绪状态是经过认证的 Runner 基于本地探测给出的报告，不是远程可信证明。处理就绪帧只检查数据库，
不执行 Cloud Admin 写操作。

## 原生隔离与取消

镜像内单独构建 /opt/sandbox-root，启动时显式指定，避免默认挂载父容器根目录。平台 resolver
不会被直接挂载：Runner 先对 /etc/resolv.conf 的字节做有界校验，再写入 workspace 与 rootfs 之外的
全新私有目录，并把该副本只读挂载到 /etc/resolv.conf。Runner 挂载每 Session 的 /workspace、该
resolver 副本与下文说明的只读 E4 公开代理目录；不挂载父容器 HOME、私有运行时状态或 bootstrap
凭证目录。父容器和原生 Sandbox 均使用
源码维护的 Linux init 回收被收养的子进程。

Instance 父进程需要特权：原生 sandbox launcher 要求 root，因此精确的 `opentag-runner serve`
进程由源码自有的 init 以 root 运行。通过镜像 entrypoint 调用的其余命令（identity、probe、skills、accept、worker）
都通过基础镜像自带的 `setpriv` 以 uid/gid 10000 执行并清空附加组；容器若本身以非 root 启动，
entrypoint 绝不提权。worker 仍只作为原生 Sandbox 子进程运行——父进程绝不亲自执行用户任务，
挂载限于上文的 workspace、resolver 副本与公开代理目录。原生 `sandbox exec` 直接调用 worker，
绕过镜像 entrypoint；GCP 实测该路径在原生 Sandbox 内以 uid 0 运行，不继承 entrypoint 的 uid 10000
降权。因此当前隔离依赖平台 Sandbox 与受限挂载，不额外承诺非 root worker 边界。
原生 worker 降权保留为后续加固项。

worker 通过有大小限制的 stdin 获取参数。Pi 配置筛选为 DeepSeek，拒绝 shell 凭证间接执行，
写入私有临时目录；不向 worker 下发控制令牌。验收脚本验证本地原配置未变。

取消 supervisor CLI 不能证明 Sandbox 子进程停止。每次验收结束都会等待原生 delete --force，
再创建和探测新的原生环境，保留 Instance 内的 workspace 挂载；清理完成后才报告结果或允许重连。
清理失败时 Runner 以失败状态退出。这是 E3 验收环境重置，不是持久化 Session resume。

## E4 Cloud IM 投递（默认关闭，原生／IM 验收待完成）

E4 通过同一条已认证 Runner 控制通道，把规范化 IM 消息投递给 Session 已有的 Cloud 分配。它是
E3 protocol version 1 的增量能力，默认关闭：Server 仅在 OPENTAG_CLOUD_RUNNER_ENABLED=true
且完成下述 Cloud 身份配置时启用 Runner 路径，仅在 OPENTAG_CLOUD_MODEL_ENABLED=true
且显式配置白名单时启用模型路径。E4 不新增数据库表或迁移，只复用已有的投递、custody 与
durable work 记录。

控制边界：delivery:run（Server 已持久化 dispatch）→ Runner 在可信父进程存储中以 fsync 记录
精确输入、输入 hash 与完整分配 scope → delivery:received → Server 持久化 durable custody →
delivery:verified（携带执行级模型授权）→ 原生 Sandbox worker 执行 → delivery:report →
delivery:report:ack。received 条目通过新的 verified 恢复；进程已死的 started 条目只报告一次
unknown，绝不重放；reported 条目持续重发，直到匹配的 durable ack 清理。在别的分配下重新打开
journal 会 fail closed（scope_mismatch）且不发送任何陈旧帧；同 id、不同输入的重投递是可见冲突，
不会变成第二个 Turn。

默认可信状态目录为 `$TMPDIR/ots/<长度受限的-sandbox-name>`（Runner 镜像内 TMPDIR 为 `/tmp`），
保证实际公开 Unix socket 路径不超过 100 字节。输入 journal 达到 1,024 条时拒绝新条目，但仍允许
重复回执与清理已有条目的确认。连接关闭时清除排队的验证授权；持久化的 received 条目必须在新
连接上重新验证。旧连接中排队的帧不能在重连后授权新执行。
排队 Turn 在启动前被取消时报告 not_started，并立即继续处理 FIFO 中的后续条目，不依赖新消息
或可用性通知来唤醒队列。

尚未 dispatch 的 Cloud 输入复用已有 ingress TTL 与每 Session 队列容量（direct 100 条、ambient
500 条），过期或超量会记录明确终态原因。已 dispatch 的 Cloud 输入保留冻结的执行窗口；已接收但
尚未报告的 custody 不作为 pending 输入清理。未配置 E5 持久化时，restore_required 明确拒绝替换环境；
配置 E5 后允许重新分配，但必须恢复并校验成功后才能执行。已停止的环境明确拒绝输入。
暂时的模型或 Runner 不可用仍可在输入 deadline 内重试，复用现有尝试次数，按
2 秒起步、最多 30 秒的指数间隔退避。Cloud 后续消息等待当前 Turn 结束，不进入 Local steering 路径。

凭证与模型边界：#633 runtime-credential Relay 始终在可信父进程；Sandbox 只拿到只读 public
材料（CA 证书、每 Turn 代理 socket、不透明 handle、每 Turn provider 环境文件），绝不包含平台
master key、bootstrap token 或原始 provider 凭证。平台提供的模型访问通过模型代理；授权绑定到执行，
生存期受 runtime deadline 约束。E4 在 Runner 连接丢失时撤销凭证与模型授权
（fail-closed，权限按连接隔离）。journal 恢复仍保留真实 Turn 结果且绝不重放 started 工作，但
暂时的 Server／控制通道中断可能使进行中的模型／工具调用失败。E4 不承诺模型调用不中断，也不
新增授权续期协议；如产品需要则属于后续工作。

模型代理只接受兼容 Pi 的严格 chat-completions 请求，拒绝路由和凭证覆盖字段，每个请求最多一个
completion，输出预算上限为 65,536 token。省略两个输出预算字段时，代理补充 `max_tokens: 65536`，
因此不能通过省略参数绕过限制。这是单次请求限制，不是累计费用配额。
Assistant 历史保留 Pi 的 reasoning_content、reasoning、reasoning_text 回显，以及有大小限制的
签名工具调用加密 reasoning_details。这些历史字段不放宽顶层路由或凭证字段白名单。

授权登记表的 4,096 条上限用于限制 Server 状态量，并涵盖并发签发；它不是每 Account 执行配额
或模型费用预算。账号级准入与公平性属于后续资源策略，当前单一 Account 仍可能占满全局上限。

写入边界：E4 依赖的持久记录是 Server 的 IM 投递 custody 与 Turn 报告，以及 Runner 按分配保存的输入
journal，而不是通用的 provider 写入账本或回执。Turn 期间代理的 provider 写入遵循 #634 规则：每个代理
请求只向上游发起一次尝试，并在内存中分类为成功、确定拒绝或未知；未知写入以明确的
`write_outcome_unknown` 呈现，由任务层核对结果，绝不自动重放。因此 E4 不承诺跨崩溃的 provider
副作用 exactly-once。

取消边界：杀掉 sandbox exec 包装进程不能证明命名空间进程树已停止。任何非 completed 的 Cloud
Turn（取消、超时、失败或未知）结束时会立即执行与 E3 相同的已验证重置，此时 Turn 占用仍被保留，
且发生在发布终态报告之前：delete --force、重新创建、重新就绪探测。清理不依赖下一次投递触发，
因此已停止的 Session 不会留下孤儿原生子进程。重置失败会发布诚实的 unknown 清理失败报告而非
“安全取消”，使 Runner 不可用，并通过既有失败路径关闭 Runner，绝不静默复用；Cloud Turn 或待处理
重置占用 Sandbox 时，E3 acceptance 不能启动。worker 非零退出即使 stdout 声称 completed，也绝不
报告为 completed Turn。
所有 Runner 退出路径都会先标记 stopping 再等待活动 worker 收尾。关闭时只验证删除命名空间，
不重新创建；旧版非持久化模式因认证拒绝或重连次数耗尽而退出时也遵循此顺序。持久化 Runner
认证失败后保留未保存文件，分配范围续期和资源丢失恢复见 [Workspace 持久化](cloud-workspace-persistence.md)。

恢复时还会检查 Session、Agent、binding 或 Account 是否已停止授权。断线期间丢失 stop 帧时，
若仍在线的 Runner 报告 received 或 started，Server 会重新发送取消。releasing 本身不代表结果
已丢失；分配释放期间仍接收真实报告。worker 负责持久化的执行 deadline，父进程 exec 只增加
5 秒作为清理与报告的兜底时间。
IM binding 处于 reauthorization_required 时暂停新的执行授权，不仅因该状态就拒绝排队输入或
取消已接收工作。输入 TTL／容量限制仍有效，已有报告仍可恢复。恢复认证后重新允许正常投递与
恢复；Session／Agent／Account 停止以及释放分配仍会取消工作。
暂停期间认证的连接不会获得执行授权。心跳或恢复交互检测到权限恢复后，Server 通过既有控制
握手要求重新连接，恢复就绪状态和凭证打开能力，无需替换 Instance 或丢弃 journal。

连续性与密钥：Pi 会话状态与持久化 provider binding 位于 Session workspace 的
.opentag/pi-session 子树，因此同一 Agent Session 在多次 Turn 及原生 rootfs 重置后仍保留 Pi
binding／历史。模型授权与发布的 provider 环境只存在于每 Turn 的 0600 scratch 文件，Turn 结束即
删除，绝不进入持久化会话状态。生产环境要求真实的 connect.sock／slack.sock 挂载；loopback
回退只存在于显式本地测试 seam 之后，生产组合绝不使用。

兼容与发布：Runner 在 auth 帧请求 cloudDeliveryVersion: 1；Cloud 已启用的 Server 只对该连接
回显能力与当前 allocation UID，其他连接保持与 E3 完全一致的 welcome 形状。带能力但 UID 尚未
跟踪的 welcome 按暂时性失败重试。先发布 Server，再发布固定 digest 的 E4 Runner 镜像；新 E4
Runner 不承诺兼容旧严格 Server，而 E3 Runner 连接新 Server 仍受支持。

E3 的续期与 acceptance 结果仍要求完整有效的授权链。只有已协商 E4 的连接，才可在授权停止后、
精确分配仍有效时保留结果回传通道，且不能授权新执行。数据库暂时性校验错误不会被当作撤销。
认证信息在注册到 hub 前读完，防止 heartbeat 先于认证结果到达。

边界：E3 仍是原生执行验收路径。E4 不实现 GCS workspace 恢复（E5）、并发多 Turn 放置（E6）、
空闲复用／回收（E7）或 Context Tree 同步（E8）。原生 Cloud Run 执行、真实 GCP 验收与真实 IM
provider 收发验收仍待完成；当前证据只有本地组合与外部本地探针。不得凭本地结果宣称 E4 已验收。

## 配置

启用 E4 执行时，Server 还需要以下模型配置：

| Server 环境变量 | 含义 |
| --- | --- |
| OPENTAG_CLOUD_MODEL_ENABLED | 默认 false，true 启用 Cloud 模型代理 |
| OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL | 固定 HTTPS OpenAI-compatible API base URL |
| OPENTAG_CLOUD_MODEL_MASTER_KEY | 仅保留在 Server 的上游密钥，不复制进 Runner 镜像或 Sandbox |
| OPENTAG_CLOUD_MODEL_ALLOWED_MODELS | 逗号分隔的模型白名单；Agent 未指定模型时使用第一项 |

默认保留现有传输限制；仅在验收证据表明需要时调整。可选超时、请求和响应大小、并发流与令牌
期限配置见 [cloud-model-config.ts](../../packages/server/src/cloud-model-config.ts)。本文不会实际配置环境。

先设置 OPENTAG_CLOUD_IDENTITIES_ENABLED=true、OPENTAG_CLOUD_STORAGE_BASE，以及与镜像 CLI
版本一致的 OPENTAG_CLOUD_RUNNER_VERSION。

| Server 环境变量 | 含义 |
| --- | --- |
| OPENTAG_CLOUD_RUNNER_ENABLED | 默认 false |
| OPENTAG_CLOUD_RUNNER_IMAGE | 必须为 name@sha256:… |
| OPENTAG_CLOUD_RUNNER_PROJECT / REGION | 项目与区域 |
| OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT | 最小权限 Instance 身份 |
| OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN | 可达 HTTPS/WSS origin，无路径、query、凭证 |
| OPENTAG_CLOUD_RUNNER_VPC_NETWORK / VPC_SUBNET | Direct VPC 网络与子网 |
| OPENTAG_CLOUD_RUNNER_EXECUTION_TAG | 对应预先部署的执行环境防火墙规则 |
| OPENTAG_CLOUD_RUNNER_API_TIMEOUT_MS | 单次调用期限，默认 30000 |
| OPENTAG_CLOUD_RUNNER_CREATE_CONVERGE_TIMEOUT_MS | 创建收敛期限，默认 120000 |
| OPENTAG_CLOUD_RUNNER_BOOTSTRAP_TOKEN_TTL_SECONDS | 默认 1800，通过当前连接续期 |
| OPENTAG_CLOUD_RUNNER_ACCEPTANCE_TIMEOUT_MS | 验收期限，默认 900000 |
| OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN | 云外验收短期令牌，必须显式 OPENTAG_ENV=dev |

托管 Server 从其 GCE 服务账号 metadata 获取 Cloud Admin access token，不读取本地凭证文件，
不执行 gcloud；暂未实现通用云外 ADC。控制面身份需要 Instance／operation 管理和 act-as 权限。
Instance 服务账号不能继承 Server 权限。

## 网络前提

运维预先部署 Direct VPC ALL_TRAFFIC、公网 NAT 和 execution tag 对应的防火墙，按需开放
DNS、HTTPS、HTTP、Git，限制私网／特殊地址和不需要的端口。Server 创建后核对实际网卡、子网、
egress、tag，以及镜像、规格、ingress、身份、端口等配置，不自动创建防火墙。使用 IPv6 前另行制定策略。

已验证的 us-west1 环境中，v2 创建接口存在 Direct VPC 表示兼容问题。只针对已拒绝的 VPC 字段
400 使用区域 v1 等价请求；两条路径都保持 internal ingress、禁用 default URL、IAM invoker
检查、不自动重启、sandbox launcher、唯一声明端口 8080、Direct VPC ALL_TRAFFIC。不会回退到
默认出站。读／删使用 v2。

VPC 防火墙本身不证明父容器 loopback 或 metadata 隔离，必须实测原生环境。Git 使用正常 DNS／TLS，
不得固定主机 IP 或关闭证书校验。

参考：[原生 CLI](https://docs.cloud.google.com/run/docs/reference/sandbox-cli)、
[文件系统与网络](https://docs.cloud.google.com/run/docs/code-execution)、
[Instance 配置](https://docs.cloud.google.com/run/docs/configuring/instances/sandboxes)、
[条件删除](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.instances/delete)。

## 验收

先运行仓库门禁和镜像离线工具链测试。后者包含不依赖 Docker --init 的信号转发和孤儿进程回收检查。
本地 Docker（包括 amd64 仿真）通过，不代表原生 Cloud Run 验收通过。

执行 pnpm build 后查看 node scripts/e2e/cloud-computer.mjs cloud-runner --help。
E4 暂无 GCP 命令，其维护的本地组合检查为：

```bash
pnpm build
pnpm --filter @opentag/shared test
pnpm --filter @opentag/client exec vitest run src/__tests__/cloud-journal.test.ts src/__tests__/cloud-turns.test.ts src/__tests__/cloud-turn-worker.test.ts src/__tests__/cloud-sandbox-credential-bridge.test.ts src/__tests__/runner-serve.test.ts
pnpm typecheck
```

这些用例覆盖 durable journal 边界、重复／并发 dispatch、deadline／授权准入、重放与重连恢复、
原生命名空间清理门禁、无 loopback seam 的 socket 处理，以及只使用本地 fixture 的真实 loopback
WebSocket 投递路径；不能证明原生 Cloud Run 隔离、原生 Unix socket 挂载、真实 GCP 验收或真实
IM provider 收发。这些必须由 Cloud 验收与真实 IM 验收提供证据后，E4 才可称为已验收。
云验收须显式传入项目、区域、digest、服务账号、backend origin、VPC／子网／tag，并通过环境变量传入
短期 Cloud Admin token。脚本启动一次性 PostgreSQL 和真实本地 Server。OPENTAG_E3_PORT 可固定
loopback 端口，供另行批准的 WSS-only proxy／tunnel 使用；脚本不创建隧道，不暴露 account API
或生产数据库。真实模式使用 --mode real --provider deepseek --pi-config-dir /absolute/path，
发送前先筛选对应 provider。

脚本创建两个独立 Session 分配，并发执行真实原生验收。summary.json 记录源码版本、替代项、资源
名称／UID、结果与清理。所有正在进行的步骤收敛后才拆除环境。成功、失败及 SIGINT／SIGTERM 都先
删除云资源，再清理本地 fixture；清理不明则失败并保留资源记录。SIGKILL／主机丢失仍需按记录人工
核对，不等待 Server 的 E7 空闲扫描（其本身由上述单元套件覆盖）。最终验收要求本地门禁、真实云执行与资源删除全部有证据；
validate-only API 仅证明请求兼容。

## E6：Cloud Session 并发

同一 Cloud Agent 可以并发执行多个 **Agent Session**。每个 Session 仍独占一个 Sandbox 和一个
Instance，不共享可写工作目录或 Pi 历史。Cloud Computer 是 Account 的逻辑身份，不是执行锁。

现有 IM delivery worker 对 Cloud 使用 Session 队列，对 Local 保持 Agent 队列。持久化执行占用
遵循相同边界：运行中或结果不确定的 Cloud delivery 只阻挡自己的 Session；Local 保持 Agent 级
占用。PostgreSQL advisory lock 仍按 Agent 短暂串行化领取决策，在资源分配、投递和执行前就已释放。
提交后的持久化占用阻止其他 Worker 在同一个 Session 内重复准入。

尚未投递的 Cloud 输入还须等待同一 Session 中更早的 pending 输入，包括等待重试或被其他 Worker
锁住的输入。排序复用消息历史顺序（occurredAt、provider revision、message ID）。已经领取或冻结
dispatch 的工作保留恢复路径：即便更早的 provider 事件晚到，过期 claim 也不能等待被自己阻挡的输入。
其他 Session 可以独立推进，晚到的 provider 事件不会重新排序已经领取的工作。

不新增表、migration、执行状态机或共享工作区。现有 Worker 并发及队列上限约束投递工作，不代表
Cloud Instance 数量或模型运行任务数上限；Account 资源配额后续独立处理。Session 停止和连接断开
沿用 Session／Sandbox／generation 权限边界；Agent 暂停仍阻止其所有 Session 的新执行准入。

### 本地证据与真实环境验收边界

```bash
pnpm --filter @opentag/server exec vitest run src/__tests__/im-delivery-custody.test.ts src/__tests__/im-delivery-worker-cloud.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/cloud-session-concurrency.test.ts --maxWorkers=1
pnpm --filter @opentag/client exec vitest run src/__tests__/runner-workspace-wire.test.ts
```

PostgreSQL 集成测试使用真实 migration、竞争 Worker，以及接入生产 delivery owner 的 loopback
WebSocket，检查 Session 并发、重试顺序、队首锁定、取消及模型授权隔离、跨 Session 伪造回执和结果
拒绝、结果去重及 Agent 暂停。Runner peer 从已认证分配开始，不覆盖 bootstrap 认证或真实模型执行。
Client 测试运行生产 Runner HTTP／WebSocket 编排，原生执行和存储使用本地替身。这些检查相互补充，
不代表原生 Cloud Run 验收通过。

云配置获得确认后，在 staging 进行一次 E4–E6 组合验收：

1. 记录 Server revision 和 Runner image digest。让两个真实 IM 对话绑定**同一个** Cloud Agent，
   记录各自不同的 Session、Sandbox、Instance ID 和 storage URI。
2. 让 A 执行有时间上限的任务，再向 A 发送第二条输入，同时让 B 完成短任务。记录执行重叠时间；
   A 的第二条输入须等待，B 的回复只到达 B。
3. 写入不同的标记文件和 Pi 对话历史。B 运行期间取消或断开 A，确认 B 正常完成且模型授权仍有效，
   A 自身结果须准确反映实际执行情况。
4. 分别保存并正常释放环境，再创建替代环境继续各自 Session。确认恢复自己的文件及 Pi 历史，
   看不到另一个 Session 的数据。
5. 暂停 Agent，确认两个 Session 都不接受新执行。收敛未完成 delivery，释放任务创建的环境，
   按资源名称和 UID 验证删除。

保存时间戳、delivery／turn ID、结果和清理记录，不保存凭证。E3 cloud-runner 脚本本身尚未实现上述
IM／持久化组合验收；本地通过或发布镜像不能作为这项验收的完成证据。

### 收件过期与凭证代理范围

尚未被 Server 接收的派发窗口过期时，回执返回 `dispatch_expired`，由现有 Worker 释放该次派发，
在原始消息 TTL 内重试。已接收输入通过取消和回报结算，不自动重放。分配进入 `releasing` 后，
已有连接仍可完成收件确认和回报。

Agent 环境只携带专用的代理参数，不设置全局代理和私有 CA。Git 仅为 `github.com` 配置代理和
CA；普通 HTTPS、公网 GitLab 保留直接出站与系统信任。`gh`、Slack 启动器仅向自身进程注入
代理和 CA，飞书沿用 CLI 专用配置。原始 provider HTTP 请求应在子 shell 中加载
`$OPENTAG_PROVIDER_ENV_FILE`。凭证代理的目标域名白名单不变。

先部署本次 Server，再更新 Runner 镜像：持久化 Runner 会在严格认证帧中发送 `renewExpired`。
续发凭证后仍需重新握手，并使用有界重连退避；续发认证允许 45 秒完成 Cloud API 查询。

## E7：空闲回收与同账号物理实例复用

E7 在不引入第二个时间窗或预热池的前提下回收空闲 Cloud 环境。唯一预算是
OPENTAG_CLOUD_RUNNER_IDLE_TIMEOUT_MS（默认 120 秒），从最后一次**业务**活动
（sandboxes.last_activity_at）起算，心跳不计入。预算内 Instance 保持 ready，原 Session 可
直接继续而无需保存／恢复。若无人继续，同一预算由现有 Server 进程内的有界扫描（约 15 秒固定
周期，同一时刻只跑一轮）经 E5 路径封存工作目录后删除 Instance。只有在部署启用工作目录持久化
时才会自动删除：启动时未启用持久化的旧分配可能持有唯一状态副本，即使后来 Server 启用了
持久化，也只能由显式 Account stop 处理。这类实例在认领前跳过，原 Session 仍然可用。扫描按
updated_at 轮转候选，空闲预算仍只使用 last_activity_at，失败或不支持持久化的行不会长期占满批次。
没有额外保留时钟、预热池或新的调度服务。

E7 当前要求单个 Server 进程：Runner 控制归属、占用和就绪状态都保存在进程内的 RunnerHub。
仅有数据库 CAS 并不代表支持多 Server 同时工作。关闭数据库前会等待当前扫描结束。

同账号的另一个 Session 可以按需借用该物理 Instance，而不是重新冷启动。借用方必须是同一
逻辑 Cloud Computer 上的 unallocated Sandbox；候选必须是 ready、未被占用、连接着支持 E7 的
Runner，且没有 pending 或 accepted／未上报的投递、没有进行中的 acceptance。每一步都持久
可重试：先校验 provider 持久化能力与部署策略，再原子认领候选（立即撤销执行权）、经 E5 封存并校验最新的 GCS saved + sealed +
owner-generation 证明，然后在同一事务中锁定两行，先清空原行归属，再把借用行置为 preparing、
generation + 1，资源名与 UID 完全不变。整个过程不会调用 Cloud Run create、PATCH 或修改配置。
原 Session 保留自己的稳定 storage_uri 以便日后冷恢复；借用方恢复自己的归档。封存后若转移不能
提交（包括并发启动已给借用方分配了资源），立即对已封存的原实例执行可验证删除，原 Session 随后
可从归档冷恢复。只清除认领标记无法重新开放已封存的 Runner；保存结果未确认时仍保留资源重试。

自动认领就是 sandboxes 上唯一的可空列 idle_reclaim_at（迁移 0046，不新增表）。该标记存在
期间执行权被撤销，start 返回 pending，常规入口返回 pending 而**不会**返回终态
environment_stopped，因此回收或借用期间到达的消息会重试。封存过程中 lifecycle 仍为 ready；
只有证明封存成功后才把自动回收的行转为 releasing 并做可验证删除。预算时钟始终是
last_activity_at；idle_reclaim_at 只记录回收意图归属，因此被放弃的认领会按该行原始预算重试，
而不是重新开始一个新窗口。已证明封存并转入 releasing 后，删除失败或被中断时扫描凭持久标记在
下一轮直接重试，不再等待另一个预算。封存失败或结果不明时保留资源归属、认领标记和既有 workspace
保存标记。provider 确认 UID 不存在时清除绑定；读取失败绝不清除。显式 Account stop 在同一事务中
清空该标记，先于 cloud DELETE，因此晚到的转移永远无法胜出。

陈旧认领使用创建收敛期限加四个工作目录传输预算（当前额外 480 秒，覆盖 claim、下载、恢复后的
checkpoint 上传和原生初始化，不是空闲窗口）：preparing 分配在该期限内没有产生
READY Runner（包括已连接但始终未就绪的恢复）时会重新读取 provider。确认 UID 不存在或被替换时
清除绑定；仍然存在且通过归属校验的 tracked Instance 带自动意图标记走可验证删除路径，因此该
Session 的入口持续返回 pending。借用方自己的归档不受影响，下次启动会把它恢复到新一代，而不是
让 Sandbox 永远停在 preparing。

归属与部署执行策略分开校验：名称 + tracked UID + managed/environment 标签证明归属，用于保存、
续期和清理，因此镜像或 VPC 配置变化后仍能封存或删除既有 Instance；只有借用／资格路径才重新校验
完整执行策略。

空闲认领与投递接收共用同一个数据库权威边界：两者都持有 Sandbox 行锁，认领会拒绝任何
pending／已冻结投递或 accepted 未上报托管。只有在投递、收件、上报和 acceptance 边界才更新
业务活动；长时间静默执行属于托管占用，不是空闲。自动回收绝不取消进行中的工作。

### 物理控制凭证

Runner 控制认证与 Session 工作目录权威彻底分离。Server 在创建时用独立受众
（opentag-cloud-runner-control）签发的物理**控制**凭证，与既有 Session bootstrap token 一起
通过可选的 OPENTAG_RUNNER_CONTROL_TOKEN 环境变量下发；旧 Runner 忽略它。只有该凭证可以在
转移后把 Runner 解析到**不同**的当前所有者：Server 校验签名，按 currentResourceName 解析唯一
持有行，在与续期相同的 45 秒 provider 读取期限内做一次有界读取（普通握手仍使用较短期限），证明该
tracked UID 仍然存在且携带原始不可变 birth 标签（即签名的控制 claims），读取后再复查持有行，最后
校验该所有者的权威（执行需 active，上报／封存需精确持久
分配）。过期 Session
bearer 即使在同账号内也绝不跨入另一个 Session 的权威。工作目录 HTTP 仍只接受精确当前作用域
的 Session 受众。控制凭证续期需要有效签名、tracked UID 与 provider 绑定；不新增 token 表或
文件。server:credential 同时刷新当前分配的 Session token 与控制凭证，控制令牌不进入原生
Sandbox、归档、公开挂载或日志。

支持 E7 的 Runner 在 auth/welcome 中协商 reuseVersion: 1，并在 hub 中登记为可复用；旧 E5
Runner 永远不会被要求跟随交接（空闲删除仍会保存它们）。分配变化时，Runner 先静默旧控制器与
原生子进程、关闭凭证／web 执行、仅在可信父目录的 assignment 标记记录封存成功时丢弃旧工作
目录、私有材料、公开 socket 与已完成 journal，再重建新的 journal／controller／workspace，
最后才恢复新 Session 的归档。同一分配保留未保存的本地数据；缺少封存证明、清理失败或凭证未
证明时一律 fail closed，不执行新分配。每一次协商成功的物理控制 attach——包括没有本地标记的首次
绑定、带本地分配状态的父进程重启、以及任何分配变化——都必须先收到 Server 为当前持有者签发的
Session 凭证，才能进行第一次工作目录 HTTP claim；静态 birth bearer 绝不用于不同 Session，凭证
超时同样 fail closed。旧分配的重绑清理仍在进行时若连接断开，会先排空串行控制工作尾并中断其凭证等待，
因此下一个连接绝不会与清理竞争，也不会在未结算的工作目录上发布就绪。

### 本地证据与真实环境验收边界

```bash
pnpm --filter @opentag/server exec vitest run src/__tests__/sandbox-idle-instance-reuse.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/runner-ws.test.ts -t "E7 physical control credential"
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/sandbox-instance-reuse-race.test.ts
pnpm --filter @opentag/client exec vitest run src/__tests__/runner-workspace-wire.test.ts
```

Server 套件在真实 PostgreSQL 事务上证明预算回收、未结算工作围栏、封存失败重试、provider 缺失、
零 create 的同账号转移、跨账号拒绝、不可复用 Runner 拒绝以及显式 stop 抑制，并包含以真实状态变化
（而非 sleep）同步的 gated 交错：两个借用方、stop 与在途借用、dispatch 与空闲认领、acceptance
与空闲认领。Client wire 套件证明同一个物理 Runner 以不变的物理 UID 重绑到转移后的 Session、真正
恢复了借用方归档、只有记录封存成功后才清理私有材料，且未封存或清理失败时保持 closed。这些
fixture 不覆盖 GCP 策略复验或真实 Instance 进程重启。

GCP 验收时，先记录原 Session 的资源名与 UID，在其空闲且尚未删除时启动同账号第二个 Session。
确认复用保持相同物理名称与 UID，不执行 create／PATCH，且每个 Session 只恢复自己的归档。
另行等待空闲预算耗尽，确认 provider 已删除资源，再把原 Session 恢复到新的 Instance。
同时验证旧 Session bearer 无法跟随转移，以及显式 stop 能胜过进行中的借用或自动释放。

## E8：Context Tree 与 Session 协作

当前配置、私有工作目录恢复、已发布知识、受管 Session CLI 授权和验收边界见
[Cloud Context Tree 与 Session 协作](./cloud-context.md)。E8 复用已有 Sandbox 生命周期，不增加新的资源分配模型。
