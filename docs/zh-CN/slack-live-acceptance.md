# Slack 本地 live 验收

[English](../slack-live-acceptance.md)

这是一份无凭证清单，供以后对**另行注册的测试 Slack Team 与 Slack App** 做 live 验收。不要提交 token、signing secret、
OAuth code、Team ID、channel ID、user ID 或 traces。结果记录在仓库之外。

本清单只覆盖单 Slack Team / 单 Agent 的经典消息路径，不接受 Agent View、多 Agent 路由、slash command、安全重设计或
消息保留策略变更。入站持久化以及 `mention_only` / `all_message` 行为保持现有实现。

## 前置条件

- 专用测试 Slack Team，不是生产 workspace。
- 另行注册的 Slack App，其 bot scopes 与订阅 bot events 与
  [slack-public-distribution-manifest.yaml](../slack-public-distribution-manifest.yaml) 一致。
- 本地 OpenTag Server 配置该测试 App 的一等凭据（`OPENTAG_SLACK_*`），永不入库。
- 一个 OpenTag Agent，其当前 Slack installation 就是该 App/Team。
- 测试用户可以给 bot 发 DM、在公开频道 @它、邀请它进入私有频道，并发起 MPIM。

固定必需 bot scopes（契约顺序）：

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
- `im:write`
- `mpim:history`
- `reactions:read`
- `reactions:write`
- `team:read`
- `users:read`

## 精确 scope 核验

1. 为该 Agent 完成一等 OAuth。
2. 确认 OpenTag 诊断里 `requiredCapabilities` 与 `grantedCapabilities` 等于上述十六项，且 `missingCapabilities` 为空。
3. 确认 Slack 已安装 App 展示同一组 bot scopes。不要把 token header 或 `x-oauth-scopes` 写进会入库的笔记。
4. 从测试 App 去掉一项必需 scope 后再授权。OpenTag 必须以 `SLACK_SCOPE_REAUTH_REQUIRED` 失败关闭，且不得把 installation
   报告为健康。

## 按会话类型入站

对每种会话发送一条人类消息，并确认 OpenTag **持久化**入站行，即使随后不投递：

| 会话 | 准备 | 持久化 | 投递说明 |
| --- | --- | --- | --- |
| DM | 与 bot 打开 DM | 是 | `direct`，与 receive mode 无关 |
| 公开频道 | bot 已是成员 | 是 | 见下方 mention / `all_message` |
| 私有频道 | 邀请 bot；不要依赖 `channels:join` | 是 | 准入与公开频道相同；必须已是成员 |
| MPIM | 把 bot 加入多人 DM | 是 | 作为 `group_dm` |

Agent CLI 的公开频道 `conversations.join` 可以把 bot 加入公开频道。对未加入的私有频道或 MPIM，`channels:join` 不得成功。

## `mention_only` 与 `all_message`

只切换 Agent 的 `receiveMode`。这不得轮换凭证代际、改写 Slack manifest，或要求重新授权。

- **`mention_only`：** 未 @ 的公开/私有/MPIM 消息会持久化但不投递。`@mention` 以 `direct` 投递。DM 以 `direct` 投递。
- **`all_message`：** 未 @ 的频道或 MPIM 消息会持久化并以 `ambient` 投递。mention 与 DM 仍为 `direct`。
- Thread 连续性保持 [thread-sessions.md](./thread-sessions.md) 的现有规则：`mention_only` 在没有可信 direct 连续性时，不为
  未寻址回复物化 Thread Session；`all_message` 可以把 Thread Session 以 `ambient` 物化或唤醒，同时给 Channel Session 一份
  observer copy。

## 根消息、thread、编辑、删除与去重

1. 发一条寻址 Agent 的频道根消息。确认投递给 Channel Session，且不会预先创建 Thread Session。
2. 在 Slack thread 中回复。确认 Thread Session 按 receive mode 物化；第一次 direct Thread delivery 的有界 history 包含
   可见根消息与先前 thread 消息，不含兄弟 thread。
3. 编辑根消息和一条 thread 回复。确认同一 `externalMessageId` 写入新 revision，后续 history 显示编辑后文本而不是原文。
4. 删除一条 thread 回复。确认后续 history 对该消息显示 `[deleted]`。
5. 重放同一 Slack `event_id`。确认入站行不重复（`duplicate: true` / 只保留一条消息）。

## 跨会话读取

在会话 A 的 Turn 中，当用户任务点名会话 B 时，让 Agent 用 `conversations.history` / `conversations.replies` 读取 B。

- bot 已加入的公开频道：读取成功。
- bot 不在的私有频道或 MPIM：Slack 返回 `not_in_channel`、`channel_not_found` 或成员资格错误。Agent 不应重试 join；需要人类
  邀请 bot。

## 主动发消息与 DM

- 对当前频道 `chat.postMessage`；存在 `threadTs` 时发 thread 回复。
- 对 bot 自己的消息执行 `chat.update` / `chat.delete` / `chat.scheduleMessage`。取消时需预留足够时间，获取
  `scheduled_message_id` 后立即调用 `chat.deleteScheduledMessage`，并用 `chat.scheduledMessages.list` 确认已无残留。
- 当用户任务要求主动 DM 时，用 `conversations.open` 再 `chat.postMessage`。

始终使用 `slack api <method> --json '<json>'`，且只传一个 JSON 对象。不要传 token、app、team、workspace、config 或
update 覆盖 flag。

## 表情回复

- 对一条入站人类消息执行 `reactions.add`、`reactions.get`、`reactions.remove`。
- 确认 bot 不能用 OpenTag Session ID 代替 Slack 的 `channel` / `timestamp`。

## 入站与出站文件

- 入站：给人类消息附加一张图片和一个非图片文件。确认持久化消息保存 resource 描述，且 Agent Turn 能用 `files:read` 拉取
  可用文件。
- 出站：只走 Slack 当前外部上传：`files.getUploadURLExternal` → 把字节 HTTP POST 到 `upload_url` →
  `files.completeUploadExternal`。不要调用已弃用的 `files.upload`。

## 预期 Slack 错误

主动触发并确认 Agent 展示 provider 错误，而不是伪造成功：

- bot 不在的频道：`not_in_channel` / `channel_not_found`
- 正文超过 Slack `text` / `markdown_text` 限制时出现 `msg_too_long`，或拆成多次 `chat.postMessage`
- HTTP `429` / `ratelimited` 时遵守一次 `Retry-After`，而不是紧循环轮询
- 在 Slack 撤销测试 App 的 bot token 后出现 `invalid_auth` / `token_revoked`
- 方法缺少对应 granted scope 时出现 `missing_scope`（完整安装下不应发生）

## 重新授权

1. 必需 scope 扩展之后，仍只有 7 项（或其他不完整集合）的旧安装必须投影为 `reauthorization_required` /
   `SLACK_SCOPE_REAUTH_REQUIRED`，不得报告凭证健康。
2. 用完整十六项 scopes 做同身份重新授权时，必须保持 App、Team、Bot User，递增 `credentialGeneration`，并在身份闭合成功后
   恢复 `active`。
3. 不同 Agent 声称同一 App/Team 时必须返回 `SLACK_APP_TEAM_ALREADY_BOUND`，且无副作用。

## 撤销与卸载

- 该 Bot User 的 Slack `tokens_revoked`：该 installation 代际进入 `reauthorization_required`，错误为
  `SLACK_TOKEN_REVOKED`。入站投递失败关闭。
- Slack `app_uninstalled`：禁用该 installation 代际并清除 active credential material。Agent route 不得继续持有可用 Bot
  Token。

不要把被撤销的 token、signing secret 或原始事件正文存进仓库。
