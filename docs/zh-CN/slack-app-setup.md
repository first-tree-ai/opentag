# Slack App 配置

[English](../slack-app-setup.md)

OpenTag 为每个 Agent 支持一个由客户持有的 Slack App 安装。配置是一次经过验证的写入，不是临时 setup 工作流。
URL verification 与真实入站消息只属于运行观测；两者都不能创建、完成或激活凭证代际。

## 固定的 Slack 能力契约

首次连接以及后续重新授权、替换时，生成的 manifest 始终请求完整能力集。`mention_only` 与 `all_message` 共用同一份
Slack 安装。

必需 bot scopes：

- `app_mentions:read`
- `channels:history`
- `chat:write`
- `files:read`
- `groups:history`
- `im:history`
- `mpim:history`

订阅 bot events：

- `app_mention`
- `app_uninstalled`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`
- `tokens_revoked`

manifest 同时启用可写的 App Home Messages 标签页。修改 Agent 的 `receiveMode` 只更新 OpenTag 本地准入策略；不会修改
manifest、轮换凭证代际、要求重新安装或授权、重试 Request URL，也不会发送测试消息。

## 管理员配置流程

1. 打开 **Connect Slack App**、**Reauthorize Slack** 或 **Change Slack App**。OpenTag 返回无状态指南，其中包含固定 manifest
   与 Agent 专属 Events API Request URL。读取或关闭指南都不写入数据。
2. 用完整 manifest 创建或更新客户持有的 App，并安装或重新安装到目标 Slack 工作区。
3. 从 **Basic Information** 复制 **App ID** 和 **Signing Secret**，从 **OAuth & Permissions** 复制
   **Bot User OAuth Token**。
4. 一次提交三个值。OpenTag 调用 Slack `auth.test`，获取 token 对应的 Team、Bot User、Bot 身份、存在时的 Enterprise，
   以及实际 `x-oauth-scopes`，并要求完整七项 scopes。若 Slack 返回 App ID，也必须与提交值相同。
5. OpenTag 锁定 Agent 当前绑定，重新核验 Team 权限与预期绑定代际，再原子写入激活身份、加密凭证、完整授权和新代际。
   同时强制执行提交的意图：**Reauthorize** 必须保持当前 App、Team、Bot User，即使 `auth.test` 不返回 `app_id`；只有
   **Change Slack App** 才能替换绑定并结束其 Sessions。验证失败、身份漂移或预期代际过期时，当前绑定不变。
6. 写入成功后，如有需要，再到 Slack 设置或重试生成的 Request URL。真实测试消息不属于配置验收步骤。PUT 返回的是该事务
   精确提交代际的脱敏快照，不会在事务外再次读取可变 Agent 状态。

Slack 不保证 Bot Token 的 `auth.test` 一定返回 `app_id`。因此，提交的 App ID 会以**配置证据**存储和投影，而不是冒充
Slack API 已证明身份。每次请求仍有独立证明边界。Agent 专属 Request URL 按 Agent ID 查找 active 绑定，并在解析 JSON
**之前**对原始请求体验证带时间戳的 HMAC。兼容 Events URL 只能有界预解析 App 与 Team 标识以定位 Signing Secret，然后再
验证同一原始请求体 HMAC。签名通过后，每个真实事件 envelope 的 `api_app_id` 与 `team_id` 必须分别匹配配置 App ID 和
token 推导的 Team ID；普通消息事件的 `authorizations` 还必须包含该 Team 下 token 推导 Bot User 对应的 bot
authorization。这会在精确凭证代际上闭合“HMAC 已认证 App”与“token 推导 Bot”身份。在闭合前，配置已经持久提交，但
readiness 与 runtime credential grant 都失败关闭。不匹配就拒绝，且绝不借事件修复配置。Slack 的 app-level
[`tokens_revoked`](https://docs.slack.dev/reference/events/tokens_revoked/) 与
[`app_uninstalled`](https://docs.slack.dev/reference/events/app_uninstalled/) envelope 不提供匹配 bot authorization 上下文，
因此它们会在 HMAC 加 App/Team 精确校验后、身份闭合前处理。Slack 官方 URL-verification payload 不含 App、Team 或 bot
authorization 字段，因此 Agent 专属 URL 对 challenge 只能验证该绑定的 Signing Secret；它不会记录身份闭合。

## 数据与状态清单

| 项目 | 处理 | 权威来源与含义 |
| --- | --- | --- |
| 绑定 `id`、Agent、Team、provider、status | 保留 | 每个 Agent 最多一个未禁用的当前 IM 绑定；每个 Slack App/Team 安装最多一个当前 Agent 绑定。 |
| App、Team、Enterprise、Bot User/Bot 身份 | 保留 | App ID 是显式配置证据；Team 与 bot 身份来自 token 检查；Enterprise 可为空。 |
| Team 与 Bot 展示元数据 | 作为可选展示数据保留 | Team 名称、Bot 展示名称和头像可显示给管理员，但绝不参与配置、入口或 runtime 授权。 |
| Bot Token 与 Signing Secret | 加密保留 | 一起存入 active credential envelope；管理员、诊断、runtime-config API 都不返回。Signing Secret 永不投影给 runtime。 |
| `credentialGeneration` 与 credential schema version | 保留 | 同一绑定的单调凭证修订；同身份重新授权递增，App/Team 替换则创建新绑定身份并禁用旧绑定。 |
| `grantedCapabilities` | 保留 | Slack 实际返回的 token scopes。active/ready 投影要求完整七项。 |
| `activatedAt`、`disabledAt`、`createdAt`、`updatedAt` | 保留 | 持久绑定生命周期时间；配置提交设置激活，入站事件不设置。公共 API 将 `activatedAt` 投影为 `lastValidatedAt`。 |
| `observedAt` | 仅作运行观测保留 | 正确签名的 Agent 专属 URL challenge，或正确签名且 App、Team、bot authorization 都匹配的真实事件会更新。公共 API 将其投影为 `lastRuntimeObservationAt`。不是配置证据，也不改变代际。 |
| `observedConnectedAt` | 作为代际身份闭合保留 | 对 Slack，记录签名真实事件的 `authorizations` 首次把配置 App/Team 与当前代际 token 推导 Bot User 闭合的时间；后续匹配事件保留该首次时间，仅刷新 `observedAt`。每次配置会重置，URL verification 永不设置。Feishu 继续使用其原有连接观测含义。 |
| `lastInboundAt` 与标准化 `ImMessage`/Session 状态 | 保留 | 消息运行历史和路由状态；只有准入后的真实消息更新，URL verification 不更新。 |
| `lastConfirmedAt` | 从公共 API 删除 | 它把配置时间与运行观测混在一起。改用 `lastValidatedAt` 与 `lastRuntimeObservationAt`。 |
| `lastErrorCode` | 保留 | 持久恢复原因，例如 `SLACK_SCOPE_REAUTH_REQUIRED`、`SLACK_TOKEN_REVOKED`；运行观测不清除配置错误。 |
| Agent 上的 `receiveMode` | 保留 | 本地 `mention_only`/`all_message` 策略，与 Slack 授权和凭证代际无关。 |
| `replacementImBindingId` | 作为切换溯源保留 | App/Team 身份变化时，将已禁用绑定指向原子创建的 replacement；它不是 setup 进度，Slack 与 Feishu replacement 流程都会使用。 |
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
| `reauthorization_required` | 当前安装必须替换或重新授权；scope 契约或凭证检查失败时，绝不把既有材料报告为健康。 | scope 迁移、`tokens_revoked` 或显式恢复写入。 |
| `error` | 为非 Slack setup/runtime 失败保留的通用状态；Slack 配置验证错误直接返回，不修改当前行。 | 非 Slack provider 工作流或既有通用恢复代码。 |
| `disabled` | 该绑定身份的终态；active credential 与 setup secret 被清除，Sessions 结束，后续配置会创建或选择另一个当前绑定。 | 管理员禁用、`app_uninstalled`、不完整 legacy Slack 清理或身份替换切换。 |

`bindingState`、`ready`、`handoffReady`、`reauthorizationRequired`、`credentialStatus` 与 missing capabilities
都是投影，不是额外 binding 状态。URL verification 只更新运行观测；匹配的签名真实事件还可在消息/路由工作前设置当前代际
身份闭合时间。`receiveMode` 只改变 Agent 策略。同身份凭证提交递增 `credentialGeneration`；App/Team 身份替换在新绑定上从 generation `1` 开始，并在已
禁用旧绑定上记录 replacement link。

## 入口、事件与错误

生成的 Agent 专属 Request URL 与兼容 Slack Events URL 都只接受已经 active、scopes 完整、且当前凭证材料可读且有效的绑定。
Agent 专属 URL 在解析 JSON 之前验证原始请求体签名。兼容 URL 只能有界预解析 App/Team 以查找 secret。随后两者都要求真实
事件的 App ID 与 Team ID 匹配，才记录 `observedAt` 或处理事件。只有 Agent 专属 URL 能路由 Slack 不带身份字段的 URL
challenge。Signing Secret 永不进入 runtime grant、诊断、日志或 traces。

- `url_verification`：在 Agent 专属 URL 上验证绑定 Signing Secret、返回 challenge 并记录运行观测；Slack payload 不含
  App/Team 身份，而且请求不激活、不轮换、不修复任何配置。
- 普通真实 `event_callback` 消息：要求 `authorizations` 中存在匹配 bot 项，再按解析时的精确凭证代际记录身份闭合与
  运行观测；过期代际只返回确认，不产生副作用。
- `app_mention` 与 message events：在该精确代际下标准化并入站；不改变代际。
- `tokens_revoked`：签名与 App/Team 精确校验后，不要求 `authorizations`，而是使用官方 payload 中被撤销的 Bot User
  列表；只把该精确代际置为 `reauthorization_required`，错误为 `SLACK_TOKEN_REVOKED`。
- `app_uninstalled`：签名与 App/Team 精确校验后，不要求 bot authorization，直接接受 app-level 卸载信号；只禁用该
  精确代际并清除 active credential material。
- lifecycle 事件不建立身份闭合，也不刷新运行观测。缺少 active binding、签名无效、App/Team 不匹配，或普通事件的
  authorization 不匹配时，直接拒绝且不记录观测或其他副作用；绝不把任何事件视为 setup 进度。

配置错误必须显式返回，且不改变现有 active 数据：

- `SLACK_AUTH_INVALID`：Slack 拒绝 Bot Token。
- `SLACK_AUTH_IDENTITY_INCOMPLETE`：Slack 接受了提交 token，但未返回已安装 Bot 身份（例如提交了 User Token）；这是
  确定性的 400 credential 输入错误。
- `SLACK_UPSTREAM_UNAVAILABLE`：token 检查未返回可用安装事实。
- `SLACK_BINDING_IDENTITY_MISMATCH`：Slack 返回的 App ID 与配置值不同。
- `SLACK_SCOPE_REAUTH_REQUIRED`：token 缺少至少一个固定 scope。
- `SLACK_CONFIGURATION_CONFLICT`：打开表单后绑定或代际发生变化。
- `SLACK_APP_TEAM_ALREADY_BOUND`：该 App/Team 安装已被另一个 Agent 当前绑定。

## 迁移与恢复

迁移只对 Slack 行执行以下处理：

- 清空全部 Slack setup-attempt 与加密 setup-context 字段；
- 清空 Slack `observedConnectedAt`，防止任何历史通用值冒充新的当前代际 App/Bot 身份闭合；Feishu 连接观测保持不变；
- 对从未拥有 active credential generation 的不完整 Slack provisioning 行，清除凭证与连接所有权、禁用，并记录
  `SLACK_CONFIGURATION_REQUIRED`；
- 缺少七项 scopes 中任何一项的既有已配置绑定进入 `reauthorization_required`，绝不投影为健康；
- legacy 仅因 scopes 标记需要重授权、但已实际具备完整固定 scopes 的行恢复 active；
- 删除 `pending_receive_mode`；
- 增加仅针对 Slack 的数据库检查，保证通用 setup 字段保持为空；
- 不改变 Feishu setup 字段和行为。

重新授权会先验证新凭证，并核对锁定的当前 App/Team/Bot 身份，再接触当前绑定。因此，当 `auth.test` 不返回 `app_id` 时，
App ID typo 也不能变成隐式 replacement。同身份成功时原子推进代际；只有显式 Change App 意图才能在 cutover 时创建
replacement、禁用旧绑定并停止旧绑定 Sessions。并发配置同时受预期 binding ID/generation 与数据库唯一约束保护；运行
观测、身份闭合、provider 撤销与 provider 禁用还分别受事件解析时精确 credential generation 的栅栏保护。

## 未来的分布式 App 适配器

当前产品模式是每个 Agent 一个由客户持有的 Slack App。以后若引入 OpenTag 托管的分布式 App，它必须作为同一 verified
Integration 激活边界后的独立适配器。该适配器目前只存在于文档：本版本不增加 OAuth setup 状态、占位表或 token 交换持久化。

若引入该适配器，OAuth state 必须签名，并绑定一次性 nonce、浏览器 session、Admin、Agent、Team 与配置意图。installation
store 与 token rotation 属于该适配器，不属于 active binding。实际 Slack 返回的 scopes 仍然决定能否激活。在此之前，管理
员一次提交 App ID、Bot Token 与 Signing Secret。

一个分布式 App 安装只产生一组 Team/Bot 身份。因此，若同一 Slack workspace 需要支持多个 OpenTag Agent，必须引入独立的
workspace-installation aggregate 与显式 Agent 路由；不能静默复用当前 App/Team 到 Agent 的唯一绑定约束。

Slack 协议参考：[App manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)、
[`auth.test`](https://docs.slack.dev/reference/methods/auth.test/)、
[请求签名](https://docs.slack.dev/authentication/verifying-requests-from-slack/) 与
[`url_verification`](https://docs.slack.dev/reference/events/url_verification/)。
