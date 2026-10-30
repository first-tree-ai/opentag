---
title: "Agent Runtime contract"
description: "Normative Provider-neutral Agent Runtime contract: Run ownership, event grammar, data boundaries, and Provider support."
---

# Agent Runtime Contract

Status: normative

Last updated: 2026-08-20

## Purpose

Agent Runtime is the lowest Client execution boundary. It lets the Client own
admission, durable custody, ordered events, policy, and recovery without
depending on a Provider SDK or leaking a Provider wire protocol into higher
modules.

The dependency direction is:

```text
Client Runtime -> AgentRuntime / AgentRuntimeFactory -> Provider adapter -> local Provider executable
```

The contract contains no Codex, Claude Code, or Pi types. A Provider adapter
translates one local executable into the common contract and owns all
Provider-specific configuration, binding, and protocol validation.

## Runtime Ownership

- A Runtime owns one durable Provider session binding.
- `prompt` requires an idle Runtime. `followUp` owns a strict FIFO queue.
- One Run is active at a time. Every mutation carries an expected Run identity.
- The Base Runtime serializes and awaits event delivery before settling a Run.
- Provider terminal ingress may be claimed before queued translation finishes;
  public settlement still waits for the Provider execution to finish.
- `close` is idempotent, cancels queued work, joins the active Run, closes the
  Provider process, and emits `runtime_closed` when the event sink is healthy.

## Provider Event Grammar

Each Run has independent identifier namespaces for model turns, messages, and
tool calls.

- Model-turn events are optional because not every Provider exposes that
  boundary. If emitted, each `model_turn_started(id)` has exactly one matching
  `model_turn_completed(id)`.
- A message is `message_started(id)`, followed by zero or more deltas, followed
  by exactly one `message_completed(id)`. IDs cannot be reused within a Run.
- A tool is `tool_started(id, name)`, followed by zero or more updates, followed
  by exactly one `tool_completed(id, name, status)`. Parallel tools are allowed;
  the name cannot change during a lifecycle and IDs cannot be reused.
- Usage, warning, and Provider-extension events may occur anywhere within the
  active Run and must contain bounded, validated data.
- A successfully completed Run must close every started lifecycle. Failed and
  aborted Runs terminate open lifecycles implicitly because a broken or
  interrupted Provider stream cannot always emit closing frames.

`BaseAgentRuntime` enforces this grammar. Adapters must normalize legal wire
differences, such as a completion without an observable start, before emitting
common events. Adapter-local state machines continue to reject crossed session,
Run, and Provider-protocol identities.

## Data and Cancellation Boundaries

- Contract JSON accepts finite numbers, primitives, dense arrays, and plain or
  null-prototype data objects with enumerable data properties only.
- Dates, maps, sets, class instances, accessors, symbols, sparse arrays, custom
  array properties, cycles, and non-finite numbers are rejected.
- Runtime snapshots are immutable. Binding equality is structural and does not
  depend on object insertion order.
- Every readiness probe receives the caller `AbortSignal`. The factory must
  propagate it to child processes and must still reject promptly if a custom
  probe runner ignores the signal.
- Probe cancellation is not reported as artifact absence.

On POSIX hosts, the Provider watchdog owns the process group through shutdown. It keeps its
signal handlers installed and the existing 500 ms escalation timer alive until the group receives
`SIGKILL`, including when the Provider exits before a tool with closed stdio. Interrupt, close,
and terminal-result cleanup retain this escalation even after the Provider exits. The wrapper
and its descendants can become observable as stopped at different times after group termination.
Broken forwarding pipes enter the same bounded shutdown instead of crashing the watchdog before
escalation. This boundary covers the owned process group; a process that creates a separate
session or process group is outside that ownership boundary.

### Local Session configuration

The Server uses `agent_runtime_configs.revision` for both Agent and Session snapshot sequences.
An owner change to `selfConfigurationEnabled` advances that runtime revision in the same transaction
as the Agent row, just as a runtime configuration change does. Repeating the same switch value or
editing only the display name or receive mode does not advance it. Agent names are immutable.
Agent and Session revision IDs identify their respective content; the sequences order updates.

When preparing a Local Session within the same placement, the Client verifies its saved snapshot
against the durable binding using the snapshot's original hash layout. Agent and Session
revisions are checked independently: stale revisions and same-revision content conflicts are
rejected, including after a Client restart. A newer Session revision does not excuse a conflicting
Agent revision. Preparation runs again when the effective snapshot changes, including an
Agent-only revision change.

An unchanged snapshot or a supported compatible legacy upgrade can retain the native Provider
conversation. A valid newer configuration with changed content creates a new native conversation
within the same OpenTag Session. It preserves the workspace, historical snapshots, and delivery
receipts, and uses the current requested permissions. Historical messages are not automatically
replayed. An unresolved Turn must settle before a configuration switch.

The Client writes the new snapshot before atomically updating the binding. A missing snapshot
can be reconstructed from a request with the exact saved hash and identity; a different request
cannot replace it without the original snapshot needed to validate the prior configuration.

## Provider and Product Support

Provider implementation and production product support are separate claims:

| Provider | Contract adapter | Local live smoke | Shared/Server/Client production composition |
| --- | --- | --- | --- |
| Codex | supported | supported | supported |
| Claude Code | supported | supported | supported |
| Pi | supported | supported | supported (Local E1) |

All three providers participate in Shared snapshots, Server admission, Client
readiness and policy mapping, and CLI/Web setup. Pi readiness requires the installed
CLI's supported RPC surface and usable model configuration; a version check alone
is insufficient. Provider readiness is observed availability, not authorization.
The frozen readiness v1 vocabulary contains only Codex and Claude Code; Pi is
advertised only after explicit readiness v2 negotiation. See
[Runtime protocol compatibility](runtime-protocol.md).

Local Pi keeps enabled network and always runs without approvals or a permission
extension. Claude Code uses `auto` with its native permission callback; Codex uses
`workspace-write` and `on-request` approvals. Cloud runs always use full permissions.
See [Agent permissions](agent-permissions.md) for allowed-command settings and the
Slack/Feishu approval flow. Pi's read-only adapter mode limits exposed tools without
providing an OS isolation boundary. Automatic extensions,
ambient skills, prompt templates, themes, and context-file discovery are disabled.
Packaged Context Tree skills are passed explicitly. Model credentials come from the
operator's configured Pi environment; Local E1 does not introduce a hosted secret
proxy or Cloud sandbox.

### Local Claude native configuration and trust

Local Claude admits native user, project, and local configuration, including plugins, hooks,
Skills, MCP servers, environment overrides, and credential helpers. Agents may configure these in
their existing Agent Home. Because that directory is model-writable, a file write can enable code
that runs on the next Run before any tool approval. Native hooks, helpers, plugins, and stdio MCP
processes execute as trusted local code; native tool approvals do not isolate them.

Claude inherits the operator-provided daemon environment, including custom variables and any
long-lived credentials present there. Those credentials do not acquire execution fencing or
revocation by entering Claude. The existing execution-bound lifecycle applies to OpenTag-issued
platform bearers, not to user-managed native credentials. Native configuration remains local and
does not become Server plugin state or a platform-managed MCP registration. User-wide configuration
keeps its native effect across projects; an Agent cwd does not isolate global settings.

OpenTag adds its own MCP services through a supplementary temporary MCP configuration with fresh
service names for each Run. The gateway name stays at 11 characters, preserving its existing
model-facing tool-name budget. External packaged Skills use a private plugin with an explicit,
randomly generated name per Run. A native user plugin named `opentag` remains loadable alongside
platform resources. Tool grants use that Run's exact service names; Skill names come from the
current native catalog. Existing cwd, Provider Home, login, and conversation
history locations do not change. Codex, Pi, and Cloud resource policies retain their own rules.

Claude Provider readiness is cached for the Computer and reads user-scoped authentication only.
It must not derive shared readiness from whichever project is the daemon's cwd. It is not proof of
an Agent project's authentication or plugin loading. Check those with native commands from Agent
Home and the current Run's actual tool/Skill catalog. Project-only credentials do not establish
Computer-level readiness.

### Local Codex native configuration and trust

Local Codex reads native user and project configuration, including plugins, hooks, Skills, direct
MCP servers, and dynamically discovered plugin MCP servers. OpenTag does not force native feature
flags on or off. Availability, hook trust, plugin installation, and reload behavior follow the
installed Codex version. OpenTag does not approve native hook definitions or bypass their trust
checks. Agents manage and check native resources through the Codex CLI and files from Agent Home;
prefer project configuration for one Agent. User-wide settings and plugin caches remain shared.

The App Server inherits the operator-provided environment, including custom plugin variables and
long-lived credentials. Native helpers, trusted hooks, plugins, and stdio MCP processes can execute
outside model tool approvals and sandbox boundaries. User-managed credentials do not acquire
OpenTag execution fencing or revocation. Native configuration remains local; Server stores no
native plugin inventory. Existing cwd, Provider Home, login, and history locations stay unchanged.

OpenTag keeps one App Server per Session runtime. It disables shell snapshots and login shells and
sets managed `ZDOTDIR` when needed to preserve Session CLI routing; it does not replace native shell
environment filters. Shell inheritance is pinned to `all` so Session metadata and custom plugin
variables do not depend on the native default; configured exclusions still apply. Environment
changes require a new runtime. OpenTag overlays only its private
execution MCP key and necessary execution socket profile in memory, retaining other native
configuration. See [MCP integration](../capabilities/mcp-server-integration.md#codex-rebinding-the-thread-per-run).

Provider readiness and `computer runtime-inspect` establish Provider availability, not project
plugin loading, native hook trust, or working tool calls. Inspect native configuration and the
current tool/Skill catalog from Agent Home and exercise the relevant resource before reporting
success. A native reload or new Session runtime may be necessary for a changed resource.

### Local Pi native resources and trust

Local Pi discovers native user and project extensions, packages, Skills, prompt templates, context
files, and themes. OpenTag does not force offline mode or disable those resources during a Run.
Native enablement, exclusion rules, installation, and updates follow the installed Pi CLI. Agents
can use `pi install -l <source> --approve`, `pi list`, and project settings from Agent Home to manage
and inspect their resources. Prefer project settings for one Agent; global configuration retains
its native scope. Existing cwd, Pi Home, login, and Session history locations stay unchanged.
Server stores no native resource inventory or configuration.

OpenTag passes `--approve` to the actual Local process, trusting that invocation's selected cwd.
It does not write `trust.json`, trust parent directories, or approve unrelated projects. Native
extensions are trusted local code and may run outside model tool restrictions. The Local process
inherits custom environment variables and operator credentials. These credentials do not acquire
OpenTag execution fencing or revocation. Explicitly prepared factory environments are not filtered
again. Cloud retains its controlled environment and disabled implicit resource discovery.

Platform Skills and Web extensions remain explicit additions to native discovery. Native Pi owns
resource deduplication and exclusions. Platform MCP uses a private runtime registration alongside
native MCP configuration; see [Pi MCP composition](../capabilities/mcp-server-integration.md#pi-and-cloud-runtime-delivery).
Readiness, help, and model-option queries keep resource discovery and project trust disabled, and
receive no explicit platform resources. Their success does not establish project plugin loading.
Check the current native command/tool catalog and exercise the resource before reporting success.

Headless execution accepts fire-and-forget `notify`, `setStatus`, `setWidget`, `setTitle`, and
`setEditorText` events as Provider events. Custom extension messages may occur outside model turns
and are retained as Provider events. Interactive dialogs fail with a headless compatibility error;
Pi RPC does not provide the TUI or theme switching.

Pi 0.84.2 acknowledges extension commands and handled input without a completion disposition or
`agent_settled` event. After an ordered state query, an acknowledged input with no model lifecycle
and no active run is reported as `provider_request_rejected`, with an explicit protocol
compatibility explanation. Extension side effects may already have happened; inspect them before
retrying. OpenTag never reports successful completion from idle state or a timeout. Model runs
still require `agent_settled`, including while native extension cleanup is pending. Consequently
this path opens native resources but does not promise complete plugin command or interactive UI
compatibility. Upgrading Cloud's pinned Pi dependency or implementing a general TUI bridge is
outside this Local resource policy.

### Pi binding lifecycle

A new Pi binding records the provider Session UUID before Run admission. Its
`sessionFileHash` is added only after Pi materializes conversation history. A
pre-prompt `get_state` path is a prospective filename, not evidence that the file
exists: Pi defers the first JSONL write until an assistant message is persisted.

If the first Run is interrupted before materialization, a later Turn reopens the
same Pi UUID with `--session-id`. Pi loads existing history if present, or starts
an empty file for that UUID if the first file was never created. This also preserves
history saved just before a crash that prevented openTag's binding update. An
unmaterialized binding is not replaced merely because its file hash is absent.
This does not automatically replay the interrupted Turn or claim its success.
Once materialized, recovery must preserve both the Pi UUID and file-path fingerprint,
and reject missing or empty history instead of silently resetting it.
The fingerprint does not detect arbitrary partial corruption retaining messages.

A completed Run requires `agent_settled`, final assistant `stopReason=stop`, and
successful child-process cleanup. Length-limited or terminal tool-call output is
failed with partial output retained. Cleanup failure closes the affected runtime;
an earlier protocol or model failure remains the primary error. Server per-Session
stop/status and Cloud lifecycle acceptance remain outside Local E1; see the
[maintained acceptance harness](https://github.com/first-tree-ai/opentag/blob/main/testing/cloud-computer.md).

### Pi prompt acceptance and compaction

Pi acknowledges a prompt only after its preflight, and preflight may first run
native threshold compaction: a full summary model call whose latency grows with
the conversation. The Pi adapter therefore counts the prompt acceptance budget
only outside compaction. Compaction start pauses the budget, compaction end
grants a fresh window, and compaction itself stays bounded by the Turn deadline
and cancellation. A fixed timeout around prompt acceptance would fail every
message in a Session past the compaction threshold, because the interrupted
compaction never completes and the next prompt meets the same threshold. Pi's
RPC abort cannot stop native compaction, so an interrupt during compaction
closes the Pi process, whether it arrives before or after the answer. That
close settles the Run as aborted, not as a Provider failure.
