# 平台集成与凭证下发

[English](../platform-integrations-foundation.md)

> Last synced with: 2026-10-15

OpenTag 自己管理 GitHub App、Slack 与飞书凭证。Server 组合集成管理、执行授权、短期凭证能力和平台代理；可信 Runner 向原生 CLI 进程提供 execution-local handle。

## 身份与存储

GitHub 连接属于 Account、GitHub host 和 App；同一命名空间只有一个当前连接，已撤销和已替换连接保留非敏感历史。唯一新增的 `github_connections` 表保存加密的用户 access/refresh 凭证、一个进行中的 OAuth 流程，以及保留的历史仓库 JSON。旧字段只用于存储兼容，新业务不查询、不修改，DTO 不返回。Slack、飞书复用现有 IM 表。

运行期 Git、REST、GraphQL 直接使用 Agent 所属 Account 当前连接的 GitHub App 用户令牌。Server 核验任务、账户与 execution 权限，取得当前凭证后再次核验，再打开上游请求。GitHub 执行用户权限、App 权限与安装选择范围的交集。真令牌留在 Server，Sandbox 只得到 execution-local handle。PR 和评论显示连接用户身份；commit author、committer、原始字节、对象 ID 与签名保持不变。

GitHub API 使用连接用户的共享配额。运行期每次请求不再派生、撤销令牌或额外探测仓库身份，也不新增令牌缓存或仓库授权缓存。

IM、用户定时任务和可追溯 Agent 协作都使用 Agent 所属 Account 的当前连接；IM 发信人不会自动映射为独立 GitHub 身份。本次不新增操作审计、发送者账号映射、数据库迁移或身份配置；现有任务来源继续用于授权。

Agent 自行选择仓库、ref、PR head/base、合并和 review 操作，并可跨 Session 接续工作。运行期不解析 GraphQL 字段、不保存 node 身份、不规划逐操作权限，也不区分 code/Tree role。GitHub 既有权限与仓库规则仍生效，OpenTag 不维护额外仓库白名单。

授权版本与凭证代次不同：范围变更、断开连接和权限丢失使运行期授权失效；正常用户令牌刷新只推进凭证代次。刷新和 OAuth 完成均比较捕获的身份与版本，晚到响应不能恢复已断开的连接。刷新结果不确定时需要重新授权，不能自动重复消费 refresh token。本地凭证信封认证失败不属于结果不确定：请求从未发送到 GitHub，刷新 claim 原样释放，凭证保留待后续重试。定期复查发现 access token 已过期时按 transient 推迟，由刷新流程负责过期恢复，预期的 401 不会清除仍可恢复的 refresh 凭证。在 access token 过期之时或之后返回的凭证失效响应同样按 transient 推迟。刷新成功同时推进复查代次（不推进授权版本），针对旧凭证得出的判定永远不能落到新凭证上，运行期授权保持有效。

健康连接默认每五分钟复查；webhook 仅提前复查时间，每次 GitHub 运行期请求仍证明当前用户准入。worker 和过期 OAuth 清理每批最多 100 行，过期清理先锁定候选行。没有 webhook 的活跃连接也会复查。IM 继续用 generation 作为保守授权版本，同时校验 Slack 安装、绑定、Agent revision 和 placement。

## 加密上线

应用加密兼容 v1 与带 key ID、调用方绑定上下文的认证 v2 信封。IM 默认仍写 v1；先部署兼容读取端，再启用 v2 写入，保留仍有密文引用的旧密钥。开始 v2 写入后不能回退到只读 v1 的程序。

绑定上下文区分用途、所属用户与稳定记录身份；替换记录、所有者、用途、key ID 或密文会认证失败。GitHub 新凭证要求绑定加密。OAuth 服务先分配最终 connection/flow ID，再在事务中调用同步加密工厂；外部 token exchange 在事务外执行，工厂不执行网络请求。替换用户失败会回滚。

## 管理与执行

按 `.env.example` 配置 GitHub App，OAuth 回调匹配 `OPENTAG_PUBLIC_URL`。现有 Account 页面管理连接、重新授权、切换账户和断开。仓库选择由 GitHub App 安装流程管理；OpenTag 不再提供 Agent 仓库分配、仓库级委托或额外账户白名单。旧绑定接口返回 HTTP 410，历史 JSON 不变。仓库发现只服务于 Account 的安装和刷新展示，不承担执行鉴权。

现有 IM 渠道准入允许 Agent 接收任务的所有人类发送者，都可以请求使用该 Agent 所属 Account 的 GitHub 连接，权限受该 GitHub 用户和 App 限制。这一范围有意不限于 Account 本人；不会将 IM 发送者映射为另一 GitHub 身份，也不维护 GitHub 专属发送者或仓库白名单。

定时任务必须具有 Server 记录的执行来源。创建、编辑和 Agent 恢复执行时捕获当前有效 execution 的来源，派发时将该来源冻结在消息上。仅有调度器 origin 不授予权限。缺少可追溯人类来源的历史或自主定时任务继续运行，但不获得 GitHub 权限；Account 暂停和恢复不会升级其来源。已派发任务在定时配置变更或删除后仍保留原始来源快照。

协作同样需要从当前有效执行记录准确来源：Session CLI 在既有 Session proof 之外提交非秘密 execution ID，Server 核验执行存活及隔离后记录来源。Local 命令每次调用都从稳定的 provider 环境文件读取当前 execution 标记，即使 provider runtime 跨轮复用也使用本轮来源；Cloud 的每轮环境文件提供相同标记。当前材料缺失时，不回退到进程继承的旧 execution ID。旧协作消息若来源不明，以及 Bot、自主请求、裸 Session 和连接探测，不获得 GitHub 权限。运行元数据和提示词不再包含仓库目录。

Local 协商 `runtime.githubUserTask: 1`，Cloud Runner 通过 `githubUserTaskVersion: 1` 加入。缺少该声明的旧端仍能登录、使用 IM、恢复连接和升级，但不能取得 GitHub provider。已有该能力的旧端连接新 Server 时保留既有操作。新数据客户端声明 `opentag-provider-http-v2` WebSocket subprotocol，新 Server 仅向这些客户端返回 `httpVersion: 2`；新客户端连接旧 Server 时保留既有方法，HEAD 则在本地明确返回 `github_protocol_upgrade_required`。先部署 Server，再更新 Runner/Local；旧 Server 升级前仍保留原有限制，包括累计请求上限。

现有账户 GitHub 区块在连接有效时提供安装和刷新操作，已有个人、组织或暂停安装记录时也会保留。服务端通过 GitHub 查询配置的 App，要求返回的 App ID 和 OAuth Client ID 与部署配置一致，并验证 App slug 安全；元数据缺失或不匹配时拒绝跳转。已登录账户因此会安装当前部署所配置的 GitHub App，无需新增设置页面或 App slug 配置。安装在新标签页中打开；完成后刷新原有区块以发现仓库。打开安装链接本身不会授予仓库或 Agent 访问权限。

Account 刷新保留焦点、播报安装/仓库数量与错误，并支持重试；不会写入任何仓库配置。已有安装时继续保留安装和刷新入口。

运行期协商 `runtime.runtimeCredential` 与 `runtime.providerProxy`。开启 execution 绑定 Account、Agent revision、已接受任务来源、Session placement、当前 Computer 连接，以及 Cloud Sandbox generation。猜到 Session ID 或来自无关 IM 发送者都不足以取得权限。签发、续期、每次请求和长流均重新核验。

- Runner capability 有效期 60 秒，约 30 秒续期，至多保留当前和前一份。长流每五秒复查平台 Account、连接和 execution 权限。GitHub 对新请求执行仓库 ACL；M1 不承诺已打开流在仓库 ACL 变化后五秒内发现失权。
- 数据 WebSocket 用首帧中一次性的 15 秒 ticket 认证，拒绝 URL query、cookie 与 bearer header。每个二进制分块最多 64 KiB，另带四字节 stream ID；双向各有 1 MiB credit 窗口，消费字节后补充额度。流结束竞态仍检查未确认字节上限；尚未到达的未知 ID、重用的 open ID 及超额度帧继续拒绝。超出有界历史的迟到帧无效且不恢复状态。
- capability 仅在 Runner 内存；CLI 仅看到本次执行 handle、公开 CA、代理地址和非秘密 IM 元数据。App key、父/派生 UAT、Bot Token、tenant token 与 Cloud 控制凭证不进入 Sandbox。
- IM 代理使用明确登记的 Slack/飞书接口，在 Bot 已获准访问的资源范围内校验当前绑定和 execution 权限。当前频道/话题是回复上下文，不是隐式的唯一允许目标。每次代理写入请求只向上游发起一次尝试（每个代理请求一次），不持久化任何账本：JSON 写入必须同时获得 HTTP 2xx 与平台明确成功证据；平台明确错误和确定的 4xx（408 除外）按拒绝原样返回；缺少成功证据、5xx、408、超时、传输失败或写入响应无法解析以明确的 `write_outcome_unknown` 错误呈现。结果不确定的写入绝不自动重放——与平台核对结果由任务层负责，调用方主动重试只是一个新的代理请求。上传字节本身是独立的单次尝试写入，与平台最终完成附件的调用互不相同。
- Local 默认保留原有 IM 凭证模式，在 daemon 启动环境设置 `OPENTAG_RUNTIME_CREDENTIAL_MODE=proxy` 可启用代理。Cloud 强制代理，禁止退回下发真实 IM 凭证。

Agent 继续使用原生 `git`、`gh`、`slack api`、`lark-cli` 命令，launcher 自动提供执行路由和本地 handle。GitHub 业务 API 由 GitHub 决定授权；Agent 通道不能操作 OAuth、App secret、凭据检查、令牌创建或撤销控制面。IM 保留已登记路由和绑定策略。

## Git 与 Context Tree

M1 实现 PR 作者 `@yuezengwu` 要求的范围：让 Agent 在所连接 owner 用户/App 权限内跨 Session 自行管理 GitHub 工作，涵盖既有 IM 准入、用户配置的定时任务和可追溯的同账户 Agent 协作。不增加 GitHub 专用发送者/仓库白名单或运行期 Tree 发布门禁。GitHub 操作身份是 Agent owner；获准发起 IM 任务的发送者并不自动等于这个 GitHub 用户。这里记录的是要求实现的行为，不代表仓库 owner 或 reviewer 的批准；这些仍是独立的 PR 门禁，也不扩大平台 execution/沙箱边界。

Git smart HTTP 原样流式转发到 GitHub。运行期 Server 不创建仓库快照、不执行 Git、不检查 pack 对象、不暂存发布，也不改写 commit。任意分支、tag、ref 删除、force push、多 ref 写入和跨 Session PR 工作，都受上游 GitHub 用户/App 权限与仓库规则约束。

Context Tree 运行期 Git/gh 使用相同通道。Agent 依据 Tree skill 自行决定校验、发布和恢复；设置连接校验、配置目标同步、prepare/loading 及固定 verifier 保持独立，沿用现有限制。GitHub push 成功不代表 Tree 加载一定成功，后续加载失败也不倒改先前 GitHub 结果。

托管 Tree 准备（含缓存使用）仍要求当前 execution 传输，不回退到宿主机凭据。Local/Cloud 设置校验保留账户认证、单仓库只读令牌 lease 和固定 verifier；这些管理用途的 lease 和 Git helper 继续存在，普通 Agent 请求不调用它们。创建 Tree 仓库保持原有能力边界。

## 原生 HTTP 传输

Server 转发 REST/GraphQL 方法、原始查询字符串及业务正文，不增加 API/字段白名单，也不改写响应。原生 Node HTTP 保留压缩字节、编码/长度、分页、条件/Range 头、状态码和 GraphQL 部分错误；不制造 schema/Projects 响应，不删除普通业务中名为 `token` 的字段。gh 2.91.0 可能因可选 Projects 权限错误而无法修改无关的 PR 字段；已测试的 gh 2.100.0 会原生处理这些错误。诊断时记录实际工具版本，不改写 GraphQL 结果来掩盖差异。

认证上游仍固定为 HTTPS `api.github.com` 和 `github.com` Git smart HTTP。调用方凭据、Cookie、连接级和内部头被清除。Server 在 Git 请求中使用 HTTP Basic，用户名为 `x-access-token`、密码为当前用户令牌；REST/GraphQL 使用 Bearer。回归测试以只接受 Basic 的 Git 上游检查这一区别，避免 API 风格夹具误放行。DNS 地址先验证再固定连接，正常检查 TLS 主机名。

GET/HEAD 下载可从这些固定 origin 跟随至多五次经过验证的跳转。`http-target.ts` 接受精确的 results receiver、release-assets、objects、codeload 主机，以及严格匹配的数字 Actions 分片族 `productionresultssa[0-9]+.blob.core.windows.net`。GitHub 公布了 [Actions 存储主机族](https://github.blog/changelog/2023-01-31-github-actions-job-summary-updates/)和[下载域名](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。真实 artifact/job 日志跳转到 `sa9` 后，以此替代单个 `sa13` 样本；不接受任意 Azure/S3 主机，也不新增初始代理目标。每一跳仍验证 HTTPS/443、公开 DNS 固定连接和 TLS。跨 origin 清除凭据且不再恢复，后续跳回 API 也不恢复。未知下载目标明确失败。写请求不自动重试或跟随跳转：保留原始状态和正文，仅移除不安全或跨 origin 的 Location。完整上游错误原样返回；DNS、TLS、连接、超时和响应截断使用封闭诊断码，不包含凭据或签名 URL。

保留活跃并发和字节 credit 上限，完成流释放正文与授权，只保留至多 256 个小型收尾记录；递增 ID 防止复用，不再限制累计 256 次请求。容量满只拒绝新增流，已有流继续。超出有界收尾历史的迟到帧不产生动作；近期重复结束、超 credit 和复用 open ID 继续拒绝。上游空闲等待有界，慢消费者不会触发绝对传输总时限。

macOS 与 Linux 的 Local 原生 `gh` 使用官方 `http_unix_socket` 传输，每次 execution 独占私有 socket 和配置。自定义临时目录超过 Unix socket 路径限制时，回退到 `/tmp` 下的私有目录。适配器只接受 `api.github.com`、校验本地 handle，再经过相同 Relay 和 Server 策略；execution 关闭时删除 socket。不改系统信任库，也不关闭 TLS 验证。此 Local 原生 `gh` 支持约定覆盖 macOS/Linux，Windows 不在其支持和 CI 覆盖范围内。Cloud 保留既有 Sandbox CONNECT/CA 桥接，不向 Cloud Sandbox 发布父进程本地 socket 路径。Slack 专用 CLI 参数和配置只对 Slack 执行及验证生成。

Local 原生 Git 2.47+ 使用 libcurl 的 `socks5h://localhost/path/to/socket` 传输，接入第二个 execution 私有 socket。与原生 gh 的 IPC 一样，HTTP 仅在私有 Unix 通道内传送：SOCKS 只接受域名 `github.com`、80 端口和 CONNECT，不解析 DNS、不拨号 TCP，也不支持 IP 目标、BIND 或 UDP。启动器仅在本次进程中改写规范的 `https://github.com/` URL，保存的远端地址仍为 HTTPS。固定 GitHub origin、本地 handle 鉴权、Relay、Server execution 策略及服务端访问 GitHub 的 HTTPS 保持不变，避免 macOS TLS 后端/钥匙串差异，无须新增可信 CA 或关闭 TLS 校验。Codex profile 只授予这两个精确 socket，execution 关闭时删除。旧 Git 沿用现有认证 HTTPS CONNECT 通道，保留 Claude Code 和非受限 Local 的兼容性；受限 Codex 继续拒绝该 TCP 通道，需要 Git 2.47+/libcurl 7.84+ 才能使用私有 IPC。Cloud 保留既有 CONNECT 桥，不接收父进程 socket 路径。参考 libcurl 的 [Unix SOCKS 代理支持](https://curl.se/libcurl/c/CURLOPT_PROXY.html)。

Git 启动器把注入的 `GIT_SSL_CAINFO`/`GIT_SSL_CAPATH` 转为通用 Git 配置，再清除环境覆盖。非 GitHub origin 保留调用方的 CA 文件/目录；GitHub HTTPS 使用更具体的 execution CA 和 CA 目录。HTTPS CONNECT/Cloud 通道继续启用 TLS 校验。

生成的 `gh` 配置在发布前写入当前 schema 版本，包括 Cloud 只读挂载中的配置，避免 `gh --version` 等命令在启动时迁移写盘。限制网络的 Local Codex 执行只通过已确认加载的临时权限 profile 获得本次 GitHub Unix socket 例外；托管网络控制器使用 limited 模式，不允许任何域名或本地 TCP 绑定，其他 socket 和直接 TCP 仍被拒绝。socket 例外随 execution 轮换，下一次无 GitHub 执行前移除。不支持权限 profile 的 Codex 会拒绝执行，不在未经确认的沙箱中继续。GitHub 流打开失败保留有界原因码并返回 JSON，例如 `scope_denied` 对应 HTTP 403；未知错误仍返回 503，不返回原始错误。

Checks、Actions、Commit statuses、PR 及其他 GitHub 业务 API 使用同一连接用户令牌。App 和安装必须授予操作所需权限；代理不扩权、不把权限失败转换成成功。公开读取不能证明私库权限，必须另外验收。令牌派生仅保留于独立的 Tree 设置校验。

`GitHub Native Proxy` CI 下载 Runner 固定版本的官方 gh，验证保留 Commit 原始对象的真实 Git clone/fetch/push（macOS Local Codex IPC 和 Linux Cloud material/CONNECT）、原生 gh 工作流发现和提交筛选，以及原生 PR 生命周期和冷命令权限控制。离线 fixture 不含真实平台凭据，也不产生 GitHub 副作用，不能替代已部署用户身份及 commit 作者验收。

Execution loopback 证书包含显式 key usage 和 Apple 信任评估要求的 TLS server-authentication EKU。macOS 原生回归保留 Runner 默认 Git/TLS 后端，另外使用 SecureTransport 验证 CONNECT 和调用方 CA 路由，并保留缺少信任锚时必须失败的反向控制。依赖 HTTPS 的 macOS 测试先以独立的普通 `curl --cacert` 探测有效私有信任锚，不使用 OpenTag 实现或配置；仅 TLS 校验失败（退出码 60）会产生明确报告的能力跳过，其他探测错误和产品错误仍失败。现代 IPC 测试从不使用这一跳过。旧 CONNECT 保留现有平台 TLS 约束：不劣于 main，但尚未证明 macOS 15 系统 libcurl 可使用私有文件信任锚。Linux/OpenSSL 及具备该能力的 macOS 主机执行完整 CONNECT 和 CA 路由用例。测试不改变产品后端选择或系统信任。参考 Apple 的 [TLS 证书要求](https://support.apple.com/en-gb/103769)。

## 部署、持久化与恢复

`createPlatformRuntime` 是 Server 装配入口，Server 镜像包含 Git 和固定版本 Tree verifier。PostgreSQL 是唯一持久化的集成状态：GitHub 连接与 IM 凭证在 Server 重建后由数据库恢复。不存在 Server 本地控制卷、文件写入账本或独立来源账本——重建 Server 不需要恢复任何集成专用磁盘。短期 capability、ticket、URL handle 与 execution 状态只存在于有界 Server 内存，随进程结束；重启后 Runner 依据当前数据库事实重新鉴权。重启或 execution 关闭都不撤销 Account 共享用户令牌。

只有 Tree 设置校验保留有界临时 Git 工作区和单仓库只读令牌 lease，普通运行期转发不分配这些资源。校验目录私有，不挂载到 Sandbox，也不是权威状态。

Session 消息和定时任务中的用户任务来源属于正常的 PostgreSQL 任务状态。跨崩溃的平台操作账本与平台响应来源追踪承诺明确撤回。代理对每个写入请求只发起一次上游尝试，IM 分类执行结果，GitHub 保留原生 HTTP 结果和明确的传输错误；不承诺跨重启的持久资源封锁，也不保证平台副作用 exactly-once。如果产品确实要求崩溃后仍记住未决写入，那是持久业务状态，必须在 PostgreSQL 中显式建模并定义真实的所有权与保留语义，绝不能用外挂文件库实现。

Cloud 控制身份归属 Computer/Cloud 编排；编排与此凭证运行时的接入仍待完成。集成运行期只消费显式注入的可信 verifier 与活跃检查器（`TrustedCloudControlAuthority`）：保留 credentialId/computerId/installationId 绑定、当前数据库中的 Computer 身份（`kind = 'cloud'` 与活跃 installation），以及逐请求撤销检查。当前默认启动不注入可信的 Cloud 控制 verifier 或活跃检查器，因此 Cloud 控制认证与 Cloud 凭证活跃检查一律拒绝；Local 保留既有 machine-token 路径与仅限 Local 的限制。不存在隐式自签发 Cloud 凭证、不允许 Local token 兜底，也没有 PostgreSQL 集成凭证之外的额外文件型 Cloud 凭证数据库。execution 仍绑定其精确的当前控制连接；本次修正不提供无状态多节点执行路由。

`CloudSandboxCredentialBridge` 是 Cloud 编排使用的 Linux 命令边界：Relay 在命令容器外，只挂载本次 execution 的公开 socket 目录和 workspace。容器使用 UID 10000、无外网、无 capabilities、只读根目录、有资源上限及临时可写目录。控制丢失会结束容器，同一 execution 不可重放。它需要可信 Linux Docker 控制器，macOS 主机 socket 绑定不能等同验收；该入口支持后续 Cloud 编排，本身不创建云服务或模型网络通路。

## 验收边界

本地验证覆盖协议/授权、PostgreSQL 来源和刷新安全、真实 Git/gh 经 Server 与 Client 数据通道、取消与 Sandbox 可见材料。上线验收另行记录 Server/Local/Runner 版本、用户身份、私库权限、日志/artifact 及清理；同安装的两个用户需要独立身份与权限证据。execution 清理不能撤销共享 Account 连接。离线 fixture 不等于线上 OAuth、GitHub 效果或真实 IM 投递；IM 测试需要获准 Bot 与会话。M1 保留 execution 24h 和 MCP/Web 6h 生命周期；统一续期另列 M2 设计。
