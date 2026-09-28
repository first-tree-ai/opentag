# Agent 权限

[English](../agent-permissions.md)

本地 Agent 默认允许读取和编辑工作区文件。Codex 使用 `workspace-write`、`on-request` 审批，
并禁用沙盒网络访问。Claude Code 使用 `acceptEdits` 和原生权限回调。Pi 通过原生包加载器显式加载
`npm:@gotgenes/pi-permission-system@35.0.1`，默认允许工作区内的文件工具，运行 bash、访问外部目录
或使用其他工具前需要审批。Claude 和 Pi 的权限判断机制不提供操作系统沙盒隔离。
Pi 忽略项目级权限配置，将 IM 消息作为普通请求处理；权限策略来自 Agent 执行设置。

在 Agent 执行设置中，将指定审批用户的 Slack 用户 ID（`U…`）或飞书应用对应的 open ID（`ou_…`）
填入审批用户字段。只有该用户可以处理此 Agent 的审批请求。未设置审批用户时，需要审批的
操作会被拒绝。云端 Agent 始终使用完整权限，不提供权限设置。

可选规则字段接受提供者原生 JSON。留空使用上述默认规则。例如：

| 提供者 | 规则示例 |
| --- | --- |
| Codex | `[{"pattern":["git","status"],"decision":"allow"}]` |
| Claude Code | `{"allow":["Bash(git status)"],"deny":["Bash(sudo *)"]}` |
| Pi | `{"bash":{"*":"ask","git status":"allow","rm -rf *":"deny"}}` |

Codex 支持 `allow`、`prompt` 和 `forbidden`；Claude 支持 `allow`、`ask` 和 `deny` 列表；
Pi 支持 `allow`、`ask` 和 `deny` 值或匹配规则。保存前会验证规则。
Agent 自配置 API 不允许修改权限设置。Pi 在本地运行时首次 turn 安装固定版本包，后续复用
该运行时的缓存。若无法加载扩展，则在发送 prompt 前使 turn 失败。

Slack App 需要启用 Interactivity，请求 URL 为
`{OPENTAG_PUBLIC_URL}/api/v1/im-bindings/slack/interactions`。一等发行 manifest 已包含此配置。
自定义 App 也可以使用
`{OPENTAG_PUBLIC_URL}/api/v1/agents/{agentId}/im-binding/slack/interactions`。
Slack 回调使用 installation 的签名密钥对原始请求体进行认证。

飞书 App 需要通过现有长连接订阅 `card.action.trigger` 回调。
新的二维码注册流程已包含该回调；现有 App 需要在开发者控制台中启用。

审批请求显示在原始 IM 线程中，提供 **Approve once** 和 **Deny** 按钮。
提供者保持暂停，点击按钮后向同一个正在运行的 turn 返回决定。决定会临时保存，以便传递给
持有运行时连接的服务器副本；运行时确认响应后更新卡片。重复点击、错误用户、过期请求、
绑定或权限设置变更、运行时连接被替换都无法授权操作。

审批请求随现有 turn 截止时间过期。断开连接或服务器重启会使待执行操作失效，不会重放审批。
请求记录在七天后清理。此版本仅支持单次操作决定，不提供整场会话授权按钮或任意提供者提问。
无法在卡片中完整显示的大型请求会被拒绝。
