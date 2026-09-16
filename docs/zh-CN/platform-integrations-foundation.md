# 平台集成与凭证下发

[English](../platform-integrations-foundation.md)

OpenTag 自己管理 GitHub App、Slack 与飞书凭证。Server 组合集成管理、执行授权、短期凭证能力和平台代理；可信 Runner 向原生 CLI 进程提供 execution-local handle。

## 身份与存储

GitHub 连接属于 Account、GitHub host 和 App；同一命名空间只有一个当前连接，已撤销和已替换连接保留非敏感历史。唯一新增的 `github_connections` 表保存加密的用户 access/refresh 凭证、一个进行中的 OAuth 流程，以及有上限的仓库和 Agent 配置。Slack、飞书复用现有 IM 表。

用户凭证只用于控制面的仓库准入证明，Git 与仓库操作使用 App installation access token（IAT）。IAT 客户端只请求单个仓库与明确权限，校验实际令牌范围并支持撤销。调用者必须先确认 Account、Agent、仓库和执行权限；管理响应与 Sandbox 都不能收到真实平台令牌。仓库名仅用于展示，授权使用稳定 repository/installation ID。Code 与 Context Tree 使用不同角色和发布策略，Tree 必须指定完整分支 ref。配置写入重新核验 Agent 所有权与预期授权版本。

授权版本与凭证代次不同：范围变更、断开连接和权限丢失使运行期授权失效；正常用户令牌刷新只推进凭证代次。刷新和 OAuth 完成均比较捕获的身份与版本，晚到响应不能恢复已断开的连接。刷新结果不确定时需要重新授权，不能自动重复消费 refresh token。

健康连接默认每五分钟复查；webhook 仅提前复查时间，每次 GitHub 运行期请求仍证明当前用户准入。worker 和过期 OAuth 清理每批最多 100 行，过期清理先锁定候选行。没有 webhook 的活跃连接也会复查。IM 继续用 generation 作为保守授权版本，同时校验 Slack 安装、绑定、Agent revision 和 placement。

## 加密上线

应用加密兼容 v1 与带 key ID、调用方绑定上下文的认证 v2 信封。IM 默认仍写 v1；先部署兼容读取端，再启用 v2 写入，保留仍有密文引用的旧密钥。开始 v2 写入后不能回退到只读 v1 的程序。

绑定上下文区分用途、所属用户与稳定记录身份；替换记录、所有者、用途、key ID 或密文会认证失败。GitHub 新凭证要求绑定加密。OAuth 服务先分配最终 connection/flow ID，再在事务中调用同步加密工厂；外部 token exchange 在事务外执行，工厂不执行网络请求。替换用户失败会回滚。

## 管理与执行

按 `.env.example` 完整配置 GitHub App，OAuth 回调必须准确匹配 `OPENTAG_PUBLIC_URL` 下的回调路径。Account 页面连接或重新授权 GitHub；Agent 集成页面选择仓库、角色、权限、发布模式、Tree 分支与所有者设定的任务委托。Server 执行 CSRF、PKCE、App 身份校验、webhook 签名验证和维护 worker；未配置 App 时界面显示不可用。

运行期协商 `runtime.runtimeCredential` 与 `runtime.providerProxy`。开启 execution 绑定 Account、Agent revision、已接受任务来源、Session placement、当前 Computer 连接，以及 Cloud Sandbox generation。猜到 Session ID 或来自无关 IM 发送者都不足以取得权限。签发、续期、每次请求和长流均重新核验。

- Runner capability 有效期 60 秒，约 30 秒续期，至多保留当前和前一份。长流每五秒复查，必须存在仍有效的同范围 capability。
- 数据 WebSocket 用首帧中一次性的 15 秒 ticket 认证，拒绝 URL query、cookie 与 bearer header。每个二进制分块最多 64 KiB，另带四字节 stream ID；双向各有 1 MiB credit 窗口，消费字节后补充额度。流结束竞态仍检查未确认字节上限；未知/重用 stream ID 及超额度帧继续拒绝。
- capability 仅在 Runner 内存；CLI 仅看到本次执行 handle、公开 CA、代理地址和有限仓库/IM 元数据。App key、UAT、IAT、Bot Token、tenant token 与 Cloud 控制凭证不进入 Sandbox。
- IM 代理使用明确登记的 Slack/飞书接口，在 Bot 已获准访问的资源范围内校验当前绑定和 execution 权限。当前频道/话题是回复上下文，不是隐式的唯一允许目标。受保护读取先记录来源；写入先持久化 intent，再转发并记录结果。不确定结果禁止自动重放。JSON 写入必须同时获得 HTTP 与平台明确成功证据；缺少证据、5xx、超时或回执持久化失败保持 unknown。上传字节有独立 intent/outcome，与平台最终完成附件的调用分别记录。
- Local 默认保留原有 IM 凭证模式，在 daemon 启动环境设置 `OPENTAG_RUNTIME_CREDENTIAL_MODE=proxy` 可启用代理。Cloud 强制代理，禁止退回下发真实 IM 凭证。

Agent 继续使用 `git`、`gh`、`slack api`、`lark-cli` 原生命令名与参数。launcher 自动完成认证、代理、CA、配置、续期与清理。支持范围受已授权仓库和已登记 API 约束；用户 OAuth 命令、任意管理操作与越权请求会被拒绝。

## Git 与 Context Tree

Git smart HTTP 在可信 Server 网关终止，读取来自有资源上限的临时仓库快照。写入先完整暂存 receive-pack，校验旧 ref、对象完整性、快进关系、允许引用及资源限制，再用预期引用 lease 原子发布并确认远端 SHA。IAT 仅授权单仓库和明确权限，按请求持有，在请求结束及 execution 关闭时撤销。撤销接口成功和另一次请求证明令牌失效是不同验收证据。

Code 写入使用 `refs/heads/opentag/<session-id>/code/`；Tree direct 只能写配置分支，Tree PR 使用 `refs/heads/opentag/<session-id>/context_tree/`。Code 读取覆盖所选仓库的全部分支；Tree-only 读取只暴露配置分支和本 Session 工作分支。发布 Tree commit 或创建/更新其 PR 时，在 Agent 容器外用固定版本 `@first-tree-ai/context-tree` 验证实际提交 SHA。拒绝 gitlink 和任意软链接，仅允许工具生成的根目录 `CLAUDE.md -> AGENTS.md`。

GitHub 代理解析 REST 路由与 GraphQL AST，处理 alias、fragment、variable 和 node identity。PR 修改核验仓库、本 Session head 与允许 base；Tree-only 查询固定在配置 base。没有任意 GitHub API 转发、任意 Git 对象写入、合并权限或分支保护绕过。

## 部署、持久化与恢复

`createPlatformRuntime` 是 Server 装配入口，Server 镜像包含 Git 和固定版本 Tree verifier。`OPENTAG_RUNTIME_CONTROL_DIRECTORY` 必须指向 Server 私有持久卷：镜像默认 `/var/lib/opentag/control`，本地默认 `.opentag-control`。目录属于 Server 用户、权限 0700、祖先无软链接；记录权限 0600。重建 Server 保留此卷，与应用状态一起备份，禁止挂载到 Sandbox。

`FileSessionControlStore` 保存有上限的来源、intent、outcome 和 reconciliation 元数据，不保存 payload 或平台凭证。记录不可变、写入执行 fsync；同一 Session 由一个权威 Server owner 串行处理。这不是多 owner 的分布式文件锁；部署必须把 Session 路由到对应 owner。结果不确定会阻止向同一 provider resource 再次写入；owner 检查提供商后，用匹配的 Session、operation ID 与 intent hash 调用 `reconcileWrite`，记录判定且不会重新发送。仅在确认 Session 已结束后调用 `removeCompletedSession` 做保留期清理；有未解决写入时会拒绝删除。

`FileCloudControlAuthority` 是可信部署侧签发、轮换、撤销和过期清理 API，仅持久化凭证哈希。签发结果绑定已有逻辑 Cloud Computer 与 installation，交给可信控制器，禁止进入 Agent 文件。先签发替代凭证、重新连接，再撤销旧凭证；撤销旧凭证不会误断开新连接。注册、心跳、请求和流持续检查控制身份。

`CloudSandboxCredentialBridge` 是 Cloud 编排使用的 Linux 命令边界：Relay 在命令容器外，只挂载本次 execution 的公开 socket 目录和 workspace。容器使用 UID 10000、无外网、无 capabilities、只读根目录、有资源上限及临时可写目录。控制丢失会结束容器，同一 execution 不可重放。它需要可信 Linux Docker 控制器，macOS 主机 socket 绑定不能等同验收；该入口支持后续 Cloud 编排，本身不创建云服务或模型网络通路。

## 验收边界

本地必须验证协议与授权、PostgreSQL 迁移和权限、原生 CLI 经实际 Relay/代理调用、越权拒绝、撤销取消及 Sandbox 可见内容。GitHub 真账号还需正确 App 安装权限与指定测试仓库；OAuth/UAT 与真实 PR 操作独立于 IAT-only Git 验证。真实 IM 验收必须指定测试 Bot、会话，并明确测试消息/文件的发送权限。离线 fixture 不能代表真实账号验收，生产部署和发布另行验证。
