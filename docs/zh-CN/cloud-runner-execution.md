# Cloud Runner 执行（E3）

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

## 原生隔离与取消

镜像内单独构建 /opt/sandbox-root，启动时显式指定，避免默认挂载父容器根目录。
仅挂载 Session 的 /workspace 与平台只读 /etc/resolv.conf，不挂载父容器 HOME、运行时状态或
bootstrap 凭证目录。父容器和原生 Sandbox 均使用源码维护的 Linux init 回收被收养的子进程。

worker 通过有大小限制的 stdin 获取参数。Pi 配置筛选为 DeepSeek，拒绝 shell 凭证间接执行，
写入私有临时目录；不向 worker 下发控制令牌。验收脚本验证本地原配置未变。

取消 supervisor CLI 不能证明 Sandbox 子进程停止。每次验收结束都会等待原生 delete --force，
再创建和探测新的原生环境，保留 Instance 内的 workspace 挂载；清理完成后才报告结果或允许重连。
清理失败时 Runner 以失败状态退出。这是 E3 验收环境重置，不是持久化 Session resume。

## 配置

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
