> 历史设计材料，迁自旧版 docs/design。当前实现范围与验证结果见 [验收记录](../../README.md)；本文后续任务恢复等提案不代表已实现功能。

# 外部连接导航竞品调研

调研日期：2026 年 10 月 14 日。

本文比较外部连接的命名、管理入口及具体工作中的使用方式。本文是调研记录，不是已批准的 OpenTag 设计或实施方案。[英文原文](../integration-navigation-benchmark.md)。

## 证据范围

以下发现来自实际打开的一手产品页面、帮助文档和 API 文档，**未登录竞品账户验证实时界面**。具体菜单位置、中文名称、功能开放范围及视觉样式可能不同。官方文档中存在的导航路径冲突会明确记录，不将不同版本的说明拼成一个界面。

## Manus

### 命名与分组

当前公开功能页使用 **Connectors** 统合应用连接器、**Custom MCP** 和 **Custom API**。GitHub 与 Gmail、Slack、Google Workspace 并列，自定义连接是同一概念下的创建选项。中文功能页使用 **连接器**。这直接支持不同接入机制共用一个面向用户的类别。[英文功能页](https://www.manus.im/features/connectors)、[中文功能页](https://www.manus.im/zh-cn/features/connectors)

功能页记载 **Connectors → Create → Add MCP by URL**，同时支持命令或 JSON；自定义 API 的路径为 **Connectors → Create → Custom API**。公开启动链接指向 `/app?openConnectors=true`，但不能据此确定登录后 Connectors 在侧栏或菜单中的位置。[连接器功能页](https://www.manus.im/features/connectors)、[官方启动链接](https://www.manus.im/app?openConnectors=true)

其他官方文档提到在 Manus 设置中选择应用，自定义 MCP 指南仍使用 **Settings → Integrations → Custom MCP Servers → Add Server**。这与公开功能页较短的 Connectors 创建流程存在差异，不能认定设置路径是所有用户当前统一的实时入口。[MCP 连接器指南](https://manus.im/docs/integrations/mcp-connectors)、[自定义 MCP 指南](https://manus.im/docs/integrations/custom-mcp)

### GitHub 授权与任务使用

GitHub 被描述为内置连接器：连接一次，之后在任务中使用。设置始于 **Connectors → GitHub → Connect**。GitHub 上的 Manus Connector App 获得用户选择的仓库权限，后续通过 **Configure** 修改范围。任务可从聊天输入框的 GitHub 菜单选择已允许的仓库。因此，账户授权与任务仓库选择是同一连接器体验中的两个步骤。[GitHub 连接器](https://www.manus.im/connectors/github)

帮助中心将应用登录或特定凭据作为设置步骤，并说明移除连接器会清除保存的登录信息与凭据。这属于连接生命周期，与某个任务选择工具有所区别。[Manus 连接器帮助](https://help.manus.im/en/articles/12231777-how-can-i-use-manus-connectors)

### 用户、Project 与任务范围

API 要求先在网页应用中完成连接器授权，再用于任务。创建任务时，明确指定的连接器优先于 Project 默认连接器，Project 默认又优先于用户默认启用的连接器。进行中的任务可以替换、清空或保留连接器列表。这证明存在上下文选择范围，但不能证明每个 Project 都有独立 OAuth 身份。[API 连接器文档](https://open.manus.im/docs/v2/connectors)

功能页也描述了连接、启用 Project 推荐的连接器，以及向 Project 发布自定义 MCP。没有证据证明 Manus Project 对应 OpenTag 的长期 Agent，或拥有独立授权身份。[连接器功能页](https://www.manus.im/features/connectors)

### Connectors 与 Integrations

API 文档中的 **Integrations** 用于从其他工作工具进入 Manus，例如在 Slack 发起任务、接收通知，或通过 Zapier 使用 Manus，并说明在工作区设置中配置。这份文档中的功能方向有所不同：Manus 调用外部工具，以及外部工具调用 Manus。不过公开 Connectors 功能页也涵盖 Slack 任务触发，因此不能将其当作整个产品严格一致的命名边界。[API 集成概览](https://open.manus.im/docs/v2/integrations-overview)、[连接器功能页](https://www.manus.im/features/connectors)

## Claude

### 命名与入口

当前主要帮助文档将目录服务和自定义远程 MCP 统一归为 **Connectors**，管理入口为 **Customize → Connectors**。聊天中可通过 **+** 或 `/` → **Connectors → Manage connectors** 进入。发现、自定义添加、断开、配置和权限管理都使用这一管理区域。[扩展 Claude 能力的连接器](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)

另一份官方指南仍指向 **Settings → Connectors**，与主要文档的 Customize 路径不一致。本文采用主要文档的路径，同时记录这一限制；未验证实时全局入口的具体位置。该指南另将远程云服务连接器与本地 **desktop extensions** 区分，后者的文档入口是 **Claude Desktop → Settings → Extensions**。[桌面与网页连接器的选择](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)

### 授权与对话启用

账户授权和对话启用是不同操作：连接后，可在 **+ → Connectors** 中按对话开启服务。Team、Enterprise 的组织启用通常允许成员自行授权，并不替代个人认证；企业统一认证是文档记载的例外。[扩展 Claude 能力的连接器](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)

自定义 MCP 指南说明远程连接通过 Claude 账户管理，从 Anthropic 基础设施发起，并可按对话启用或停用。组织所有者配置自定义连接器定义，成员通常分别连接。固定的共用 API 凭据则使用该凭据的上游权限。这些范围不能直接等同于 OpenTag 独立授权的 Agent 挂载。[远程 MCP 自定义连接器](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

### 内置 GitHub 保留上下文文件选择流程

Claude 原生 GitHub 集成用于仓库上下文：聊天中通过 **+ → Add from GitHub → 选择文件或文件夹**；Project 中通过 **项目知识 + → GitHub → 选择仓库及文件**。Project 内容提供 **Sync** 和 **Configure files**。文档把账户启用指回 Connectors，同时保留具体工作的导入流程。它说明同步的是某个分支的文件名与内容，不包含提交历史、PR 或其他元数据。私有仓库可能还需要 GitHub App 和仓库授权。这种原生文件导入不能被视为与任意 GitHub MCP 拥有相同能力。[GitHub 集成帮助](https://support.claude.com/en/articles/10167454-use-the-github-integration)

## 对 OpenTag 的初步解释

以下是设计推论，不是竞品事实：

- 两个产品都支持用一个连接器类别容纳不同接入机制。OpenTag GitHub 的授权模型不同，本身不足以支持另造一类用户概念。
- 两者都区分建立连接与选择对话、任务或 Project 能使用什么。这个先例比直接复制账户菜单名称更有参考价值。
- GitHub 的上下文入口可提供仓库选择或文件导入，并返回共同的连接管理。专用使用流程不必对应独立的顶层服务类别。
- 竞品的用户、Project、对话范围不能直接回答 OpenTag 如何呈现拥有独立 MCP 凭据的长期 Agent。OpenTag 仍需在状态、使用范围和管理操作中保留这一差异。
- Manus 的入站 Integrations 更接近 OpenTag 消息渠道或触发器，不对应 GitHub 凭据归账户所有这件事。它不能支持把账户共用 GitHub 叫 Integration，而将 Agent MCP 叫 Connector。

## ChatGPT

### 当前名称与发现入口

当前 ChatGPT Learn 公开文档描述 **Plugins** 标签页，以及与 Codex 共用的插件目录。目录分为 OpenAI、工作区和 Personal，并单独提供 Installed 行。插件可以包含技能与 MCP 服务器。本文采用调研日读取到的名称，不假定旧版 Apps、Connectors 文档描述同一开放版本或界面。[Plugins 文档](https://learn.chatgpt.com/docs/plugins)

网页产品指南展示 **Customize → Plugins**，Skills 与 Plugins 并列。目录示例包含 GitHub、Google Drive、Slack 等服务。这是官方产品示意，本文没有登录账户验证该实时界面。[ChatGPT 网页指南](https://learn.chatgpt.com/docs/web)

### 安装、授权与使用

文档流程为发现插件、查看详情、安装，并认证所需的 MCP 连接。认证可发生于安装时或首次使用时。随后用户直接提出工作目标，或用 `@` 指定插件。卸载插件和撤销另行连接的 MCP 集成是不同操作。这些是插件体验中的生命周期步骤，不能证明所有连接都属于某个长期 Agent。[Plugins 文档](https://learn.chatgpt.com/docs/plugins)

对于 dots，文档说明其可使用账户已安装并启用的受支持插件，实际访问取决于连接、权限及运行环境；已有 ChatGPT 应用权限也适用于 dot。应用访问、电脑连接与消息联系方式明确分开。这可用于比较长期助手，但不能证明其存在 OpenTag 式的通用 Agent 独立凭据清单。[dot 的电脑与应用](https://learn.chatgpt.com/docs/dots/computers-and-apps)

### 受管理的连接

企业流程另有按角色划分的 **Admin Console → Workspace connections**。管理员建立具名的应用账户连接，控制谁能发现、使用、管理；团队或工作流所有者再选择可用连接。文档区分外部账户权限、角色访问、可见范围和工作流选择。这支持将管理与上下文使用区分，但不证明应在个人账户菜单中增加企业式连接控制台。[Workspace connections 文档](https://learn.chatgpt.com/docs/enterprise/shared-connections)

## 跨产品归纳与 OpenTag 设计判断

### 已得到证据支持的内容

| 产品 | 文档中的管理概念 | 具体工作中的使用 | 重要边界 |
| --- | --- | --- | --- |
| ChatGPT | Plugins 目录；符合条件的企业工作流另有 Workspace connections | 工作描述或 `@`；dot 使用账户已启用插件；工作流选择连接 | 插件既可包含服务工具，也可包含技能。 |
| Manus | Connectors 包含目录应用、GitHub、自定义 MCP、自定义 API | 用户默认、Project 默认、任务选择及 GitHub 仓库选择 | Project 不等同于拥有独立身份的长期 Agent。 |
| Claude | Customize → Connectors，也能从聊天进入 | 按对话启用；GitHub 文件导入及项目同步 | 原生 GitHub 文件导入保留专用流程，文档中的数据范围有限。 |

表格归纳了上文各产品的一手来源。三者都区分发现、连接管理与具体任务或助手中的使用。Manus、Claude 直接支持将内置和自定义服务接入归为同一连接器类别；ChatGPT 的插件类别更宽，还包含技能。

Manus 另有入站工作流集成，例如 Slack、Zapier 发起 Manus 任务。不过公开 Connectors 页面也涵盖部分触发器，因此这一功能区别不能当作严格统一的命名规则。它不支持按凭据归账户还是 Agent 所有，将 GitHub 和 MCP 分别命名为 Integration、Connector。

### 设计启示，尚未批准

1. 外部服务的发现与管理应保持一致的用户概念。仅凭认证机制不同，不足以创建不同类别。
2. 入口应描述用户操作：全局连接或管理账户、为 Agent 启用或使用连接、为任务选择仓库。同一个连接涉及的详情可以复用。
3. 保留 OpenTag 实际的授权范围。本次讨论的背景是账户共用 GitHub、Agent 独立授权 MCP；竞品按账户连接的对话工具不能证明需要改变这些范围。
4. 汇总每个 Agent 独立凭据的全局清单，是额外的产品方案。现有来源不能证明它必须存在、必须放在底部账户菜单，也不能证明两个同名导航入口已经足够清楚。
5. 使用具体操作验证导航：从 Agent 连接 GitHub、恢复 GitHub 访问、仅为一个 Agent 连接 Figma、修改授权前确认受影响的 Agent、管理电脑后返回工作。竞品调研支持这些流程问题，不直接确定菜单顺序。

此前讨论的“应用与服务”“共享连接器”等名称仍为候选方案。本文不批准具体名称、菜单层级、授权迁移或产品代码修改。

### 后续确认的范围约束

2026 年 10 月 14 日，用户明确同意排除以下两项：

- 不新增账户级的连接器一级导航入口。
- 不建设汇总所有 Agent 凭据的清单功能。

这两项约束取代此前对应的候选方案，不代表其他导航细节已获批准，也不改变授权归属。
