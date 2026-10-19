> Archived design material, relocated from the former docs/design layout. See the [acceptance record](../README.md) for implemented scope and verification. Follow-up proposals, including Task recovery, are not shipped behavior.

# External connection navigation benchmark

Research date: October 14, 2026.

This note compares terminology, management entry points, and contextual use of external connections. It is a research record, not an approved OpenTag design or implementation plan.

## Evidence boundaries

The findings below come from opened first-party product, help, and API documentation. They have **not** been verified inside authenticated live accounts. Exact menu placement, localized labels, rollout availability, and visual styling can differ. Conflicting official navigation instructions are recorded explicitly rather than silently combined.

## Manus

### Naming and grouping

The current public feature page presents **Connectors** as the umbrella for app connectors, **Custom MCP**, and **Custom API**. GitHub appears alongside Gmail, Slack, and Google Workspace; custom connections are creation options within the same concept. The Chinese page uses **连接器**. This is direct evidence of a common user-facing category, independent of the setup mechanism. [English feature page](https://www.manus.im/features/connectors), [Chinese feature page](https://www.manus.im/zh-cn/features/connectors)

The feature page documents **Connectors → Create → Add MCP by URL**, with command or JSON alternatives, and **Connectors → Create → Custom API**. Its public launch link targets `/app?openConnectors=true`; this does not establish where the authenticated sidebar/menu places Connectors. [Connectors feature page](https://www.manus.im/features/connectors), [official Connectors launch link](https://www.manus.im/app?openConnectors=true)

Other official documentation says apps are selected in Manus settings, while the custom MCP guide says **Settings → Integrations → Custom MCP Servers → Add Server**. This conflicts with the public feature page's shorter Connectors creation flow; no claim is made that the settings route is the current universal live route. [MCP Connectors guide](https://manus.im/docs/integrations/mcp-connectors), [Custom MCP Servers guide](https://manus.im/docs/integrations/custom-mcp)

### GitHub authorization and task use

GitHub is documented as a built-in connector: connect it once, then use it in tasks. Setup begins in **Connectors → GitHub → Connect**. GitHub's Manus Connector app receives access to chosen repositories; **Configure** changes that selection. A task can choose an allowed repository through the GitHub menu in the chat box. Authorization and task repository selection are therefore separate steps within the same connector experience. [GitHub connector](https://www.manus.im/connectors/github)

The help center describes app sign-in or connector-specific credentials as setup, and removing a connector clears stored login information and credentials. This is a connection lifecycle, distinct from selecting a tool for a particular task. [Manus Connectors help](https://help.manus.im/en/articles/12231777-how-can-i-use-manus-connectors)

### User, project, and task scope

The API requires connector authorization in the web app before task use. At task creation, explicit connector IDs override project defaults, which override the user's default enabled connectors. An ongoing task can replace its connector list, clear it, or retain its existing list. These are documented contextual selection scopes; they are not evidence of separate OAuth identities per project. [API Connectors](https://open.manus.im/docs/v2/connectors)

The feature page also describes connecting and enabling recommended connectors in Projects, including publishing a custom MCP to Projects. It provides no evidence that a Project corresponds to OpenTag's persistent Agent or has its own independently authorized identity. [Connectors feature page](https://www.manus.im/features/connectors)

### Connectors versus integrations

The API documentation uses **Integrations** for bringing Manus into other workflow tools: starting tasks in Slack, receiving Slack notifications, or using Manus in Zapier. It says these are configured in workspace settings. This is a genuine directional distinction in that documentation: Manus calling external tools versus other tools invoking Manus. However, the public Connectors page also includes Slack task triggers, so the vocabulary is not an absolute product-wide boundary. [API Integrations overview](https://open.manus.im/docs/v2/integrations-overview), [Connectors feature page](https://www.manus.im/features/connectors)

## Claude

### Naming and entry points

The current primary help article groups directory services and custom remote MCP under **Connectors**, managed in **Customize → Connectors**. Chat offers **+** (or `/`) → **Connectors → Manage connectors**. Discovery, custom addition, disconnection, configuration, and permissions use this management area. [Use connectors to extend Claude's capabilities](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)

A separate official guide still links **Settings → Connectors**, whereas the current main article says **Customize → Connectors**. Treat Customize as the main documented path, with this inconsistency as a limitation; the exact global entry placement is not live-verified. The same guide distinguishes remote cloud/SaaS connectors from local **desktop extensions**, whose documented entry is **Claude Desktop → Settings → Extensions**. [When to use desktop and web connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)

### Authorization versus conversation enablement

Account authentication is separate from conversation enablement: connected services can be toggled in **+ → Connectors** per conversation. Team/Enterprise organization enablement ordinarily permits individual authentication rather than replacing it; enterprise-managed authentication is a documented exception. [Use connectors to extend Claude's capabilities](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)

The custom MCP guide confirms that remote connections are brokered through the Claude account, originate from Anthropic infrastructure, and can be enabled or disabled per conversation. Organization owners configure custom connector definitions, and members ordinarily connect individually. A fixed shared API credential instead gives users that credential's upstream access. These scopes must not be equated with OpenTag's independently authorized Agent mounts. [Custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

### Built-in GitHub has a contextual attachment flow

Claude's native GitHub integration is documented as repository context: in chat, **+ → Add from GitHub → select files/folders**; in Projects, **project knowledge + → GitHub → choose repository/files**. Project content offers **Sync** and **Configure files**. The article refers users to Connectors for account enablement, while retaining this task-specific import flow. It says the sync retrieves file names and contents for a branch, not commit history or pull-request metadata. A public GitHub App/repository authorization step may be needed for private repositories. This native attachment integration must not be assumed to have the same capabilities as an arbitrary GitHub MCP server. [Use the GitHub integration](https://support.claude.com/en/articles/10167454-use-the-github-integration)

## Interpretation for OpenTag

The following are design inferences, not competitor facts:

- Both products provide evidence for a common connector category that covers multiple setup mechanisms. They do not support inventing a new category solely because OpenTag's GitHub uses a different authorization model.
- Both distinguish establishing a connection from choosing what a conversation, task, or project can use. This is the stronger precedent than copying an account menu label.
- A contextual GitHub entry can offer repository selection or attachment while leading back to common connection management. A specialized use flow does not require a separate top-level service category.
- These products' user/project/conversation scopes do not directly answer how OpenTag should present persistent Agents with independent MCP credentials. OpenTag must preserve that difference in status, scope information, and management actions.
- Manus's inbound workflow Integrations category would correspond more closely to OpenTag messaging channels/triggers than to the fact that GitHub credentials are account-owned. It does not justify naming account-shared GitHub Integrations while naming Agent-owned MCP Connectors.

## ChatGPT comparison

### Current terminology and discovery

The current public ChatGPT Learn documentation describes a **Plugins** tab and a universal plugin directory shared with Codex. It groups catalog entries under OpenAI, the workspace, and Personal, with a separate Installed row. Plugins can bundle skills and MCP servers. This report uses the terminology in the documentation retrieved on the research date; it does not assume that older Apps or Connectors instructions describe the same rollout or surface. [Plugins](https://learn.chatgpt.com/docs/plugins)

The web product guide depicts **Customize → Plugins**, with Skills alongside Plugins. Its catalog example includes GitHub, Google Drive, Slack, and other services. This is an official product illustration, not a screenshot from an authenticated account observed in this research. [ChatGPT on the web](https://learn.chatgpt.com/docs/web)

### Installation, authorization, and use

The documented flow is to find a plugin, inspect it, install it, and authenticate a required MCP connection. Authentication can happen during installation or first use. A user then requests an outcome or explicitly invokes a plugin with `@`. Plugin removal and revoking an independently connected MCP integration are separate actions. These are distinct lifecycle steps within the plugin experience, not evidence that every connection belongs to a persistent Agent. [Plugins](https://learn.chatgpt.com/docs/plugins)

For dots, the documentation says that supported plugins installed and enabled for the account are available subject to their connection, permissions, and runtime environment. Existing ChatGPT app permissions apply to the dot. App access and connected computers are explicitly separate from messaging contact methods. This is a useful persistent-assistant comparison, but it does not establish a general per-Agent credential inventory like OpenTag's. [Connect computers and apps to your dot](https://learn.chatgpt.com/docs/dots/computers-and-apps)

### Managed connections

The enterprise flow has a separate, role-specific **Admin Console → Workspace connections** area. Administrators create named app-account connections and control who can discover, use, and manage them. Team or workflow owners then select an available connection for the intended surface. The documentation separates external-account permissions, role access, availability, and workflow selection. This supports distinguishing administration from contextual use; it does not justify adding an enterprise-style connection console to a personal account menu. [Workspace connections](https://learn.chatgpt.com/docs/enterprise/shared-connections)

## Cross-product synthesis and OpenTag decision

### What the sources establish

| Product | Documented management concept | Contextual use | Important boundary |
| --- | --- | --- | --- |
| ChatGPT | Plugins directory; managed Workspace connections for eligible enterprise workflows | Prompt or `@`; account-enabled plugins for dots; workflow connection selection | A plugin can include skills as well as service tools. |
| Manus | Connectors includes catalog apps, GitHub, Custom MCP, and Custom API | User defaults, Project defaults, task selection, and GitHub repository selection | A Project is not evidence of a persistent Agent with an independent identity. |
| Claude | Customize → Connectors, also reachable from chat | Conversation toggles; GitHub file import and project synchronization | Native GitHub attachments have a specialized use flow and limited documented data scope. |

Each row summarizes the product-specific sources above. All three distinguish discovery/connection management from use in a task or assistant context. Manus and Claude directly support a shared connector category across built-in and custom service mechanisms. ChatGPT's plugin category is broader because it also packages skills.

Manus also documents inbound workflow integrations, such as Slack or Zapier starting Manus tasks. Its public Connectors page includes some of those triggers too, so this is a useful functional distinction rather than a strict universal naming rule. It does not provide a precedent for classifying account-owned GitHub authorization as Integration while classifying Agent-owned MCP authorization as Connector.

### Design implications, not an approved decision

1. Keep a coherent external-service discovery and management concept. Different authentication mechanisms alone do not warrant different user-facing categories.
2. Describe the operation at the entry point: connecting or managing an account globally, enabling or using it for an Agent, or selecting a repository for a task. Reuse connection details where the same connection is involved.
3. Preserve OpenTag's actual authorization scopes. The task context describes account-shared GitHub and independently authorized MCP mounts per Agent; competitors' account-connected conversation tools do not prove that those scopes should change.
4. A global inventory of every Agent's independent credentials is an additional product proposal. These sources do not establish that it is necessary, that it should live in the bottom account menu, or that two identical navigation labels will be sufficiently clear.
5. Validate navigation using concrete tasks: connect GitHub from an Agent, restore GitHub access, connect Figma only for one Agent, identify the affected Agents before changing authorization, and return to work after managing a computer. The benchmark supports these workflow questions, not a final menu order.

The earlier discussion's labels, including Applications and services and Shared connectors, remain proposals. This research does not approve a label, menu hierarchy, authorization migration, or production change.

### Subsequently confirmed scope constraints

On October 14, 2026, the user explicitly accepted these two exclusions:

- Do not add an account-level, first-level Connectors navigation entry.
- Do not build an inventory that aggregates all Agents' credentials.

These constraints supersede the corresponding earlier proposals. They do not approve other navigation details or change authorization ownership.
