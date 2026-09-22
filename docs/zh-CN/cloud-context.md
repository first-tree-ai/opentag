# Cloud Context Tree 与 Session 协作（E8）

[English](../cloud-context.md)

同步日期：2026-09-21。

Cloud Session 共享所属 Agent 的当前配置和已发布的 Context Tree 知识。每个 Session
保留独立工作目录、Pi 历史和未发布工作。逻辑 Cloud Computer 不代表共享文件系统，也不代表
存在 Local Computer 的 WebSocket 连接。

## 状态归属

| 信息 | 来源 | 其他 Session 如何获得 |
| --- | --- | --- |
| Agent 身份、指令、模型和 Tree 选择 | Server 现有 Agent/runtime 配置 | 下一轮执行的有效配置快照 |
| 已发布知识 | 显式选择的 GitHub Context Tree | 各自有权访问的副本和正常 Tree 同步 |
| Pi 对话、任务文件和未发布 Tree 草稿 | 当前 Agent Session 工作目录 | 不向其他 Session 同步 |
| 协作消息和有权读取的对话信息 | 现有 Session/IM API | 使用当前执行权限的受管 CLI |
| Provider 凭证 | 现有 Server 凭证服务 | 重新签发执行级材料，不从工作目录恢复 |

不引入第二套 Agent 配置库、共享 Agent Home、后台目录复制或 Context Tree 快照历史。
`sandboxes.storage_uri` 仍指向 Session 最新保存状态。E8 不把 Server 变成 Git 托管服务。

## 配置与恢复

Server 为每次新执行组装现有有效配置快照。恢复工作目录只恢复用户工作和 Pi 连续性，不选择旧模型、
恢复旧 Tree 选择或重新激活已保存的凭证。Worker 使用当前快照和新执行材料恢复原有 Pi 绑定。

运行中的 Turn 保留已接收的配置；Agent 指令更新在下一轮生效。凭证和资源访问权限仍在现有边界
独立复查；提示词保持不变不代表能够继续访问已撤权的集成。

Agent 的规范 slug 来自当前 Server 指令，改名后也如此。写入 `members/<agent-slug>/` 时使用该身份；
物理 Instance 名称和 Pi 对话 ID 都不是 Agent 身份。

## Context Tree

Tree 按 Agent 显式保存为具名连接列表（`contextTrees`），空列表是正常状态。Cloud 只支持连接已有授权仓库或断开，自动建库后续再做。设置入口在保存前校验 Account 归属、该 Agent 当前的
GitHub `context_tree` 授权、仓库准入和实际 Tree。逻辑 Cloud Computer 在线不能替代这些校验。
Local 设置继续使用原有 Computer 通信。

异步校验完成后，现有 Agent/runtime revision 保护最终写入。修改非空连接列表仍要求暂停 Agent，每项操作明确指定别名。
断开只移除选择，不删除远端仓库或先前保存的未发布工作。

每个 Cloud Sandbox 有独立副本。暴露 CLI 前先断开已移除或撤权的别名，但保留副本和草稿。
每个仓库单独检查当前授权。版本 2 CLI 响应按别名报告结果；部分失败或三十秒总预算超时仍保留
已完成结果，明确标记过时或未完成的树。树之间没有隐含优先级。详见[具名 Context Tree 集成](./design/context-tree-integration.md)。
固定版本的 Context Tree CLI 和配套 skills 负责读取、同步、
准备写入、校验和发布。Cloud 准备使用当前执行的受管 GitHub 环境，并检查仓库授权；不得回退到宿主
Git 配置或 `gh auth login`。

只有已发布修改才会通过其他 Session 自己的同步变为可见。未提交修改、准备中的写入和未发布提交
保持私有，随现有工作目录一起保存和恢复。冲突必须保留这些工作并报告问题，不得通过清空脏目录或
强制推送伪装同步成功。

Tree 是可选记忆。未配置、缺少授权、拉取失败或冲突都应提供真实的受管状态，不能宣称知识已更新；
基础 Pi 任务仍可继续。撤权不能抹除已经读取的知识，但新的受管远端访问和发布仍需当前权限。

首次 clone 被中断时可能留下不完整副本，固定版本 CLI 会在后续 Turn 报告不可用。自动删除可能损坏
草稿，因此需要显式修复该副本；基础任务仍能继续。

## Session 协作

Agent 继续使用现有受管命令：

```text
opentag session create --message <task>
opentag session send <target-session-id> --message <text>
opentag session list
```

来源 Session 由执行环境提供，不允许调用方自行指定。Cloud 证明必须属于当前 Session、placement
以及有效的分配和执行。Computer 永久在线、猜测兄弟 Session ID、持有旧分配材料，都不能建立权限。

目标继续遵守同 Agent 和对话作用域。Cloud 内部子 Session 使用自己的 Sandbox 和 Pi 对话，不继承
父 Session 的目录或 IM 发件权限。子 Session 通过 Session 消息回报；可见 Session 的回调使用其
自身授权的发件能力，不自动把子 Session 文本转发到 IM。

IM 输入和协作工作共用 Sandbox 的单执行槽以及清理、保存边界，不能并发启动两个 Worker，也不能
让空闲回收打断已接收工作。消息 ID 是逻辑重试身份；结果不确定时不能换一个 ID 重发，并假定旧任务
没有运行。

Session CLI 证明在排到共享队列头部、真正打开执行时签发，排队消息不会替换当前 Turn 的证明。
Runner 持续保留终态回执，直到 Server 确认持久化提交；凭证关闭本身不代表任务完成。

Cloud 派发仍由单 Server 管理。E8 不增加跨 Server 路由或独立任务队列。Local 协作保留现有行为和
信任边界。

## 验证边界

本地验证覆盖真实归档恢复后的新配置、Session 私有状态、Tree 冲突保留、精确来源授权、重复派发、
执行串行和空闲回收竞争。Provider fixture 证明这些边界，不代表真实账号授权通过。

原生验收必须配套 Server 与 Runner 的源码和版本，实际调用 Cloud Run/GCS/Pi，并覆盖冷恢复和物理
Instance 复用。真实 GitHub 验收还需要已配置的 App、明确授权的测试仓库和真实用户准入。
IM 全链路验收需要指定测试对话，并授权发送合成测试消息。

现有契约见 [Cloud Runner 执行](./cloud-runner-execution.md)、
[工作目录持久化](./cloud-workspace-persistence.md)、[内部 Session 协作](./internal-session-collaboration.md)
和 [平台集成](./platform-integrations-foundation.md)。
