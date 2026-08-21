# Agent System Prompt

[简体中文](../zh-CN/design/agent-system-prompt.md)

Status: proposed

Last updated: 2026-08-21

## Decision

The first implementation is a Client Runtime simplification. It reuses the
existing Server-authored `platform` and `agent` instruction layers, compiles
them into one bounded prompt, and injects that prompt through the selected
Provider's native system/developer-instruction channel.

This phase deliberately adds no OpenTag control surface. It does not add a Web
editor, CLI flags, API field rename, database migration, Resource model, prompt
library, or prompt-specific revision. Those product capabilities can be
designed later without blocking correct Provider admission now.

The Agent Workspace root is the Provider cwd. The Client only provisions and
validates that private root; it does not manage user content inside it, place a
control file or managed `AGENTS.md`, create a new workspace-state record, or
provide automatic migration of an older layout.

## Scope

This phase owns only:

- deterministic compilation of existing platform and Agent instructions;
- a required, immutable `systemPrompt` field at the common Agent Runtime
  factory boundary;
- Provider-native injection for Codex, Claude Code, and internal Pi
  conformance;
- removal of the managed-`AGENTS.md` Turn reminder and file writer;
- a `<workspace>/` cwd without inspecting or migrating user content; and
- sanitized reconcile-listener diagnostics.

It does not change Server storage, effective-snapshot schemas, Agent APIs,
Web/CLI configuration, authorization, database data, or Session instruction
semantics.

## Why the Existing Path Is Wrong

The current Client writes platform and Agent instructions to a managed
`AGENTS.md`, places the Provider cwd under `<workspace>/files/`, and tells each
Turn to reload the file. This creates a local OpenTag control/data split:

```text
<workspace>/
├── AGENTS.md or files/AGENTS.md  # OpenTag control file
└── files/                        # Provider cwd and user files
```

That split is not a Provider requirement and is not equivalent to a system
prompt:

- context-file discovery differs by Provider and version;
- some Agents do not proactively load the file;
- workspace content can duplicate or shadow it;
- Agent behavior is represented as repository context; and
- local workspace-state/hash recovery becomes a second control plane that can
  block reconcile, as seen in issue 101.

A newly created Workspace has one root and no managed instruction file:

```text
<workspace>/  # Provider cwd and declared Workspace root
```

An existing `<workspace>/files/` directory is neither moved nor removed. The
new Client treats it as an ordinary user-owned subdirectory of the Workspace
root.

## Authority Layers

The effective prompt keeps two existing owners:

1. `platform`: fixed OpenTag operating instructions supplied by the Server;
2. `agent`: instructions for one Agent supplied by the Server snapshot.

The Client compiles them in that order with explicit headings. Session
instructions, current IM context, message text, bounded history, and
attachments remain Turn input. They are not promoted into the runtime system
prompt in this phase.

System prompts guide model behavior; they are not a security boundary. Server
authorization, workspace policy, sandboxing, approval policy, credential
delivery, and tool admission continue to be enforced outside the prompt.

## Data Contract: No Server or Database Change

This phase keeps the current effective snapshot unchanged:

```ts
interface EffectiveRuntimeSnapshot {
  // existing revision, provider, model, execution, workspace, and budget
  instructions: {
    platform: string;
    agent: string;
    session?: string;
  };
}
```

Both managed layers already participate in `agentConfigHash` and the effective
snapshot hash. There is no rename from `instructions` to `systemPrompt`, no
new capability bit, and no database migration in this implementation.

The compiled prompt is runtime input only. Prompt text must not be added to
logs, traces, metrics, Provider diagnostics, Turn reports, process environment
variables, or new durable Client state. Existing effective snapshots remain
the recovery evidence.

## Common Agent Runtime Contract

The factory boundary adds one required field:

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

`systemPrompt` is non-empty, bounded, and immutable for one Provider Runtime.
`AgentPromptRequest` cannot replace it. The common Agent Runtime contract
version advances to v2 because every Provider factory must either admit this
field natively or reject creation. The Provider registry rejects every non-v2
factory at runtime; TypeScript compatibility alone is not the admission gate.

The Session Runtime Manager compiles the snapshot immediately before Provider
create/resume. It never places the compiled value in Turn input or a Workspace
file.

## Provider Mapping

Detailed mechanism and version evidence is recorded in
[Provider Prompt Injection Research](provider-prompt-injection-research.md).

| Provider | Native mapping | Required behavior |
| --- | --- | --- |
| Codex | `developerInstructions` on `thread/start` and `thread/resume` | Preserve Codex base instructions; never set `baseInstructions`. |
| Claude Code | One `--append-system-prompt <value>` on every process invocation, including `--resume` | Preserve the Provider default prompt and inject the managed payload again on every invocation. |
| Pi | One `--append-system-prompt <value>` on every RPC process invocation | Internal conformance only; ambient context files remain disabled. |
| Future Provider | Reviewed native system/developer instruction channel | Reject creation when equivalent priority and resume behavior cannot be proven. |

The installed Codex App Server 0.148 schema exposes both
`baseInstructions` and `developerInstructions` on start and resume. OpenTag
uses `developerInstructions` because the managed prompt supplements Provider
behavior instead of replacing the Provider's own operating prompt.

The former Provider-specific `appendSystemPrompt` configuration for Claude Code
and Pi is removed. A Provider configuration containing that field fails closed
as unknown. Each adapter emits exactly one `--append-system-prompt` flag whose
value is exactly the common runtime request's `systemPrompt`; there is no third
same-priority prompt authority and no Turn override.

## Runtime Update Semantics

No new update flow is introduced. Existing effective-snapshot fencing owns
the behavior:

1. a changed platform or Agent instruction changes the effective snapshot
   hash;
2. an admitted Turn completes against its immutable old snapshot;
3. reconciliation closes the old Provider Runtime;
4. a binding is reused only when it belongs to the same effective snapshot;
5. the next Runtime create/resume receives the newly compiled prompt.

The Client no longer reads local Agent workspace revision state, so a
platform-text change no longer wedges reconcile behind a stale
`managedInstructionsHash`. This phase therefore requires no database revision
bump merely to replace the instruction carrier.

## Deferred OpenTag Control Surface

This phase does not expose **System prompt** in Agent detail, Web, CLI, or a
new API. It continues to consume the Server's existing Agent instruction
value. A later product design may add editing, naming, authorization,
optimistic concurrency, API terminology, and any required database migration.

That later work must not reintroduce Workspace files as runtime authority and
must preserve the provider-neutral factory contract defined here.

## Workspace Boundary

For a new Agent, the Client creates only:

```text
${OPENTAG_HOME}/data/workspaces/<agent-key>/
```

That directory is private, is returned as Provider cwd, and is declared as the
Workspace root in the runtime request. The Client no longer creates `files/`, a
managed `AGENTS.md`, or
`data/runtime/workspace-states/<agent-key>.json`.

OpenTag does not manage Workspace content in this phase:

- it does not scan, move, rename, or delete entries;
- it does not infer ownership from names, headers, permissions, or hashes;
- it does not read the old workspace-state record; and
- it does not treat an existing `<workspace>/files/` as a special layout or
  fall back to it as cwd.

Existing `files/` directories and `AGENTS.md` files therefore remain untouched.
A Provider may still discover them as ordinary repository context, but they are
not the OpenTag-managed system prompt. Users must back up and reorganize an old
layout manually if desired.

## Observability

A business-frame listener failure logs only:

- the fixed category `listener`;
- the frame type; and
- a bounded error category such as `runtime_storage_conflict`.

It never logs the frame payload, prompt text, credentials, raw exception
object, or secret-bearing context. This makes issue-101-style reconcile
failures actionable without widening the logging boundary.

## Compatibility and Rollout

The wire snapshot is unchanged, so this phase does not require a new Server
capability or Runtime protocol version. Rollout is Client-only:

1. release the Client with the common factory contract v2 and all built-in
   Provider mappings;
2. restart the daemon so every Session Runtime is reconstructed through the
   new path; and
3. do not mutate any existing Workspace content automatically.

Older Clients use `<workspace>/files/` as cwd, while new Clients use
`<workspace>/`. Switching versions therefore changes the cwd visible to the
Provider. OpenTag does not move or merge content automatically; users must back
up and reorganize it themselves. New Clients never fall back to a managed
Workspace file when Provider-native admission is unavailable; the Provider
fails closed instead.

## Verification

Required tests include:

- a new Agent receives an empty flat cwd with no `AGENTS.md` or `files/`;
- Sessions of one Agent share the same root and different Agents remain
  isolated;
- existing `files/`, `AGENTS.md`, and other user entries remain unchanged;
- obsolete workspace state is not read;
- the common request rejects missing, blank, and oversized system prompts;
- the Provider registry rejects contract-v1 and every other non-v2 factory;
- Claude Code and Pi reject Provider-specific prompt fields;
- Codex create and resume both include `developerInstructions` and omit
  `baseInstructions`;
- Claude Code and Pi invocations contain exactly one combined
  `--append-system-prompt` value;
- Session instructions remain Turn input;
- prompt text is absent from telemetry; and
- listener errors include only sanitized frame/error categories.

Provider smoke tests should eventually prove behavior with a sentinel present
only in the managed system prompt. Unit assertions on JSON-RPC params or argv
prove transport construction but not model admission.

## Acceptance Criteria

This phase is complete when:

- Provider cwd is the Agent Workspace root;
- the Client creates or reads no OpenTag-managed instruction/control file in a
  Workspace;
- the Client does not mutate existing Workspace entries;
- the Client maps platform and Agent instructions to the documented native
  high-priority Codex and Claude Code request surfaces on create and resume;
- all built-in Provider factories enforce the common immutable prompt
  contract;
- Session input and security enforcement remain unchanged; and
- no Server, API, Web, CLI, or database mutation is required.
