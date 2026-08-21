# Agent System Prompt

[English](../../design/agent-system-prompt.md)

状态：提案

最后更新：2026-08-21

## 决策

第一阶段只做 Client Runtime 精简：复用 Server 已有的 `platform` 与 `agent`
instruction 分层，编译为一段有大小上限的 prompt，并通过所选 Provider 原生的
system/developer instruction 通道注入。

本阶段明确不增加 OpenTag 控制面：不增加 Web 编辑器、CLI 参数、API 字段改名、
数据库 migration、Resource 模型、prompt 资源库或独立 revision。这些产品能力
后续再设计，不阻塞当前先把 Provider admission 做正确。

Agent Workspace 的根目录直接作为 Provider cwd。Client 只创建并校验这个私有根目录，
不管理其中的用户内容，不再放置控制文件、托管 `AGENTS.md` 或新的 workspace-state
record，也不提供旧目录的自动迁移能力。

## 范围

本阶段只负责：

- 确定性编译现有 platform 与 Agent instructions；
- 在公共 Agent Runtime factory 边界增加必填、不可变的 `systemPrompt`；
- 为 Codex、Claude Code 与内部 Pi conformance 实现 Provider-native 注入；
- 删除 managed `AGENTS.md` writer 与 Turn 中要求重读文件的提示；
- 把 cwd 设置为 `<workspace>/`，不检查或迁移其中的用户内容；
- 为 reconcile listener 失败增加脱敏诊断。

本阶段不修改 Server storage、effective snapshot schema、Agent API、Web/CLI 配置、
authorization、数据库数据或 Session instruction 语义。

## 为什么现有路径不合理

当前 Client 把 platform 与 Agent instructions 写入托管 `AGENTS.md`，把 Provider
cwd 设置为 `<workspace>/files/`，并要求每个 Turn 重新读取该文件。这形成了本机
OpenTag 控制面与数据面的拆分：

```text
<workspace>/
├── AGENTS.md 或 files/AGENTS.md  # OpenTag 控制文件
└── files/                        # Provider cwd 与用户文件
```

该结构不是 Provider 的要求，也不等价于 system prompt：

- context file 的发现行为因 Provider 与版本而异；
- 一些 Agent 不会主动加载该文件；
- workspace 内容可能重复或遮蔽它；
- Agent 行为配置被伪装成 repository context；
- 本地 workspace-state/hash recovery 形成第二套控制面，并会像 issue 101 一样
  阻塞 reconcile。

新建 Workspace 的目标结构只有一个根目录，不再生成托管 instruction file：

```text
<workspace>/  # Provider cwd 与声明的 Workspace 根目录
```

旧安装中已有的 `<workspace>/files/` 不会被移动或删除；在新 Client 看来，它只是
Workspace 根目录下的普通用户子目录。

## 权威分层

最终 prompt 保留现有两个 owner：

1. `platform`：Server 提供的固定 OpenTag 工作指令；
2. `agent`：Server snapshot 为单个 Agent 提供的 instructions。

Client 按上述顺序、使用明确 heading 编译。Session instructions、当前 IM
context、消息正文、有界 history 与附件仍是 Turn input；本阶段不把它们提升到
runtime system prompt。

System prompt 只用于引导模型行为，不是安全边界。Server authorization、
workspace policy、sandbox、approval policy、credential delivery 与 tool
admission 继续在 prompt 之外强制执行。

## 数据契约：不改 Server 与数据库

本阶段保持现有 effective snapshot 不变：

```ts
interface EffectiveRuntimeSnapshot {
  // 现有 revision、provider、model、execution、workspace 与 budget
  instructions: {
    platform: string;
    agent: string;
    session?: string;
  };
}
```

两层 managed instructions 已经进入 `agentConfigHash` 与 effective snapshot hash。
本次实现不把 `instructions` 改名为 `systemPrompt`，不新增 capability bit，也不做
数据库 migration。

编译后的 prompt 只作为 runtime input。不得把 prompt 正文新增到 log、trace、
metric、Provider diagnostics、Turn report、process environment variable 或新的
Client durable state。现有 effective snapshot 继续作为 recovery evidence。

## 公共 Agent Runtime 契约

Factory 边界增加一个必填字段：

```ts
interface CreateAgentRuntimeRequest {
  eventSink: AgentRuntimeEventSink;
  hostedTools?: AgentHostedTools;
  systemPrompt: string;
  workspace: AgentRuntimeWorkspace;
  policy: AgentRuntimePolicy;
  configuration?: AgentRunConfiguration;
}

interface ResumeAgentRuntimeRequest extends CreateAgentRuntimeRequest {
  binding: AgentRuntimeBinding;
}
```

`systemPrompt` 必须非空、有大小上限，并在一个 Provider Runtime 生命周期内保持
不可变。`AgentPromptRequest` 不能替换它。由于每个 Provider factory 都必须原生
接收或拒绝该字段，公共 Agent Runtime contract version 升级到 v2；Provider registry
在运行时拒绝任何非 v2 factory，不能只依赖 TypeScript 类型检查。

Session Runtime Manager 在 Provider create/resume 前根据 snapshot 编译一次，
不会把结果放入 Turn input 或 Workspace 文件。

## Provider 映射

详细机制与版本证据见
[Provider Prompt 注入机制调研](provider-prompt-injection-research.md)。

| Provider | 原生映射 | 必须满足的行为 |
| --- | --- | --- |
| Codex | 在 `thread/start` 与 `thread/resume` 传 `developerInstructions` | 保留 Codex base instructions；绝不设置 `baseInstructions`。 |
| Claude Code | 每次进程调用（包括 `--resume`）传一个 `--append-system-prompt <value>` | 保留 Provider 默认 prompt，并在每次调用重新注入 managed payload。 |
| Pi | 每次 RPC 进程调用传一个 `--append-system-prompt <value>` | 仅内部 conformance；继续禁用 ambient context files。 |
| 未来 Provider | 经评审的原生 system/developer instruction 通道 | 无法证明同等优先级和 resume 行为时拒绝创建。 |

本机 Codex App Server 0.148 schema 在 start 与 resume 都暴露
`baseInstructions` 和 `developerInstructions`。OpenTag 使用
`developerInstructions`，因为 managed prompt 是补充 Provider 行为，不是替换
Provider 自己的工作 prompt。

Claude Code 与 Pi 原有的 Provider-specific `appendSystemPrompt` 配置被删除。Provider
configuration 中出现该字段会以 unknown field fail closed。Adapter 只生成一个
`--append-system-prompt` flag，其值严格等于公共 runtime request 的 `systemPrompt`；
不存在第三个同优先级 prompt authority，也不允许 Turn override。

## Runtime 更新语义

本阶段不新增更新流程，继续由 existing effective-snapshot fencing 管理：

1. platform 或 Agent instruction 变化会改变 effective snapshot hash；
2. 已 admission 的 Turn 使用不可变旧 snapshot 完成；
3. reconciliation 关闭旧 Provider Runtime；
4. Provider binding 只有属于同一 effective snapshot 时才会复用；
5. 下一个 Runtime create/resume 收到新编译的 prompt。

Client 不再读取本地 Agent workspace revision state，因此 platform 文本变化不会再被
旧 `managedInstructionsHash` 卡住 reconcile。仅为了替换 instruction carrier，本阶段
不需要数据库 revision bump。

## 后续补充 OpenTag 控制面

本阶段不在 Agent detail、Web、CLI 或新 API 中暴露 **System prompt**，继续消费
Server 现有 Agent instruction 值。后续产品设计可以再补编辑入口、字段命名、
authorization、optimistic concurrency、API 术语与必要的数据库 migration。

后续工作不得重新把 Workspace 文件作为 runtime authority，并且必须保持本文定义
的 provider-neutral factory contract。

## Workspace 边界

新 Agent 只创建：

```text
${OPENTAG_HOME}/data/workspaces/<agent-key>/
```

该私有目录直接作为 Provider cwd，并作为 runtime request 中声明的 Workspace 根目录。
Client 不再创建 `files/`、托管 `AGENTS.md` 或
`data/runtime/workspace-states/<agent-key>.json`。

本阶段 OpenTag 不管理 Workspace 内容：

- 不扫描、移动、重命名或删除任何 entry；
- 不根据文件名、header、权限或 hash 判断 ownership；
- 不读取旧 workspace-state record；
- 不把旧 `<workspace>/files/` 当成特殊布局，也不 fallback 为 cwd。

因此，旧 `files/` 和任何旧 `AGENTS.md` 都会原样保留。它们可能被 Provider 当作普通
repository context，但不是 OpenTag managed system prompt。如需整理旧目录，用户应先
备份并手动操作。

## 可观测性

Business-frame listener 失败只记录：

- 固定 category `listener`；
- frame type；
- `runtime_storage_conflict` 等有界 error category。

不得记录 frame payload、prompt 正文、credentials、原始 exception object 或
secret-bearing context。这样既能定位 issue 101 一类 reconcile 失败，也不会扩大
日志边界。

## 兼容与发布

Wire snapshot 没有变化，所以本阶段不要求新增 Server capability 或 Runtime
protocol version。发布只涉及 Client：

1. 发布包含公共 factory contract v2 与全部 built-in Provider mapping 的 Client；
2. 重启 daemon，让所有 Session Runtime 通过新路径重建；
3. 不自动修改任何现有 Workspace 内容。

旧 Client 继续使用 `<workspace>/files/` 作为 cwd；新 Client 使用 `<workspace>/`。
在版本之间切换会改变 Provider 可见的 cwd，OpenTag 不自动搬运或合并内容，用户必须
自行备份并整理。新 Client 在无法使用 Provider-native admission 时绝不 fallback 到
managed Workspace 文件，而是由 Provider fail closed。

## 验证

必须覆盖：

- 新 Agent 得到空的 flat cwd，不存在 `AGENTS.md` 或 `files/`；
- 同一 Agent 的 Session 共享同一根目录，不同 Agent 仍隔离；
- 已有 `files/`、`AGENTS.md` 与其他用户 entry 原样保留；
- 不读取 obsolete workspace state；
- 公共 request 拒绝缺失、全空白与超限 system prompt；
- Provider registry 拒绝 contract v1 或其他非 v2 factory；
- Claude Code 与 Pi 拒绝 Provider-specific prompt 字段；
- Codex create/resume 都包含 `developerInstructions`，且不覆盖
  `baseInstructions`；
- Claude Code 与 Pi invocation 都恰好包含一个合并后的
  `--append-system-prompt` 值；
- Session instructions 仍位于 Turn input；
- prompt 正文不进入 telemetry；
- listener error 只包含脱敏后的 frame/error category。

Provider smoke test 后续应使用一个只存在于 managed system prompt 的 sentinel，
并从模型行为观察到它。仅断言 JSON-RPC params 或 argv 的 unit test 能证明
transport construction，但不能证明模型实际 admission。

## 验收标准

以下条件满足时，本阶段完成：

- Provider cwd 是 Agent Workspace 根目录；
- Client 不在 Workspace 内创建或读取 OpenTag 托管的 instruction/control file；
- Client 不修改任何已有 Workspace entry；
- Client 在 create/resume 时把 platform 与 Agent instructions 映射到本文所列
  Codex 与 Claude Code 原生高优先级 request surface；
- 所有 built-in Provider factory 都强制执行公共 immutable prompt contract；
- Session input 与安全 enforcement 语义不变；
- 不需要 Server、API、Web、CLI 或数据库 mutation。
