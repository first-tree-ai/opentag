# Cloud Runner 执行（E3 与 E4）

[English](../cloud-runner-execution.md)

E3 将现有 Agent Session 的 Sandbox 身份连接到真实 Cloud Run Instance 和原生 Sandbox。
功能默认关闭，显式开启后每个分配使用一个 Instance、一个原生 Sandbox、1 vCPU / 1 GiB。
Runner 属于 Client，沿用 CLI 发布版本；不新增数据表或迁移。

## 边界

- Computer 是 Account 的逻辑 Cloud 身份，固定在线不代表物理实例健康。
- Agent Session 复用现有执行会话，由 IM binding 与 channel/thread 定位，不新增对话模型。
- sandboxes 关联 Session 与当前资源，使用 generation、确定的资源名、provider UID、operation name
  防止晚到回调影响新分配，storage_uri 保留稳定持久化地址。
- E3 尚未保存或恢复 storage_uri。**删除 Instance 会丢失本地工作目录。**持久化恢复属于 E5，
  IM 可靠投递属于 E4，复用及空闲回收随后实现。不能仅凭 E3 验收开启默认产品 Cloud 执行。

## 生命周期与控制

沿用 unallocated → preparing → ready → releasing → unallocated。Server 在云 API 调用前记录
资源名，并发请求核对同一个分配。创建或删除结果不明时保留归属和错误状态；创建仍可能到达时，
GET 404 不代表已清理。删除同时校验 UID 和 etag，避免误删同名替换资源。

Instance 内运行 opentag-runner serve。仅为平台默认 TCP 启动探针声明唯一的容器端口 8080；原生就绪
验证通过后，Runner 只在该端口接受连接并立即结束，不读写数据，也不提供命令、HTTP 或凭证接口。
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

凭证与模型边界：#633 runtime-credential Relay 始终在可信父进程；Sandbox 只拿到只读 public
材料（CA 证书、每 Turn 代理 socket、不透明 handle、每 Turn provider 环境文件），绝不包含平台
master key、bootstrap token 或原始 provider 凭证。平台提供的模型访问通过模型代理；授权绑定到执行，
生存期受 runtime deadline 约束。E4 在 Runner 连接丢失时撤销凭证与模型授权
（fail-closed，权限按连接隔离）。journal 恢复仍保留真实 Turn 结果且绝不重放 started 工作，但
暂时的 Server／控制通道中断可能使进行中的模型／工具调用失败。E4 不承诺模型调用不中断，也不
新增授权续期协议；如产品需要则属于后续工作。

取消边界：杀掉 sandbox exec 包装进程不能证明命名空间进程树已停止。任何非 completed 的 Cloud
Turn（取消、超时、失败或未知）结束时会立即执行与 E3 相同的已验证重置，此时 Turn 占用仍被保留，
且发生在发布终态报告之前：delete --force、重新创建、重新就绪探测。清理不依赖下一次投递触发，
因此已停止的 Session 不会留下孤儿原生子进程。重置失败会发布诚实的 unknown 清理失败报告而非
“安全取消”，使 Runner 不可用，并通过既有失败路径关闭 Runner，绝不静默复用；Cloud Turn 或待处理
重置占用 Sandbox 时，E3 acceptance 不能启动。worker 非零退出即使 stdout 声称 completed，也绝不
报告为 completed Turn。

连续性与密钥：Pi 会话状态与持久化 provider binding 位于 Session workspace 的
.opentag/pi-session 子树，因此同一 Agent Session 在多次 Turn 及原生 rootfs 重置后仍保留 Pi
binding／历史。模型授权与发布的 provider 环境只存在于每 Turn 的 0600 scratch 文件，Turn 结束即
删除，绝不进入持久化会话状态。生产环境要求真实的 connect.sock／slack.sock 挂载；loopback
回退只存在于显式本地测试 seam 之后，生产组合绝不使用。

兼容与发布：Runner 在 auth 帧请求 cloudDeliveryVersion: 1；Cloud 已启用的 Server 只对该连接
回显能力与当前 allocation UID，其他连接保持与 E3 完全一致的 welcome 形状。带能力但 UID 尚未
跟踪的 welcome 按暂时性失败重试。先发布 Server，再发布固定 digest 的 E4 Runner 镜像；新 E4
Runner 不承诺兼容旧严格 Server，而 E3 Runner 连接新 Server 仍受支持。

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
核对，不宣称已经有 E7 后台回收。最终验收要求本地门禁、真实云执行与资源删除全部有证据；
validate-only API 仅证明请求兼容。
