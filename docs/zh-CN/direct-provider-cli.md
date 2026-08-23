# 直接使用 Provider CLI 发送消息

[English](../direct-provider-cli.md)

OpenTag 负责 IM 入站路由、Integration 凭证、Client 临时凭证投影和 provider 原生入站引用，不提供消息发送、回复、Reaction 或上传 API。

每个有效且 Agent 可见的 IM Turn 开始前，Client 创建私有的 `0600` 环境文件，只通过 `OPENTAG_PROVIDER_ENV_FILE` 把文件路径交给 Agent。Agent source 该文件后直接调用官方 `lark-cli` 或 `slack api`。Turn 完成时删除文件；若删除失败，会在 Session 或 Client 关闭时重试；Client 崩溃留下的文件由下次启动恢复清理。

卡片、Blocks、文件、thread、贴纸和 Reaction 都保留 provider 原生格式。OpenTag 不转换这些内容，也不接收出站正文、provider message ID 或发送结果。因此 OpenTag 不提供出站投递状态、审计、幂等、防过时回复或会话级出站目标限制。

`direct` 与 `ambient` 使用相同的凭证生命周期。`direct` 表示人明确对当前 Agent/Session 说话；`ambient` 表示 Agent 旁听到消息，默认避免重复或打扰式介入，但仍可自主回复、Reaction、主动发送或不行动。

直接执行 provider CLI 需要 Runtime 网络权限，并让 Agent 获得绑定 Bot token scope 内的全部权限，因此已配置 scopes 必须被视为有意授予 Agent 的权限边界。Feishu/Slack CLI readiness 与 Codex/Claude Code readiness 分开报告；handoff 同时要求所选 Agent Runtime、provider CLI，以及 provider 必需的入站连接处于 ready。

## Slack CLI 要求

OpenTag 要求官方 Slack CLI 4.2.0 或更高版本。`slack api <method>` 自 4.1.0 起提供，4.2.0 移除了会干扰非交互式 `slack api` 调用的后台更新检查。Client 通过 `slack version --skip-update` 与 `slack api --help --skip-update` 探测；版本过旧时报告为 `unavailable` 并附带 `reason: "version_incompatible"` 和检测到的版本，以便升级而非重装。

托管 Turn prompt 要求 Agent 在入站 thread 内回复（`thread_ts` = 入站 `threadTs`，若无则为入站 `messageTs`），并使用 `slack api chat.postMessage --json '{...}' --skip-update`。请求体必须始终通过 `--json` 传递：`key=value` 参数会被 form-encode 并把 Bot token 放进请求体，而 `--json` 则通过 Bearer header 发送。Agent 不得传 `--token`、`--app`、`-w` 或 `--team`；投影的 `SLACK_BOT_TOKEN` 是唯一凭证，且优先于本机已登录的任何 Slack CLI session。

Slack CLI 没有 stdin 或文件形式的请求体，因此出站消息文本始终出现在 `slack api` 的命令行中，本机任何能列出进程参数的进程都能看到。不要在出站消息中放置机密，并把 Client 机器视为与 Bot token 同等信任级别。

升级后，现有 Slack binding 需要重新授权一次，以便 OpenTag 分别验证并保存 Slack Bot ID 与 Bot User ID。该验证身份仅用于在持久化前过滤绑定 Bot 自己的入站事件，避免消息自循环。
