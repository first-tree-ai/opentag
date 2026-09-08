# 直接使用 Provider CLI 发送消息

[English](../direct-provider-cli.md)

本地第三方包、路径、执行身份与凭证交接由已随产品发布的 Provider CLI 管理基础能力定义。
OpenTag-managed Provider CLI 是当前操作系统账户可直接使用的全局命令；只有被授权的
Turn 才会取得 OpenTag 投影的临时凭证。

OpenTag 负责 IM 入站路由、Integration 凭证、Client 临时凭证投影和 provider 原生入站引用，不提供消息发送、回复、Reaction 或上传 API。

首次上手时，定向的 `opentag connect` 命令是两套官方 Provider CLI 的唯一安装者。
它不使用交互式问答，会返回有界的后续动作，人或 Agent 都可以执行。在 setup 未完成时，
daemon 会独立检查并上报两套 CLI 状态，不会与前台安装争用安装锁。

有效的 Feishu/Lark 或 Slack binding 产生对应依赖后，daemon 只可修复该 binding 所需的
OpenTag-managed artifact，并在上报 ready 前用真实 binding 凭证验证同一个精确 CLI；不得替换
外部安装或非 OpenTag shim。`opentag doctor` 与 portable installer 只报告 account-global
静态安装状态，不安装、不修复、不验证凭证，也不推断登录或订阅状态。

每个可以写入 IM 的有效可见 Session Turn（包括 IM delivery 与 Internal Session 协作回调）开始前，Client 创建私有的
`0600` 环境文件，只通过 `OPENTAG_PROVIDER_ENV_FILE` 把文件路径交给 Agent。Agent source 该文件后直接调用官方
`lark-cli` 或 `slack api`。Turn 完成时删除文件；若删除失败，会在 Session 或 Client 关闭时重试；Client 崩溃留下的
文件由下次启动恢复清理。Internal Session 永远不会收到该文件。

IM delivery Turn 使用该事件携带的 provider 原生消息引用；可见 Session 的协作 callback 则使用 credential grant v2
提供的非敏感默认 outbox context。Server 在授予凭证的同一次授权操作中，从目标 Session 既有 channel/thread scope
派生该 context；Client 和 Agent 不能自报 OpenTag outbox target。回调目标为 thread Session 时会保持 provider 原生
thread scope。这个 context 是默认交付目标，不会缩小下文所述 Bot token 的整体权限范围。

对于 Feishu Turn，managed Turn context 会要求 Agent 使用不插值的 POSIX heredoc 或 PowerShell here-string 变量向
`lark-cli` 传递富文本或多行正文。发送前还必须检查：如果预期为多行的正文没有真实换行，却包含多个字面量
`\n`，则拒绝发送。该检查不会一律改写所有 `\n`，因为代码和正文可能确实需要讨论这个 token。

卡片、Blocks、文件、thread、贴纸和 Reaction 都保留 provider 原生格式。OpenTag 不转换它们，也不提供消息发送、回复、Reaction 或上传 API。直接执行 Provider CLI 仍是 Agent 唯一的出站路径，并保留该权限。

作为 Task 回复历史的有界捕获例外，Turn runner 会记录官方 CLI 中成功的 Lark `+messages-send` / `+messages-reply` 变更（以及受支持的 native/raw API 等价命令）。捕获要求成功退出、`ok=true` JSON envelope、provider message ID 和 chat ID。shortcut 的发送/回复回执不含正文，因此在有效发送之后，runner 可以用同一个已验证的 target 与环境对该消息做有界只读 raw `GET`。若这次读取失败（包括缺少读权限），发送本身仍然成功；OpenTag 保留回执并把正文标为不可用。它不会用 argv Markdown 或模型输出顶替正文，不会对已成功的发送自动重试，也不会把发送回执当成“对方已读”。

捕获的回执是按现有 Home/Session/Run plan 身份隔离的私有 per-run 文件，在构造 Turn report 之前收集；仅在字段存在时纳入 hash，使旧报告保持原来的 hash；未协商 Turn report v2 的旧 Server 不会收到该字段。不会把 Slack 当成 Lark 收集。大小受现有 64 KiB runtime frame 与 48 KiB `finalText`（JSON 转义前）约束；只带回执的报告必须能放入 frame，预算不足时优先保留出站正文，而不是可选的 runtime summary。

捕获是观察机制，只覆盖通过受管官方 CLI launcher 执行且能够识别的消息变更。其他进程、SDK 调用、Reaction、编辑和历史发送不会补录。快照随 Turn 终态报告提供，每份最多 16 条回复，单个文本或 raw 字段最多 8 KiB，总计最多 32 KiB；截断和省略会明确标记。私聊按 chat 匹配，群聊及话题还需匹配 root/thread 证据。正文来自 provider，不能从命令参数重建。

报告协议版本在 Turn 开始时固定，断线不会静默丢弃快照。只有 Turn 报告持久化后才删除回执文件；启动恢复会使执行 plan 失效，但保留尚未进入报告的回执证据。若进程在报告持久化前崩溃，现有恢复流程无法自动重建原始 Task 范围；恢复后的 Turn 仍表示结果不确定、回复记录不可用，不能声称没有发送。报告持久化后，现有重放流程会保留回复，并通过规范化 JSON 哈希兼容断线重连及 JSONB 存储。

OpenTag 仍然没有出站投递状态、幂等、防过时回复，或超出“把回执关联到来源 Task 会话”之外的会话级出站目标限制。

`direct` 与 `ambient` 使用相同的凭证生命周期。`direct` 表示人明确对当前 Agent/Session 说话；`ambient` 表示 Agent 旁听到消息，默认避免重复或打扰式介入，但仍可自主回复、Reaction、主动发送或不行动。

直接执行 provider CLI 需要 Runtime 网络权限，并让 Agent 获得绑定 Bot token scope 内的全部权限，因此已配置 scopes 必须被视为有意授予 Agent 的权限边界。Feishu/Slack CLI readiness 与 Codex/Claude Code readiness 分开报告；handoff 同时要求所选 Agent Runtime、provider CLI，以及 provider 必需的入站连接处于 ready。

Session conversation scope 只限制 OpenTag 的自动持久化、历史 bootstrap 和路由，不限制投影后 Bot token 可访问的
provider API 目标。任务需要时，Agent 可以查询 Bot 有权访问的其他 conversation 原生历史。查询结果只进入 Runtime
context，不会自动创建 `ImMessage` 记录或跨 Session 投递。

升级后，现有 Slack binding 需要重新授权一次，以便 OpenTag 分别验证并保存 Slack Bot ID 与 Bot User ID。该验证身份仅用于在持久化前过滤绑定 Bot 自己的入站事件，避免消息自循环。
