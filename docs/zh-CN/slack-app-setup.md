# OpenTag Slack 公开分发

[English](../slack-app-setup.md)

OpenTag 对每个 App/Team 组合最多保留一组当前 Slack App/Team/Bot 安装。一个 Slack workspace 通过一等 OAuth 为一个
OpenTag Agent 安装公开分发的 **@OpenTag** Bot。installation 归该 Agent 所有；V1 入站只使用其已配置的 **default** Agent
route，否则失败关闭。

已认证的 Agent 管理流程发起 OAuth，callback 创建或更新该 Agent 的 Slack installation，并设置该 Agent 的 default route。
内部 subagent 在 Slack 中保持不可见。不再提供客户自有 Slack App、手动 token 或 Change App 路径。

当前 Slack App/Team installation 绝不会被静默共享或转移给另一个 Agent。不同 Agent 声称同一 App/Team 时返回
`SLACK_APP_TEAM_ALREADY_BOUND`，且不得产生副作用；原 owner 可以重新授权同一 installation。transfer 必须显式先
remove/uninstall，使旧 row 保留历史 Agent owner 并进入 disabled，再由新 Agent 创建新的 current row。URL verification 与
真实入站消息只属于运行观测；两者都不能创建、完成或激活凭证代际。生产 Events API 仍是带签名的 HTTP，并包含
`app_uninstalled` 与 `tokens_revoked`。不使用 Socket Mode。

## 固定的 Slack 能力契约

一等 OpenTag Slack App 在首次连接以及后续重新授权时始终请求完整能力集。`mention_only` 与 `all_message` 共用同一份
Slack 安装。

必需 bot scopes：

- `app_mentions:read`
- `channels:history`
- `channels:join`
- `channels:read`
- `chat:write`
- `files:read`
- `files:write`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `im:write`
- `mpim:history`
- `mpim:read`
- `reactions:read`
- `reactions:write`
- `team:read`
- `users:read`

订阅 bot events：

- `app_mention`
- `app_uninstalled`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`
- `tokens_revoked`

manifest 同时启用可写的 App Home Messages 标签页。修改 Agent 的 `receiveMode` 只更新 OpenTag 本地准入策略；不会修改
manifest、轮换 installation 凭证代际、要求重新安装或授权、重试 Request URL，也不会发送测试消息。`assistant:write`
不属于 V1 能力契约；以后最多作为可选附加能力考虑，不得加入当前安装。

当其他会话与当前任务相关时，即使用户没有点名该会话，Agent 也可以发现、读取和写入它。任务需要访问时，Agent 可以一次性
加入公开频道，但不得漫游、批量加入或检查与任务无关的会话。加入后，该频道未来消息会按设计进入 OpenTag 正常入口：所有
准入的入站消息先持久化，再由 `mention_only` 或 `all_message` 控制投递。私有频道与 MPIM 仍必须由人邀请。Agent 可以发现
已有 DM 与 MPIM，但 `conversations.open` 仅允许传一个 user ID 来打开一对一 DM；V1 不承诺新建 MPIM。

面向另行注册的测试 Team/App 的无凭证本地 live 验收清单见
[slack-live-acceptance.md](./slack-live-acceptance.md)。

## Agent 配置流程

1. 打开 **Add OpenTag to Slack** 或 **Reauthorize Slack**。OpenTag 发起一等 OAuth。阅读页面不写入数据。
2. 在目标 Slack 工作区批准 OpenTag Slack App。
3. 公开 callback 用 Slack code 换 token，检查 Bot 身份、Team、存在时的 Enterprise，以及实际 `x-oauth-scopes`，并要求完整
   十八项固定 bot scopes。若 Slack 返回 App ID，也必须与一等 OpenTag App 相同。
4. OpenTag 锁定 Agent 当前 route，重新核验 Team 权限与预期 route 代际，再按 Slack installation 原子执行提交意图。
   **Create** 会安装 Slack installation 并把该 Agent 设为 default route。**Reauthorize** 必须保持当前 App、Team、Bot
   User，即使 `auth.test` 不返回 `app_id`。Slack 没有 Change App 或 replace 意图；若 Agent 要离开 Slack，断开当前 route。
   随后原子写入 installation 身份、加密凭证、完整授权和新代际。验证失败、身份漂移或预期代际过期时，当前 installation
   不变。
5. 写入成功后，Slack 的共享 Events Request URL 已在一等 App 上配置完成。真实测试消息不属于配置验收步骤。

Slack 不保证 Bot Token 的 `auth.test` 一定返回 `app_id`。因此，OAuth 写入的 App ID 会以**配置证据**存储和投影，而不是冒充
Slack API 已证明身份。每次请求仍有独立证明边界。Agent 专属 Request URL 只按 Agent 的 Slack route 定位 workspace
installation，并在解析 JSON **之前**对原始请求体验证带时间戳的 HMAC。兼容 Events URL 只能有界预解析 App 与 Team 标识以
定位 installation Signing Secret，然后再验证同一原始请求体 HMAC。签名通过后，每个真实事件 envelope 的 `api_app_id` 与
`team_id` 必须分别匹配 installation App ID 和 token 推导的 Team ID；普通消息事件的 `authorizations` 还必须包含该 Team 下
token 推导 Bot User 对应的 bot authorization。这会在精确 installation 代际上闭合“HMAC 已认证 App”与“token 推导 Bot”
身份。在闭合前，配置已经持久提交，但 readiness 与 runtime credential grant 都失败关闭。不匹配就拒绝，且绝不借事件修复配置。Slack 的 app-level
[`tokens_revoked`](https://docs.slack.dev/reference/events/tokens_revoked/) 与
[`app_uninstalled`](https://docs.slack.dev/reference/events/app_uninstalled/) envelope 不提供匹配 bot authorization 上下文，
因此它们会在 HMAC 加 App/Team 精确校验后、身份闭合前处理。Slack 官方 URL-verification payload 不含 App、Team 或 bot
authorization 字段，因此 Agent 专属 URL 对 challenge 只能验证该绑定的 Signing Secret；它不会记录身份闭合。

## 数据与状态清单

| 项目 | 处理 | 权威来源与含义 |
| --- | --- | --- |
| 绑定 `id`、Agent、Team、provider、status | 作为 Agent route 保留 | 每个 Agent 最多一个未禁用的当前 IM 绑定。Slack 行是指向该 Agent installation 的 route（`slackInstallationId`、`slackRouteKind`），绝不存储 Bot Token 或 Signing Secret。 |
| Slack Team installation | 保留 | 每个 App/Team 组合一组当前 App/Team/Bot 身份、owner Agent、加密凭证、授权、代际以及身份闭合/生命周期。 |
| App、Team、Enterprise、Bot User/Bot 身份 | 保留 | App ID 是显式配置证据；Team 与 bot 身份来自 token 检查；Enterprise 可为空。 |
| Team 与 Bot 展示元数据 | 作为可选展示数据保留 | Team 名称、Bot 展示名称和头像可显示在管理视图中，但绝不参与配置、入口或 runtime 授权。 |
| Bot Token 与 Signing Secret | 加密保留在 installation | 一起存入 installation credential envelope；绝不复制到多个 Agent route，管理、诊断、runtime-config API 都不返回。Signing Secret 永不投影给 runtime。 |
| `credentialGeneration` 与 credential schema version | 保留在 installation | installation 为权威的单调凭证修订；route 只同步脱敏快照，供 Session fencing 与诊断使用。同身份重新授权递增 installation 代际。Slack 没有 replace-App 切换。 |
| `grantedCapabilities` | 保留在 installation | Slack 实际返回的 token scopes。route 同步脱敏快照。active/ready 投影要求完整十八项固定 scopes。 |
| `activatedAt`、`disabledAt`、`createdAt`、`updatedAt` | 保留 | 持久 installation 生命周期时间，Slack route 上保留脱敏副本。配置提交设置激活，入站事件不设置。公共 API 将 `activatedAt` 投影为 `lastValidatedAt`。 |
| `observedAt` | 仅作运行观测保留 | installation 为权威。正确签名的 Agent 专属 URL challenge，或正确签名且 App、Team、bot authorization 都匹配的真实事件会更新。route 同步脱敏时间戳。公共 API 将其投影为 `lastRuntimeObservationAt`。不是配置证据，也不改变代际。 |
| `observedConnectedAt` | 作为代际身份闭合保留 | installation 为权威。对 Slack，记录签名真实事件的 `authorizations` 首次把配置 App/Team 与当前 installation 代际 token 推导 Bot User 闭合的时间；后续匹配事件保留该首次时间，仅刷新 `observedAt`。每次配置会重置，URL verification 永不设置。Feishu 继续使用其原有连接观测含义。 |
| `lastInboundAt` 与标准化 `ImMessage`/Session 状态 | 保留 | 消息运行历史和路由状态；只有准入后的真实消息更新，URL verification 不更新。 |
| `lastConfirmedAt` | 从公共 API 删除 | 它把配置时间与运行观测混在一起。改用 `lastValidatedAt` 与 `lastRuntimeObservationAt`。 |
| `lastErrorCode` | 保留 | 持久恢复原因，例如 `SLACK_SCOPE_REAUTH_REQUIRED`、`SLACK_TOKEN_REVOKED`；运行观测不清除配置错误。 |
| Agent 上的 `receiveMode` | 保留 | 本地 `mention_only`/`all_message` 策略，与 Slack 授权和凭证代际无关。 |
| `replacementImBindingId` | 作为切换溯源保留 | Feishu Bot 身份变化时，将已禁用绑定指向原子创建的 replacement；它不是 setup 进度。Slack 不再有 replace-App 切换。 |
| connection owner、lease 与 fencing 字段 | 通用保留 | 仅 Feishu 使用连接所有权；Slack 没有受管连接 lease，这些字段保持为空。 |
| 通用 setup attempt/context 字段 | 为 Feishu 保留 | setup attempt ID、意图/状态/owner/heartbeat/expiry 与加密 setup context 继续服务 Feishu；Slack 行由数据库检查约束保证这些 setup 字段为空。 |
| Slack setup attempt、加密临时 context、challenge proof、验证错误/时间、轮询/过期/取消状态 | 删除 | token 验证与激活之间不再存在 Slack 配置阶段。 |
| `pendingReceiveMode` / `pending_receive_mode` | 删除 | 不再存在依赖 Slack 的接收模式目标。 |

以下值只做派生，不新增持久状态：

- binding health 由 status 以及当前可读、schema 合法、身份一致且 scopes 完整的凭证材料派生；
- 不可读、schema 非法、身份不一致或 scopes 不一致的当前凭证必须失败关闭：不得投影为 ready，Slack ingress 查找返回不可用而不是抛出原始凭证错误；
- `reauthorizationRequired` 由绑定状态、缺少固定 scopes 或当前凭证材料无效派生；
- Slack `identityClosure` 根据当前代际的 `observedConnectedAt` 派生为 `pending` 或 `verified`；pending 会让 `ready`、
  `handoffReady` 为 false，并拒绝 runtime Bot Token grant，但不会把已提交凭证误标为无效；
- 诊断返回精确的 `credentialGeneration`（包括 `0`）、`credentialStatus` 的 `valid` 或 `invalid`，以及 required/granted/missing capabilities；
- 结构无效且没有更具体持久错误的凭证投影 `IM_BINDING_CREDENTIAL_INVALID`；真正缺少固定 scopes 时仍投影
  `SLACK_SCOPE_REAUTH_REQUIRED`；
- `lastValidatedAt` 是当前凭证验证/激活时间；`lastRuntimeObservationAt` 是最近一次已签名的 provider 运行观测；`lastInboundAt` 仍是消息历史；
- App ID evidence 始终标记为 `configured`，并明确要求签名入口匹配。

### 持久状态与派生状态矩阵

| 状态 | 迁移后的 Slack 含义 | 允许的转换来源 |
| --- | --- | --- |
| `provisioning` | 不再是 Slack 正常状态；不完整 legacy Slack 行由迁移禁用，新配置直接写入 `active`。 | 仅 Feishu setup。 |
| `active` | 已提交一个凭证代际。Slack 在当前代际收到匹配签名事件、闭合 App/Team/Bot 身份前仍不 ready。若当前材料不可读、结构不一致或缺少固定 scope，公共状态仍会派生为 `reauthorization_required`。 | 成功的已验证配置或同身份重新授权。 |
| `reauthorization_required` | 当前安装必须重新授权；scope 契约或凭证检查失败时，绝不把既有材料报告为健康。 | scope 迁移、`tokens_revoked` 或显式恢复写入。 |
| `error` | 为非 Slack setup/runtime 失败保留的通用状态；Slack 配置验证错误直接返回，不修改当前行。 | 非 Slack provider 工作流或既有通用恢复代码。 |
| `disabled` | 该 installation 身份的终态，或一条 Agent route 的终态。禁用 installation 会清除其 active credential、禁用全部 route 并结束那些 Sessions。禁用一条 route 不会卸载 Slack installation。 | 显式禁用、`app_uninstalled` 或不完整 Slack 清理。 |

`bindingState`、`ready`、`handoffReady`、`reauthorizationRequired`、`credentialStatus` 与 missing capabilities
都是投影，不是额外 binding 状态。URL verification 只更新运行观测；匹配的签名真实事件还可在消息/路由工作前设置当前
installation 代际身份闭合时间。`receiveMode` 只改变 Agent 策略。同身份凭证提交递增 installation 的 `credentialGeneration`
并同步脱敏快照到 route。

## 入口、事件与错误

生成的 Agent 专属 Request URL 与兼容 Slack Events URL 都先按 Agent route 或 App+Team 定位 Slack installation，再只接受已经
active、scopes 完整、且当前凭证材料可读且有效的安装。Agent 专属 URL 在解析 JSON 之前验证原始请求体签名。兼容 URL 只能有界
预解析 App/Team 以查找 secret。随后两者都要求真实事件的 App ID 与 Team ID 匹配，才记录 installation 观测或处理事件。生命周期
事件与代际栅栏作用于 installation。普通消息只有在唯一显式 default Agent route 解析成功后才投递；未配置、歧义、跨 workspace
或指向已删除 Agent 的 default 只确认、不投递。只有 Agent 专属 URL 能路由 Slack 不带身份字段的 URL challenge。Signing Secret
永不进入 runtime grant、诊断、日志或 traces。

- `url_verification`：在 Agent 专属 URL 上验证绑定 Signing Secret、返回 challenge 并记录运行观测；Slack payload 不含
  App/Team 身份，而且请求不激活、不轮换、不修复任何配置。
- 普通真实 `event_callback` 消息：要求 `authorizations` 中存在匹配 bot 项，再按解析时的精确凭证代际在 installation 上记录
  身份闭合与运行观测；过期代际只返回确认，不产生副作用。
- `app_mention` 与 message events：唯一 default route 解析成功后，在该 installation 代际下标准化并入站；不改变代际。
- `tokens_revoked`：签名与 App/Team 精确校验后，不要求 `authorizations`，而是使用官方 payload 中被撤销的 Bot User
  列表；只把该精确 installation 代际置为 `reauthorization_required`，错误为 `SLACK_TOKEN_REVOKED`。
- `app_uninstalled`：签名与 App/Team 精确校验后，不要求 bot authorization，直接接受 app-level 卸载信号；只禁用该
  精确 installation 代际并清除 active credential material。
- lifecycle 事件不建立身份闭合，也不刷新运行观测。缺少 active installation、签名无效、App/Team 不匹配，或普通事件的
  authorization 不匹配时，直接拒绝且不记录观测或其他副作用；绝不把任何事件视为 setup 进度。

配置错误必须显式返回，且不改变现有 active 数据：

- `SLACK_AUTH_INVALID`：Slack 拒绝 Bot Token。
- `SLACK_AUTH_IDENTITY_INCOMPLETE`：Slack 接受了提交 token，但未返回已安装 Bot 身份（例如提交了 User Token）；这是
  确定性的 400 credential 输入错误。
- `SLACK_UPSTREAM_UNAVAILABLE`：token 检查未返回可用安装事实。
- `SLACK_BINDING_IDENTITY_MISMATCH`：Slack 返回的 App ID 与配置值不同。
- `SLACK_SCOPE_REAUTH_REQUIRED`：token 缺少至少一个固定 scope。
- `SLACK_CONFIGURATION_CONFLICT`：授权开始后 route、installation 或代际发生变化。
- `SLACK_OAUTH_FAILED`：一等 Slack OAuth state 无效、过期、被重放，或用户取消了授权。
- `SLACK_APP_TEAM_ALREADY_BOUND`：该 App/Team 安装已被另一个 OpenTag Agent 当前占用。

## 迁移与恢复

更早的 Slack-only 清理仍然有效：清空 setup-attempt 字段、清空历史 Slack `observedConnectedAt`、禁用不完整 provisioning
行、把缺 scope 的已配置行标为 `reauthorization_required`、把已具备完整固定 scopes 的 legacy 重授权行恢复 active、删除
`pending_receive_mode`，并保持 Feishu setup 字段不变。

随后的 Agent-installation cutover：

- 把 Bot Token 与 Signing Secret 从当前 Slack route 搬到一份由 Agent 拥有的 installation，绝不把 secret 复制到多个
  Agent 行；
- 优先选择该 owning Agent 下结构完整且 `status=active` 的候选；只有没有 active 时才选择结构完整的 `reauthorization_required` 行，再按
  `created_at` 与 `id` 稳定排序；
- 被选中的行成为 default route；任何重复的当前 Slack App/Team installation 都 fail closed；
- 单 Agent Slack 数据保持无损。

重新授权会先验证新凭证，并核对锁定的当前 App/Team/Bot 身份，再接触当前 installation。因此，当 `auth.test` 不返回
`app_id` 时，App ID 不匹配也不能变成隐式 replacement。同身份成功时原子推进 installation 代际，并同步脱敏快照到 route。Slack
没有 Change App 或 replace 意图；断开连接会结束该 Agent route 的 Sessions，但不会卸载 Slack installation。并发
配置同时受预期 route ID/generation 与数据库唯一约束保护；运行观测、身份闭合、provider 撤销与 provider 禁用还分别受事件
解析时精确 installation credential generation 的栅栏保护。

## 一等分布式 OpenTag Slack App

当 Server 配置了一等 Slack App 凭据后，Agent 管理发起 OAuth。Slack 中可见的 Bot 就是这一个 OpenTag App；OpenTag 内部
subagent 不会再安装为额外的 Slack Bot。

必需的 Server 环境变量，要么全部配置，要么全部不配：

- `OPENTAG_SLACK_CLIENT_ID`
- `OPENTAG_SLACK_CLIENT_SECRET`
- `OPENTAG_SLACK_SIGNING_SECRET`
- `OPENTAG_SLACK_REDIRECT_URL` — 本 Server 的 public origin，或精确 callback URL
  `{OPENTAG_PUBLIC_URL}/api/v1/im-bindings/slack/oauth/callback`

托管环境要求 HTTPS。缺一项会在进程启动时失败关闭。callback origin 必须与 `OPENTAG_PUBLIC_URL` 一致。Client secret、
signing secret、OAuth code 与 token 都不会出现在管理 API 响应或日志中。带签名的 OAuth state 只会出现在 start endpoint
返回的短期 Slack 授权 URL 中，并会在 callback 的 Server 请求日志中被移除。

已认证的 start `POST /api/v1/agents/:agentId/im-binding/slack/oauth/start` 仍是选择 default Agent route 的管理入口。它会签发
带签名的 state，其中包含一次性 nonce，并绑定浏览器 session cookie、Account、Agent、意图（`create` / `reauthorize`）以及
预期 binding generation。公开 callback 用 Slack code 换 token，检查 Bot 身份与实际 `x-oauth-scopes`，只有在十八项固定 bot
scopes 与身份检查都通过后，才写入该 Agent 所有的 installation 以及该 Agent 的显式 default route。同一安装重新授权会递增凭证代际。
Slack replace 不是合法 OAuth 意图。重放、过期、session 不匹配，以及不同 Agent 声称同一当前 App/Team 安装时，
都不会改写当前 installation。

可版本控制的 Public Distribution manifest 见
[slack-public-distribution-manifest.yaml](../slack-public-distribution-manifest.yaml)。复制到 Slack App manifest 编辑器后，
只替换 `https://YOUR_OPENTAG_ORIGIN` 这个 origin。不要增加 scopes、App ID 或 secrets。Logo asset 由仓库 root 后续添加，
不属于本模板。

运营人员必须把 OpenTag Slack App 配置为：

- Bot 展示名 **OpenTag**
- Redirect URL 等于 `OPENTAG_SLACK_REDIRECT_URL`
- Events Request URL 为 `{OPENTAG_PUBLIC_URL}/api/v1/im-bindings/slack/events`（带签名 HTTP，而不是 Socket Mode）
- 与已入库 Public Distribution manifest 相同的十八项 bot scopes 与订阅 bot events，包括 `app_uninstalled` 与
  `tokens_revoked`

该共享 Request URL 的无身份 URL verification 使用一等 signing secret，且不记录 installation 观测。安装之后，真实事件按
active App/Team installation 查找，并用已存储的 signing secret 校验 HMAC。未启用 token rotation；若要在 active installation
凭证信封之外轮换 token，需要以后由适配器持有的 store。

一个分布式 App installation 只产生一组归一个 Agent 所有的 Team/Bot 身份。V1 入站只使用该 Agent 的唯一 default route，
绝不广播。Bot Token 只投影给 owner Agent。Signing Secret 只加密保存在 installation 上，永不投影给 runtime。

Slack 协议参考：[App manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)、
[`auth.test`](https://docs.slack.dev/reference/methods/auth.test/)、
[OAuth V2](https://docs.slack.dev/authentication/installing-with-oauth/)、
[请求签名](https://docs.slack.dev/authentication/verifying-requests-from-slack/) 与
[`url_verification`](https://docs.slack.dev/reference/events/url_verification/)。
