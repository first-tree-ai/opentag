# Provider Prompt Injection Research

[简体中文](../zh-CN/design/provider-prompt-injection-research.md)

Status: research complete

Last verified: 2026-08-21

## Conclusion

OpenTag can give its Provider adapters one common semantic contract: append the
compiled OpenTag Agent system prompt through a native, high-priority Provider
channel while preserving the Provider's built-in operating prompt.

The concrete mappings are:

| Provider | OpenTag status | Recommended injection | Why |
| --- | --- | --- | --- |
| Codex | Native mapping implemented; version admission is follow-up work | `developerInstructions` on both `thread/start` and `thread/resume` | It supplements the base instructions as a separate developer message. |
| Claude Code | Native mapping implemented; version admission is follow-up work | One inline `--append-system-prompt <value>` on every process invocation, including `--resume` | Append preserves Claude Code's default tool, safety, and coding guidance. |
| Pi | Internal conformance only | One inline `--append-system-prompt <value>` on every RPC process invocation | It preserves Pi's generated tool prompt; ambient resources and extensions are already disabled by OpenTag. |

OpenTag must not use `baseInstructions`, `--system-prompt`, `SYSTEM.md`,
`model_instructions_file`, `AGENTS.md`, or `CLAUDE.md` as the Agent prompt
carrier. Those mechanisms either replace Provider-owned behavior, depend on
ambient files, or inject repository context rather than the Agent's runtime
authority.

## Scope and Evidence Snapshot

The production Provider registry currently contains only `codex` and
`claude-code`. Pi exists in the Client as an internal contract-conformance
implementation and is not selectable in the product.

This research combines Provider primary documentation, installed CLI/schema
inspection, and the current OpenTag adapters:

| Provider | Locally inspected version | Primary integration surface | Current adapter state |
| --- | --- | --- | --- |
| Codex | `codex-cli 0.148.0` | App Server v2 JSON-RPC | The common `systemPrompt` maps to `developerInstructions` on start and resume. |
| Claude Code | `2.1.210` | CLI stream JSON | The common `systemPrompt` maps to one `--append-system-prompt`; Provider-specific prompt fields are rejected. |
| Pi | `0.83.0` | CLI RPC mode | The common `systemPrompt` maps to one `--append-system-prompt`; Provider-specific prompt fields are rejected; not production-admitted. |

Provider CLI and protocol surfaces are versioned dependencies. Provider-version
admission, capability advertising, and model-level sentinel smoke tests are
explicit follow-up work; this phase adds no capability bit and proves only the
native transport mapping described above.

## Mechanism Classes

The available mechanisms fall into four classes that must not be conflated:

1. **Native request-scoped instruction**: a system/developer field or flag for
   one Provider session. This is the OpenTag Agent prompt carrier.
2. **Provider-base replacement**: replaces the Provider's built-in identity,
   tool guidance, and possibly safety guidance. OpenTag does not need this.
3. **Ambient configuration**: global config, project files, or auto-discovered
   instruction files. These are not isolated per Agent and are unsuitable as
   runtime authority.
4. **Turn input**: user messages and project context injected into the
   conversation. These have different authority and lifecycle semantics.

"Append" is the cross-Provider product semantic. It does not mean the same
wire-level role on every Provider: Codex receives a developer message, while
Claude Code and Pi extend their system prompts.

## Codex

### Native App Server fields

The Codex App Server documentation instructs integrators to generate schemas
from the installed CLI because the output is exact to that CLI version. The
schema generated from `codex-cli 0.148.0` exposes nullable
`baseInstructions` and `developerInstructions` fields on both
`ThreadStartParams` and `ThreadResumeParams`.

Codex source describes their semantics more precisely:

- `baseInstructions` is a base-instruction override;
- `developerInstructions` is injected as a separate developer-role message
  and supplements the base instructions.

OpenTag should therefore send:

```json
{
  "developerInstructions": "<compiled OpenTag platform + Agent prompt>"
}
```

on both `thread/start` and `thread/resume`, and omit `baseInstructions`.
App Server supports configuration overrides on resume, but OpenTag should pass
the same immutable prompt explicitly rather than depend on undocumented
persistence. A running thread can ignore resume overrides when App Server is
only rejoining it, so the OpenTag lifecycle must continue to own one exclusive
Provider Runtime and test exact behavior.

### Other Codex mechanisms

| Mechanism | Semantics | OpenTag use |
| --- | --- | --- |
| App Server `developerInstructions` | Request-scoped supplemental developer instructions | **Use** |
| App Server `baseInstructions` | Replaces the base instructions | Do not use |
| `developer_instructions` in Codex config | Additional developer instructions from ambient Client configuration | Do not use for per-Agent authority |
| `model_instructions_file` | Replaces built-in instructions from a file | Do not use |
| `AGENTS.md` | Discovered project instructions | Keep as repository context only |
| Turn input | User/conversation content | Never use as a system-prompt fallback |

Using the App Server field avoids mutating `CODEX_HOME`, writing a temporary
instruction file, or allowing one Agent's configuration to leak into another
Agent session.

### OpenTag implementation

`packages/client/src/providers/codex/agent-runtime.ts` accepts the common
immutable `systemPrompt` and sends it as `developerInstructions` on both create
and resume requests without setting `baseInstructions`.

## Claude Code

### Native CLI flags

Claude Code documents four per-invocation system-prompt flags:

| Flag | Semantics | OpenTag use |
| --- | --- | --- |
| `--append-system-prompt` | Appends inline text to the default prompt | **Use** |
| `--append-system-prompt-file` | Appends file contents | Avoid path, lifecycle, and cleanup authority |
| `--system-prompt` | Replaces the entire default prompt | Do not use |
| `--system-prompt-file` | Replaces the entire default prompt with file contents | Do not use |

Anthropic explicitly notes that append preserves default tool guidance, safety
instructions, and coding conventions, while replacement drops them. The Agent
SDK exposes the same safe shape as the `claude_code` preset with an `append`
value. If OpenTag later moves from the CLI to the SDK, that preset is the
equivalent mapping.

All four CLI flags apply only to the current invocation. OpenTag launches
Claude Code again for later turns and uses `--resume`, so it must pass the same
`--append-system-prompt` value on every invocation. Passing it only when the
Provider session is first created would silently lose the configured behavior
on a resumed process.

`CLAUDE.md` is not equivalent: the Agent SDK documentation says it is injected
into the conversation as project context, not into the system prompt. The
`--agents` flag also configures Claude subagents and is unrelated to the root
OpenTag Agent prompt.

### OpenTag implementation

`packages/client/src/providers/claude-code/agent-runtime.ts` accepts the common
immutable `systemPrompt` and emits exactly one `--append-system-prompt` value
for create and resume invocations. Provider-specific prompt fields are rejected
as unknown and cannot override the managed value.

## Pi

### Native and ambient mechanisms

Pi exposes both replacement and append mechanisms:

| Mechanism | Semantics | OpenTag use |
| --- | --- | --- |
| `--append-system-prompt` | Appends text to the generated system prompt; repeatable | **Use for conformance** |
| `--system-prompt` | Replaces the default prompt; context files and skills can still be appended | Do not use |
| `APPEND_SYSTEM.md` | Appends project/global file content | Do not use |
| `SYSTEM.md` | Replaces the project/global default prompt | Do not use |
| `AGENTS.md` / `CLAUDE.md` | Auto-discovered project context | Disable in managed runs |
| `before_agent_start` extension | Can replace the assembled prompt for a turn | Disable in managed runs |

Pi's prompt builder orders the content as Provider default or custom prompt,
then append text, then project context, skills, and the current directory. That
ordering means an append flag alone is not sufficient isolation when ambient
resources are enabled.

OpenTag already launches Pi with `--no-extensions`, `--no-skills`,
`--no-prompt-templates`, `--no-themes`, `--no-context-files`, and
`--no-approve`. The current adapter also supports an inline
`--append-system-prompt`. Together these provide a deterministic internal
conformance path without allowing project files or extensions to alter the
managed prompt.

Pi must remain outside the production capability advertisement until the full
Provider admission gate is satisfied. Prompt support alone is not production
admission.

## Cross-Provider Runtime Contract

The Provider-neutral field should be immutable for one Provider Runtime:

```ts
interface AgentRuntimeConfiguration {
  model?: string;
  reasoningEffort?: string;
  systemPrompt: string;
  provider?: JsonValue;
}
```

The Client deterministically combines the Server-owned platform layer and the
Agent-owned layer, validates the byte bound, and sends one exact string to the
adapter. `AgentPromptRequest` cannot override it. Provider-specific JSON must
not contain another prompt field, because that would create competing
authorities and different semantics by Provider.

The prompt is not placed in process environment variables, command logs,
diagnostics, traces, Turn reports, or workspace files. CLI arguments are
unavoidably visible to the local process table for Claude Code and Pi; the
managed Computer is therefore part of the trust boundary. A future SDK/IPC
transport could reduce that exposure, but does not change the product
contract.

## Resume and Update Semantics

| Event | Provider action |
| --- | --- |
| Process restart with the same immutable Agent prompt | Resume the exact Provider binding and inject the same prompt again. |
| Agent prompt changes while no Turn is active | Close the old Runtime, discard its Provider binding, and create a fresh Provider session on the next Turn. |
| Agent prompt changes during an active Turn | Let the admitted Turn finish against its old snapshot, then reconcile and replace the Runtime. |

Although Codex and Claude Code technically accept prompt values during resume,
OpenTag should not continue one conversation under two Agent system prompts.
Fresh-session-on-change is an OpenTag consistency rule, not a limitation of
those Providers.

## Future Admission and Verification

If OpenTag later advertises a capability such as
`runtime.agentSystemPrompt@1`, it must do so only after all of these checks pass
for the exact local Provider version:

- native create and exact-resume injection are available;
- replacement fields and ambient file fallbacks are absent;
- one prompt value is injected exactly once;
- a sentinel present only in the system prompt changes observable model
  behavior in an end-to-end smoke test;
- prompt text is absent from OpenTag logs, diagnostics, and durable Run/Turn
  records; and
- unsupported versions fail closed with `configuration_unsupported` or a typed
  readiness issue.

Unit assertions on JSON-RPC params or argv are required but not sufficient;
they prove transport construction, not model admission.

These checks are not release gates for the implementation in this document.
Until the follow-up admission contract exists, Provider readiness retains its
current product meaning and must not be interpreted as proof of model-level
system-prompt admission.

## Primary Sources

- OpenAI: [Codex App Server](https://developers.openai.com/codex/app-server/),
  [Codex configuration reference](https://developers.openai.com/codex/config-reference/),
  and [Codex session configuration source](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/session.rs)
- Anthropic: [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
  and [Agent SDK system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- Pi: [usage reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md),
  [system-prompt builder](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts),
  and [extension prompt hooks](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
