# Provider Prompt 注入机制调研

[English](../../design/provider-prompt-injection-research.md)

状态：调研完成

最后核验：2026-08-21

## 结论

OpenTag 可以为所有 Provider adapter 定义同一语义契约：通过 Provider 原生的
高优先级通道追加编译后的 OpenTag Agent system prompt，同时保留 Provider
自带的工作 prompt。

具体映射如下：

| Provider | OpenTag 状态 | 推荐注入方式 | 原因 |
| --- | --- | --- | --- |
| Codex | 原生映射已实现；版本 admission 留作后续 | 在 `thread/start` 与 `thread/resume` 都传 `developerInstructions` | 它以独立 developer message 补充 base instructions。 |
| Claude Code | 原生映射已实现；版本 admission 留作后续 | 每次启动进程（包括 `--resume`）都传一个内联 `--append-system-prompt <value>` | Append 会保留 Claude Code 默认的工具、安全与编码指导。 |
| Pi | 仅内部一致性实现 | 每次 RPC 进程启动都传一个内联 `--append-system-prompt <value>` | 保留 Pi 生成的工具 prompt；OpenTag 已禁用 ambient resources 与 extensions。 |

OpenTag 不应使用 `baseInstructions`、`--system-prompt`、`SYSTEM.md`、
`model_instructions_file`、`AGENTS.md` 或 `CLAUDE.md` 承载 Agent prompt。
这些机制要么替换 Provider 自有行为，要么依赖环境文件，要么注入的是 repository
context，而不是 Agent runtime authority。

## 范围与证据快照

当前 production Provider registry 只有 `codex` 与 `claude-code`。Pi 在 Client
中只用于 runtime contract conformance，不出现在产品选择中。

本调研同时核对了 Provider 一手文档、本机 CLI/schema 与当前 OpenTag adapter：

| Provider | 本机核验版本 | 主要集成面 | 当前 adapter 状态 |
| --- | --- | --- | --- |
| Codex | `codex-cli 0.148.0` | App Server v2 JSON-RPC | 公共 `systemPrompt` 在 start/resume 映射为 `developerInstructions`。 |
| Claude Code | `2.1.210` | CLI stream JSON | 公共 `systemPrompt` 映射为一个 `--append-system-prompt`；Provider-specific prompt 字段被拒绝。 |
| Pi | `0.83.0` | CLI RPC mode | 公共 `systemPrompt` 映射为一个 `--append-system-prompt`；Provider-specific prompt 字段被拒绝；未进入生产。 |

Provider CLI 与协议都是有版本的依赖。Provider 版本 admission、capability
上报与模型级 sentinel smoke test 明确留作后续；本阶段不增加 capability bit，
只证明上表所述的原生 transport mapping。

## 机制分类

现有注入机制分四类，不能混用：

1. **Native request-scoped instruction**：为单个 Provider session 提供的
   system/developer 字段或 flag；它才是 OpenTag Agent prompt 的载体。
2. **Provider-base replacement**：替换 Provider 内建 identity、tool guidance，
   甚至 safety guidance；OpenTag 不需要这一能力。
3. **Ambient configuration**：全局配置、项目文件或自动发现的 instruction
   files；无法做到每个 Agent 独立，不适合作为 runtime authority。
4. **Turn input**：用户消息与注入到 conversation 的项目上下文；其权限与
   生命周期语义不同。

“Append”是跨 Provider 的产品语义，并不表示底层 wire role 完全相同：Codex
接收 developer message，Claude Code 与 Pi 则扩展各自的 system prompt。

## Codex

### 原生 App Server 字段

Codex App Server 文档要求从已安装 CLI 生成 schema，因为生成结果与该 CLI
版本精确对应。从 `codex-cli 0.148.0` 生成的 schema 显示：
`ThreadStartParams` 与 `ThreadResumeParams` 都有 nullable 的
`baseInstructions` 和 `developerInstructions`。

Codex 源码进一步说明：

- `baseInstructions` 是 base-instruction override；
- `developerInstructions` 作为独立 developer-role message 注入，用于补充
  base instructions。

因此 OpenTag 应在 `thread/start` 与 `thread/resume` 都发送：

```json
{
  "developerInstructions": "<编译后的 OpenTag platform + Agent prompt>"
}
```

并省略 `baseInstructions`。App Server 支持 resume 时传 configuration override，
但 OpenTag 应显式重传同一份 immutable prompt，而不是依赖未承诺的持久化行为。
如果 App Server 只是重新接入一个仍在运行的 thread，resume override 可能被
忽略，因此 OpenTag 必须继续独占 Provider Runtime，并用测试验证精确行为。

### Codex 的其他机制

| 机制 | 语义 | OpenTag 用法 |
| --- | --- | --- |
| App Server `developerInstructions` | Request-scoped 补充 developer instructions | **使用** |
| App Server `baseInstructions` | 替换 base instructions | 不使用 |
| Codex config `developer_instructions` | 来自环境配置的附加 developer instructions | 不作为 per-Agent authority |
| `model_instructions_file` | 从文件替换内建 instructions | 不使用 |
| `AGENTS.md` | 自动发现的项目 instructions | 只保留为 repository context |
| Turn input | 用户与 conversation 内容 | 绝不作为 system-prompt fallback |

使用 App Server 字段无需修改 `CODEX_HOME`、写临时 instruction file，也不会让
一个 Agent 的配置泄漏到另一个 Agent session。

### OpenTag 实现

`packages/client/src/providers/codex/agent-runtime.ts` 接收公共 immutable
`systemPrompt`，并在 create 与 resume 请求中都将其作为
`developerInstructions` 发送，不设置 `baseInstructions`。

## Claude Code

### 原生 CLI flags

Claude Code 文档给出四个仅对本次 invocation 生效的 system-prompt flags：

| Flag | 语义 | OpenTag 用法 |
| --- | --- | --- |
| `--append-system-prompt` | 把内联文本追加到默认 prompt | **使用** |
| `--append-system-prompt-file` | 追加文件内容 | 避免引入 path、lifecycle 与 cleanup authority |
| `--system-prompt` | 替换完整默认 prompt | 不使用 |
| `--system-prompt-file` | 用文件内容替换完整默认 prompt | 不使用 |

Anthropic 明确说明：append 会保留默认 tool guidance、safety instructions 与
coding conventions；replacement 会全部丢弃。Agent SDK 提供等价的安全形式：
`claude_code` preset 加 `append`。若 OpenTag 将来从 CLI 切换到 SDK，应使用这一
映射。

四个 CLI flag 都只对当前 invocation 生效。OpenTag 在后续 Turn 会再次启动
Claude Code 并使用 `--resume`，因此每次都必须传同一份
`--append-system-prompt`。若只在首次创建 Provider session 时传入，resume process
会静默丢失 Agent 的配置行为。

`CLAUDE.md` 不等价：Agent SDK 文档说明它作为 project context 注入
conversation，而不进入 system prompt。`--agents` 只配置 Claude subagents，与
OpenTag root Agent prompt 无关。

### OpenTag 实现

`packages/client/src/providers/claude-code/agent-runtime.ts` 接收公共 immutable
`systemPrompt`，并在 create/resume invocation 中恰好生成一个
`--append-system-prompt` 值。Provider-specific prompt 字段作为 unknown 被拒绝，
不能覆盖 managed 值。

## Pi

### 原生与 ambient 机制

Pi 同时提供 replacement 与 append：

| 机制 | 语义 | OpenTag 用法 |
| --- | --- | --- |
| `--append-system-prompt` | 追加到生成的 system prompt，可重复 | **用于内部 conformance** |
| `--system-prompt` | 替换默认 prompt；之后仍可能追加 context files 与 skills | 不使用 |
| `APPEND_SYSTEM.md` | 追加 project/global 文件内容 | 不使用 |
| `SYSTEM.md` | 替换 project/global 默认 prompt | 不使用 |
| `AGENTS.md` / `CLAUDE.md` | 自动发现的 project context | Managed run 中禁用 |
| `before_agent_start` extension | 可按 Turn 替换 assembled prompt | Managed run 中禁用 |

Pi 的 prompt builder 顺序是：Provider default 或 custom prompt、append text、
project context、skills、current directory。因此只传 append flag 仍不足以隔离
开启状态下的 ambient resources。

OpenTag 已经用 `--no-extensions`、`--no-skills`、`--no-prompt-templates`、
`--no-themes`、`--no-context-files` 与 `--no-approve` 启动 Pi；当前 adapter 也已
支持内联 `--append-system-prompt`。两者结合，构成确定性的内部 conformance
路径，不允许项目文件或 extension 修改 managed prompt。

Pi 在完整 Provider admission gate 通过前必须继续排除在 production capability
之外。支持 prompt 注入本身不代表可进入生产。

## 跨 Provider Runtime 契约

Provider-neutral 字段应在一个 Provider Runtime 生命周期内保持 immutable：

```ts
interface AgentRuntimeConfiguration {
  model?: string;
  reasoningEffort?: string;
  systemPrompt: string;
  provider?: JsonValue;
}
```

Client 确定性组合 Server-owned platform 层与 Agent-owned 层，校验 byte limit，
再把一份完全一致的字符串传给 adapter。`AgentPromptRequest` 不能覆盖它。
Provider-specific JSON 不得再保留 prompt 字段，否则会产生互相竞争的 authority，
并让各 Provider 语义分叉。

Prompt 不进入 environment variable、command log、diagnostics、trace、Turn report
或 workspace file。Claude Code 与 Pi 使用 CLI 参数，正文不可避免地可能被本机
process table 看见，因此 managed Computer 属于 trust boundary。未来改用 SDK/IPC
可以降低这一暴露，但不改变产品契约。

## Resume 与更新语义

| 事件 | Provider 动作 |
| --- | --- |
| Process 重启，但 Agent prompt 未变 | Resume 精确 Provider binding，并再次注入同一 prompt。 |
| Agent prompt 更新，且没有 active Turn | 关闭旧 Runtime、丢弃 Provider binding；下个 Turn 新建 Provider session。 |
| Active Turn 期间更新 Agent prompt | 已 admission 的 Turn 用旧 snapshot 完成，随后 reconcile 并替换 Runtime。 |

Codex 与 Claude Code 虽然技术上都能在 resume 时接受 prompt，但 OpenTag 不应让
一个 conversation 跨越两套 Agent system prompt。prompt 变化时新建 session 是
OpenTag 的一致性规则，不是 Provider 的能力限制。

## 后续 Admission 与验证

如果 OpenTag 后续上报 `runtime.agentSystemPrompt@1` 一类 capability，只有精确
本机 Provider 版本满足以下条件时才能上报：

- create 与 exact-resume 都有原生注入通道；
- 未使用 replacement 字段或 ambient file fallback；
- 同一 prompt 值恰好注入一次；
- E2E smoke test 使用只存在于 system prompt 的 sentinel，并能从模型行为观察到；
- OpenTag log、diagnostics 与持久 Run/Turn record 都不包含 prompt 正文；
- 不支持的版本以 `configuration_unsupported` 或 typed readiness issue fail closed。

仅断言 JSON-RPC params 或 argv 的 unit test 必须有，但并不充分：它只能证明
transport construction，不能证明模型实际 admission。

这些检查不是本文实现阶段的发布门槛。在后续 admission contract 建立之前，
Provider readiness 保持当前产品含义，不能被解释为模型级 system-prompt
admission 的证明。

## 一手来源

- OpenAI：[Codex App Server](https://developers.openai.com/codex/app-server/)、
  [Codex configuration reference](https://developers.openai.com/codex/config-reference/)、
  [Codex session configuration source](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/session.rs)
- Anthropic：[Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)、
  [Agent SDK system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- Pi：[usage reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md)、
  [system-prompt builder](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts)、
  [extension prompt hooks](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
