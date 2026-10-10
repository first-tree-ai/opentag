# Agent 权限

[English](../agent-permissions.md)

本地 Codex Agent 使用 `workspace-write`、`on-request` 审批，并禁用沙盒网络访问。
本地 Claude Code Agent 使用 `auto`：原生分类器审查操作，剩余审批通过权限回调发送给任务发送者。
Claude Code 必须支持 `auto` 和 `--permission-prompt-tool`。Claude 的原生权限机制不提供操作系统沙盒。
Claude 不加载用户或项目设置，并禁用所有 hook 和 skill 的动态 Shell 执行。
仅将明确同步的 skill 和 Context Tree 包内的 skill 链接到私有的纯 skill 插件中，以
`opentag:<skill-name>` 提供。不可用的 skill 会被跳过。skill 保留原生元数据，并使用原始指令和资源；
运行期间的编辑会实时可见。Claude 遵循 skill 的 `allowed-tools` 授权，因此 skill 可以预先批准
原本需要审批的命令。审批是实用的操作防护，并不隔离可写 skill，也不阻止免审批的文件读取和上传。
仍可使用订阅登录。
Pi 始终无需审批，不提供权限设置，也不加载权限扩展。

原生命令规则允许飞书和 Slack 消息读取、发送、编辑、表情操作、会话查询及原生附件命令。
直接运行 CLI 即可，受管 launcher 自动加载此 Turn 的凭据。多行正文使用带引号的字面量参数或
JSON 内容，不再提供回复助手。简单复合命令和管道由提供者逐条检查，`head`、`tail`、`cat`、
`echo`、`printf`、`jq`、`wc`、`stat`、`sleep`（限流等待）有明确规则。其他操作遵循原生权限检查，包括当前 skill 的权限授权。
Shell 赋值、命令替换、重定向和 heredoc 仍可能需要审批；普通消息命令应避免这些形式。
Slack 附件传输使用限定的 `curl https://slack.com --request-target` 规则，传入字面量形式的
执行代理地址、CA 路径及返回的 handle 路径。仅从环境文件读取两个非敏感路由字段，不通过 Shell 加载该文件。

本地 Codex 和 Claude Code Agent 的模型设置允许所有者关闭未来任务的审批，或添加命令前缀，
包括前缀后的参数。Claude 自动模式仍可能审查宽泛的执行规则。内置命令不会显示在列表中。
审批发送到任务发送者的 Slack 或飞书私聊，无需审批用户 ID 或账户关联。
云端 Agent 始终使用完整权限，不提供权限设置。

Agent 自配置 API 不允许修改权限设置。

Slack App 需要启用 Interactivity，请求 URL 为
`{OPENTAG_PUBLIC_URL}/api/v1/im-bindings/slack/interactions`。一等发行 manifest 已包含此配置。
自定义 App 也可以使用
`{OPENTAG_PUBLIC_URL}/api/v1/agents/{agentId}/im-binding/slack/interactions`。
Slack 回调使用 installation 的签名密钥对原始请求体进行认证。

飞书 App 需要通过现有长连接订阅 `card.action.trigger` 回调。
新的二维码注册流程已包含该回调；现有 App 需要在开发者控制台中启用。

审批请求显示在任务发送者的私聊中，提供 **Approve** 和 **Deny** 按钮。
卡片显示原因和操作，不显示提供者传输元数据或用户 ID。
提供者保持暂停，点击按钮后向同一个正在运行的 turn 返回决定。决定会临时保存，以便传递给
持有运行时连接的服务器副本；运行时确认响应后更新卡片。更新失败时，服务器运行期间会重试。
重复点击、错误用户、过期请求、
绑定或权限设置变更、运行时连接被替换都无法授权操作。

审批请求随现有 turn 截止时间过期。替换运行时连接时，会在注册事务中使旧连接的请求失效。
决定传递在同一 Computer 行锁下检查持久化的连接和审批状态，防止另一服务器副本上的
连接替换与旧审批的批准操作发生竞态。心跳和断开操作也匹配持久化的连接 ID，
因此旧 socket 无法断开复用同一进程实例的新连接。
服务器重启后，任意副本都可以使孤立请求过期，并重试已结束审批的卡片更新；审批不会重放到新连接。
请求记录在七天后清理。此版本仅支持单次操作决定，不提供整场会话授权按钮或任意提供者提问。
无法在卡片中完整显示的大型请求会被拒绝。
