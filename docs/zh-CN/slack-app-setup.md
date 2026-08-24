# Slack App 接入

[English](../slack-app-setup.md)

OpenTag 为每个 Agent 接入一个由客户持有的 Slack App。本流程不支持多个 Agent 共用 OpenTag 托管的 App：即使多个
Agent 加入同一个 Slack 工作区或频道，每个 Agent 仍保持独立的机器人身份、凭证代际、消息边界和恢复生命周期。

## 产品契约

一个 Agent 最多只有一个当前 IM 绑定。Slack setup attempt 必须声明一个明确意图：

- `create` 创建首个 Slack 绑定。
- `reauthorize` 为当前 App、Team 和 Bot User 身份轮换凭证或补充 scopes。在新凭证通过验证之前，当前绑定继续可用。
- `replace` 切换到另一个 Slack App 安装。激活时结束由旧绑定持有的会话。

OpenTag 为 Agent 生成专属的 Slack App manifest 和 Events API Request URL。manifest 只请求 Agent 当前接收模式或
Server 已记录的待生效接收模式所需的 bot scopes 和事件；同时启用可写的 App Home Messages 标签页，让用户可以发起
与 Agent 的私聊。

## 管理员流程

1. 在 Agent 的 **IM** 页面选择 **Connect Slack App**、**Reauthorize Slack** 或 **Replace Slack App**。处于 provisioning
   的绑定（例如刷新页面前已经开始的 setup）会改为显示 **Resume Slack setup**。仅打开或刷新页面绝不会调用会改变状态的 setup
   endpoint；管理员必须显式选择 **Resume Slack setup**。如果 attempt 仍在进行中则返回原 attempt，只有旧 attempt 已进入终态时
   才创建后继 attempt。
2. 按所选意图准备 App。OpenTag 同时以「创建新 App 链接」和「可复制的 JSON」两种形式展示生成的 manifest：
   - **Connect** 与 **Replace** 从 manifest 创建一个专属的新 App，并安装到目标工作区。
   - **Reauthorize** 保持同一个 App、工作区和 bot user：打开现有 App 的 **App Manifest** 页面，用生成的 JSON 替换 manifest
     并保存，然后在 **OAuth & Permissions** 中选择 **Reinstall to Workspace**，让 Slack 授予新增的 scopes。重新安装后
     Bot User OAuth Token 可能改变，Signing Secret 通常不变。整个过程中现有绑定持续接收消息。
3. 从 **OAuth & Permissions** 复制 **Bot User OAuth Token**，从 **Basic Information** 复制 **Signing Secret**，
   提交给 OpenTag。
4. OpenTag 调用 Slack `auth.test`，推导 Team ID、存在时的 Enterprise ID、Bot User ID、Bot ID，以及 token 实际返回的
   `x-oauth-scopes`。Slack 对有效 bot token 的 `auth.test` 可能省略 `app_id`，因此「已验证安装」面板以工作区和 bot user
   标识安装，只有在 App ID 已知后才显示它；浏览器提交的 App ID 或 scopes 列表从不作为权威事实。该调用带超时限制，
   Slack 无响应时报告为 `SLACK_UPSTREAM_UNAVAILABLE`。
5. 回到 **Event Subscriptions**，重试生成的 Request URL。OpenTag 先验证 Slack 带时间戳的 HMAC 签名，再返回
   URL verification challenge。IM 页面区分两种证明：`auth.test` 成功后 Bot Token 即视为已验证（显示推导出的 App、工作区
   和 bot user），而 Signing Secret 在 Slack 的 URL 验证成功之前保持未验证状态。
6. 将机器人邀请到测试频道并 @mention。OpenTag 会重新解析已通过签名验证的原始事件；只有 envelope 的 App、Team
   分别匹配路由 App 与 token 推导的 Team，且其中一项 bot authorization 匹配 token 推导的 Team 与 Bot User 时，
   才从 `api_app_id` 建立 App ID 并激活绑定。如果 `auth.test` 确实返回了 App ID，它也必须一致。该事件随后通过
   已激活绑定进入系统。

Slack 可能在 manifest 创建后立即尝试 URL 验证，此时 OpenTag 尚未拿到 Signing Secret，首次失败属于预期行为；提交凭证后
重新验证即可。

Slack 只在 Request URL 被设置或修改、或管理员在 **Event Subscriptions** 中点击 **Retry** 时才发送 `url_verification`。
通过 `apps.manifest.update` 更新事件订阅不会触发它，OpenTag 也无法代替管理员触发：点击 **Retry** 是受支持的步骤。在此之前，
attempt 会一直显示「Signing Secret not yet verified」。重新授权的事件继续通过当前激活绑定；首次接入且没有激活绑定时，
正确签名的事件会以 `200`（pending）确认，但不会激活或写入消息。

### 恢复进行中的 attempt

- 错误的 Signing Secret 不会让 attempt 失败。失败的 URL 验证会作为非机密诊断记录在 attempt 上
  （`SLACK_SIGNING_SECRET_INVALID` 及其时间），IM 页面会显示。选择 **Edit credentials** 向同一个 attempt 提交修正后的
  token 和 secret：OpenTag 重新调用 `auth.test`，原子替换两个 secret，并重新开始 URL 验证。提交的 secret 永不回显。
- **Cancel setup** 可随时结束一个 attempt，且取消状态会跨导航和刷新保持；只有显式选择 **Resume Slack setup** 或重试操作才会
  创建后继 attempt。attempt 活动期间不能开始另一种意图（`SLACK_SETUP_INTENT_CONFLICT`），需要先取消当前的。再次开始相同意图
  会返回进行中的 attempt。
- attempt 在开始 30 分钟后过期。截止后提交的凭证或收到的 URL 验证都以 `SLACK_SETUP_EXPIRED` 拒绝，不会写入已失效的
  attempt。
- URL 验证写入会比较其实际验证的精确加密凭证/证明快照。同一 attempt 并发替换凭证时，旧 challenge 以
  `SLACK_SETUP_CONFLICT` 失败，不能恢复先前的 token 或 Signing Secret。
- IM 页面轮询 attempt 时对瞬时失败采用指数退避，并在得到确定性答案（例如 attempt 已不存在）时停止；**Refresh status**
  会重新开始轮询。

## 所需 bot scopes 与事件

两种接收模式都要求：

- `app_mentions:read`
- `chat:write`
- `files:read`
- `im:history`

它们订阅 `app_mention`、`message.im`、`app_uninstalled` 和 `tokens_revoked`。

`all_message` 模式还要求 `channels:history`、`groups:history` 和 `mpim:history`，并订阅对应的
`message.channels`、`message.groups` 与 `message.mpim`。从仅 mention 切换到全量消息时，在 Slack 确认全部新增 scopes
之前，OpenTag 会在 Server 记录目标模式、失败关闭并要求重新授权。重新授权期间当前仅 mention 策略仍然有效，生成的
manifest 则请求目标 scopes；只有激活成功时才会原子应用目标模式。待生效目标以 `pendingReceiveMode` 投影到绑定摘要、
管理员详情和诊断中；真实存储的错误码（例如 `SLACK_TOKEN_REVOKED`）不会被 scope 升级提示掩盖。以相同接收模式保存不会
取消进行中的 setup attempt；改变实际目标才会取消，并记录 `SLACK_SETUP_CANCELED`。

`mention_only` 不承诺自动提供 mention 前后的频道消息。任务需要更多 provider 原生上下文时，Agent 可以通过官方
Slack CLI 主动查询；实际范围受已安装 Bot Token 的 scopes 和 conversation membership 限制。

## 安全与恢复

- Bot Token、Signing Secret 和待完成 setup context 在写入数据库前加密，管理员 API 与诊断 API 均不返回这些内容。
  Signing Secret 绝不投影到 Agent runtime。
- OpenTag 对自动持久化和投递实施 Session 隔离，但不把投影给 Runtime 的 Bot Token 收窄到当前 channel 或 thread。
  在有效且 Agent 可见的 IM Turn 中，Agent 可以在 Bot Token scopes 与 Slack membership 允许的范围内使用官方 CLI。
  查询结果只进入 runtime context，不会自动成为 OpenTag `ImMessage` 历史，也不会自动投递给另一个 Session。
- Slack 签名验证使用原始请求体、五分钟重放窗口和常量时间比较。
- URL verification challenge 能证明 Signing Secret，但不携带 App、Team 或 bot authorization 身份。因此激活必须
  等待后续签名事件，由其原始 envelope 建立 App，并将 Team 与 bot authorization 关联到 token 推导的 Team 和
  Bot User；浏览器身份从不参与该证明。
- 运行期凭证校验在后续 `auth.test` 省略 `app_id` 时保留由签名事件建立的 App ID；如果 Slack 返回了不一致的 App ID，
  或 Team、Bot User、Bot ID 发生漂移，仍会拒绝绑定。
- 一个 Slack App 安装最多只能当前绑定一个 Agent；冲突失败且不改变任一绑定。事务内检查与并发唯一索引竞争都报告
  `SLACK_APP_TEAM_ALREADY_BOUND`。
- 重新授权在新凭证代际就绪前保留当前绑定。由于 Signing Secret 通常不变，正常事件也会匹配待完成的 attempt；OpenTag
  绝不因缺少 URL 验证而拒绝它们。尚未证明 Request URL 的 attempt 会报告为等待 challenge，入口回落到当前激活绑定；
  首次接入且没有任何激活绑定时，事件以无操作的 `200` 确认（不写入任何消息），让 Slack 保持订阅。替换只在激活时创建
  新绑定身份并禁用旧绑定。
- 事件激活会锁定并重新核验当前 setup attempt 的精确 ID、活动状态、过期时间、签名、重新解析的原始 envelope，以及
  token/event 身份关联，再在同一事务中推进 credential、应用待生效接收模式并完成 setup slot。已过期、已取消或
  已替换 attempt 的旧事件不能激活。
- 当前 bot token 出现在 `tokens_revoked` 时，绑定进入需要重新授权状态。
- `app_uninstalled` 会禁用绑定。管理员可以重试过期或失败的 setup、重新授权、替换或显式禁用绑定。

Slack setup 遵循与其他 IM provider 相同的 runtime readiness 边界。已配置不等于可交接；只有 Agent runtime 和官方
Slack CLI 能力都 ready 时才可 handoff。Slack 出站发送保持 provider-native，OpenTag 不声称拥有 provider 的最终投递事实。

## 验收覆盖

支持流程必须覆盖：

- 无效 Bot Token 与 Slack API 不可用；
- 两种接收模式下的 scopes 缺失；
- 生成的 manifest 始终为私聊启用可写的 App Home Messages 标签页；
- 无效、过期或重放的 Slack 签名；
- token 推导的 Team/Bot 身份与签名事件的 App/Team/bot authorization 关联不一致；
- App/Team 安装重复绑定冲突；
- 创建、同身份重新授权、显式替换、禁用、卸载与 token 撤销恢复；
- 通过重新提交凭证恢复错误 secret、取消、意图冲突，以及刷新页面后恢复；
- 同 secret 重新授权仍在等待 URL 验证期间的正常入口消息；
- 并发 setup/激活不产生部分切换；
- API 响应、诊断、日志和 trace 中的 secret 脱敏。

Slack 协议参考：[App manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)、
[`auth.test`](https://docs.slack.dev/reference/methods/auth.test/)、
[请求签名](https://docs.slack.dev/authentication/verifying-requests-from-slack/) 与
[`url_verification`](https://docs.slack.dev/reference/events/url_verification/)。
