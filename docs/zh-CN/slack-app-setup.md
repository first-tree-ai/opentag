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
Server 已记录的待生效接收模式所需的 bot scopes 和事件。

## 管理员流程

1. 在 Agent 的 **IM** 页面选择 **Connect Slack App**、**Reauthorize Slack** 或 **Replace Slack App**。
2. 打开生成的 manifest 链接，创建专属 Slack App，并安装到目标工作区。
3. 从 **OAuth & Permissions** 复制 **Bot User OAuth Token**，从 **Basic Information** 复制 **Signing Secret**，
   提交给 OpenTag。
4. OpenTag 调用 Slack `auth.test`，推导 App ID、Team ID、存在时的 Enterprise ID、Bot User ID、Bot ID，以及 token
   实际返回的 `x-oauth-scopes`。浏览器提交的身份或 scopes 列表从不作为权威事实。
5. 回到 **Event Subscriptions**，重试生成的 Request URL。OpenTag 先验证 Slack 带时间戳的 HMAC 签名，再返回
   URL verification challenge。
6. 将机器人邀请到测试频道并 @mention。只有首个签名有效的事件所带 App ID、Team ID 与 token 检查结果一致时，
   OpenTag 才会激活绑定；该事件随后通过已激活绑定进入系统。

Slack 可能在 manifest 创建后立即尝试 URL 验证，此时 OpenTag 尚未拿到 Signing Secret，首次失败属于预期行为；提交凭证后
重新验证即可。

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
manifest 则请求目标 scopes；只有激活成功时才会原子应用目标模式。

`mention_only` 不承诺自动提供 mention 前后的频道消息。任务需要更多 provider 原生上下文时，Agent 可以通过官方
Slack CLI 主动查询；实际范围受已安装 Bot Token 的 scopes 和 conversation membership 限制。

## 安全与恢复

- Bot Token、Signing Secret 和待完成 setup context 在写入数据库前加密，管理员 API 与诊断 API 均不返回这些内容。
  Signing Secret 绝不投影到 Agent runtime。
- OpenTag 对自动持久化和投递实施 Session 隔离，但不把投影给 Runtime 的 Bot Token 收窄到当前 channel 或 thread。
  在有效且 Agent 可见的 IM Turn 中，Agent 可以在 Bot Token scopes 与 Slack membership 允许的范围内使用官方 CLI。
  查询结果只进入 runtime context，不会自动成为 OpenTag `ImMessage` 历史，也不会自动投递给另一个 Session。
- Slack 签名验证使用原始请求体、五分钟重放窗口和常量时间比较。
- URL verification challenge 能证明 Signing Secret，但不携带安装身份。因此激活必须等待后续带有匹配 App、Team ID 的
  签名事件。
- 一个 Slack App 安装最多只能当前绑定一个 Agent；冲突失败且不改变任一绑定。
- 重新授权在新凭证代际就绪前保留当前绑定；替换只在激活时创建新绑定身份并禁用旧绑定。
- 事件激活会锁定并重新核验当前 setup attempt 的精确 ID、活动状态和过期时间，再在同一事务中推进 credential、应用
  待生效接收模式并完成 setup slot。已过期、已取消或已替换 attempt 的旧事件不能激活。
- 当前 bot token 出现在 `tokens_revoked` 时，绑定进入需要重新授权状态。
- `app_uninstalled` 会禁用绑定。管理员可以重试过期或失败的 setup、重新授权、替换或显式禁用绑定。

Slack setup 遵循与其他 IM provider 相同的 runtime readiness 边界。已配置不等于可交接；只有 Agent runtime 和官方
Slack CLI 能力都 ready 时才可 handoff。Slack 出站发送保持 provider-native，OpenTag 不声称拥有 provider 的最终投递事实。

## 验收覆盖

支持流程必须覆盖：

- 无效 Bot Token 与 Slack API 不可用；
- 两种接收模式下的 scopes 缺失；
- 无效、过期或重放的 Slack 签名；
- token 身份与签名事件身份不一致；
- App/Team 安装重复绑定冲突；
- 创建、同身份重新授权、显式替换、禁用、卸载与 token 撤销恢复；
- 并发 setup/激活不产生部分切换；
- API 响应、诊断、日志和 trace 中的 secret 脱敏。

Slack 协议参考：[App manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)、
[`auth.test`](https://docs.slack.dev/reference/methods/auth.test/)、
[请求签名](https://docs.slack.dev/authentication/verifying-requests-from-slack/) 与
[`url_verification`](https://docs.slack.dev/reference/events/url_verification/)。
