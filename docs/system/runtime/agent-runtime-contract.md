---
title: "Agent Runtime contract"
description: "Normative Provider-neutral Agent Runtime contract: Run ownership, event grammar, data boundaries, and Provider support."
---

# Agent Runtime Contract

Status: normative

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
- `steer` resolves with a receipt whose outcome settles with the joined Run: `processed` (the Run completed),
  `not_started` (the Provider reports it never began the input, so delivering it again is safe), or `interrupted`
  (it may have begun, but the Run did not complete). Claude Code writes steer input to stdin and tracks whether
  `command_lifecycle` or a result names it as started. Codex and Pi acknowledge steer
  over RPC without a per-input start signal; their input counts as possibly started. If the Run settles while the
  Provider is accepting steer, only a Provider that reports the input never started may reject it (`steer_not_sent`)
  for redelivery; otherwise the receipt reports the settled Run, so the caller never replays owned input.
  A receipt may also carry `inConversation`, which resolves once the input is durably in the Provider's conversation, so a
  process killed then and resumed still has it. Claude Code resolves it at the first top-level assistant message after the
  input started, because `started` comes before its transcript flush. Codex resolves it with the `turn/steer` answer, since the
  rollout already holds the input. Pi gives no such signal and omits it.
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

Providers share internal configuration-merge and protocol-value utilities, while retaining their
validation limits and failure cleanup. Codex and Claude Code accept opaque nonempty MCP gateway
bearers and absolute HTTP(S) URLs without rewriting the URL. Pi's managed extension launch facts
remain stricter: bounded URL and token, the MCP gateway path, no URL credentials/query/fragment,
no unknown fields, and an `otmg_` token. These adapter-specific contracts do not change the common
Runtime API.

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

Codex App Server stdio defaults to an 8 MiB UTF-8 budget per JSONL record so that
aggregated tool output can exceed 1 MiB. Incoming records exclude the terminating
newline from this budget; outgoing requests include it. The limit applies to each
record, independently of stream chunks and batches. An oversized incoming record
fails the wire, rejects pending requests, and terminates the owned Provider process
group. This transport budget does not relax individual Runtime field validation.
Thread resume still uses `excludeTurns: true` to avoid returning unnecessary history.

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
An Agent name is also its slug (`OpenTag Agent slug:` in the platform layer and `members/<slug>/` in a Context Tree).
It may use ASCII letters in either case, digits, CJK unified ideographs (not radicals), and hyphens, must not start
with a hyphen, and is at most 64 UTF-8 bytes (21 Chinese characters), so the reserved platform instruction budget stays
exact. The Server stores it trimmed and NFC-normalized, keeps its case, and enforces uniqueness within an Account
case-insensitively, including under concurrent creation. Clients older than this rule do not recognize a slug with uppercase or Han characters and
fall back to the generic member-directory guidance.
Why: people name Agents the way they name teammates, often in Chinese or with capitals, and one name field is simpler
than a separate display name and handle. Length is counted in bytes because the name is part of the platform
instructions, whose reserved budget is in bytes; about 21 Chinese characters is enough for a name. Only unambiguous
characters are allowed, and uniqueness ignores case, so two Agents never look alike.
Agent and Session revision IDs identify their respective content; the sequences order updates.

When preparing a Local Session within the same placement, the Client verifies its saved snapshot
against the durable binding using the snapshot's original hash layout. Agent and Session
revisions are checked independently: stale revisions and same-revision content conflicts are
rejected, including after a Client restart. A newer Session revision does not excuse a conflicting
Agent revision. Preparation runs again when the effective snapshot changes, including an
Agent-only revision change.

An unchanged snapshot, a valid current-format update that keeps `instructions`,
`selfConfigurationEnabled`, and `contextTrees` unchanged, or a supported compatible legacy upgrade
retains the native Provider conversation and resumes it on the next Run with the updated model,
reasoning effort, and execution policy. Changes to `instructions`, `selfConfigurationEnabled`, or
`contextTrees`, and legacy layout transitions that change the effective snapshot hash, start a new
native conversation within the same OpenTag Session while preserving the workspace, historical
snapshots, and delivery receipts. Historical messages are not automatically replayed. An unresolved
Turn must settle before a configuration switch.

The Client writes the new snapshot before atomically updating the binding. A missing snapshot
can be reconstructed from a request with the exact saved hash and identity; a different request
cannot replace it without the original snapshot needed to validate the prior configuration.

## Context composition and token interpretation

`renderManagedSystemPrompt` builds the OpenTag-managed system instructions separately from
`buildAgentInput`, which appends each IM delivery's Session/revision facts, processing-time UTC,
provider reference, attention and reply-role facts, Session instructions, message text, bounded IM
history, and attachment context. The Platform and Agent instructions are not copied into every
new message. Session instructions currently appear in both the managed system prompt and the
per-delivery context. Session collaboration uses `buildSessionMessageInput` and has its own envelope.

Local Claude Code starts a process for each Run with the native Session ID and `--resume` after
initialization. The Run ends at the `result` of its own input, not at the first `result` on stdout. On `--resume`, Claude
Code reports a task that the previous process left behind by queueing a notification and emitting a `result` for it with
`origin` set, `num_turns: 0` and empty text, ahead of the Run's input. Taking that one as the terminal stopped the process
before the model saw the input, and the Run reported `completed` with no work done. So the Run's input carries a `uuid`, and a successful `result` with an
`origin` and no `user_message_uuids` never ends the Run. When a result explicitly names a pending steer's UUID in
`user_message_uuids`, that input counts as started even if its lifecycle frame was absent. The Run can end once the
result qualifies as terminal and all other pending steers have started. "No response requested." in a
transcript is what Claude Code writes on the next `--resume` for a user message left unanswered, with model `<synthetic>`.
It is not a model reply. An error `result` still ends the Run, whatever its origin. The one exception is a
resume that finds nothing. If Claude Code has no transcript for the bound conversation on this Computer (deleted,
replaced home, or a Session moved from another machine), it answers `--resume` with an `error_during_execution`
result: `num_turns: 0` and `No conversation found with session ID: <id>`. Resuming again would fail the same way
on every later message. Instead, the Run closes that process and starts a new conversation under the same Session
ID with `--session-id`. It emits a `claude_session_history_unavailable` provider warning and puts an
`[openTag notice]` saying the earlier history is unavailable ahead of the Run's input. The binding does not change,
and later Runs resume the new conversation. Local Pi also starts a process per Run, restoring the exact Pi Session. Codex keeps
an App Server per prepared Session and starts native Turns on its thread; execution-service
attachment may reload that same thread. `excludeTurns: true` suppresses history returned in the
resume RPC response; it does not remove the model's conversation history. Local configuration
replacement follows the binding rules above, rather than replaying the old history.

Cloud execution uses Pi only. Its worker restores the binding and Pi history under
`.opentag/pi-session` and appends the current input. The Cloud model transport is Chat Completions,
not a provider-side Responses conversation ID. Pi serializes its active native conversation for
model calls. Cloud disables ambient context files, Skills, extensions, templates, and themes, then
adds the packaged resources explicitly. Local production Pi enables native resources; Claude and
Codex likewise retain their native project configuration.

Context Tree preparation supplies tree selection, project path, availability, and guidance, not snapshot paths, commit
SHAs, or tree pages. Agents obtain the current snapshot through `context-tree sync`; see
[Context Tree integration](../capabilities/context-tree-integration.md#read-freshness-and-prompt-placement).
Selected pages and Skill bodies enter context when the Agent reads them. Native Skill catalogs and
MCP tool descriptions/schema can add input independently of the managed prompt. Local Claude's
private plugin and MCP names remain stable within one runtime; Codex's private MCP name also lives
for one runtime;
Cloud Pi uses the fixed `opentag-mcp` adapter entry. These are distinct from rotating credentials.

Native continuity does not guarantee a prompt-cache hit. Request input, cache reads/writes,
billable cost, and the active context window are different measurements. Changes in an appended
message do not themselves rewrite an earlier prefix. A changed tool catalog, managed system
prompt, native configuration, model, or compaction can change it. The
[Agent usage accounting](../agent-usage.md) provider rules define reported totals; they are not
an invoice or a measurement of unique context. Cloud billing uses the model-call ledger rather
than the Runner's Turn report.

### Idle compaction

`AgentPromptRequest.compactContext` asks a Provider to compact the existing native conversation before the Run's
input. [Channel Sessions](../messaging/thread-sessions.md#channel-session-idle-compaction) set it on the first Turn after
8 idle hours. A conversation with no history compacts nothing. Compaction has no budget of its own: its time counts
against the Turn's deadline, so a slow compaction on a Turn near its deadline can time that Turn out before its input
runs. An interrupt during compaction aborts the Run. Any other failure emits a `provider_warning` and the Run continues.
Cancelling Codex's request does not stop a compaction Turn that is still starting, so an abort keeps ownership until that
Turn ends. If it cannot be stopped within 5 seconds, the runtime closes and the next Run starts a new App Server.

| Provider | Mechanism | Native identity | Usage in the Turn report |
| --- | --- | --- | --- |
| Claude Code | A separate `--resume` process receives the native `/compact` command; a `compact_boundary` message confirms it. The Run's own process then resumes from that boundary. Steer input waits for that process. | Same Session ID | Not included: `/compact` reports zero `usage`, and its `modelUsage` is cumulative for the Session |
| Codex | `thread/compact/start` on the prepared App Server, after any execution-service rebind. It answers at once and compacts in its own native Turn, which must complete first because `turn/start` is refused until then. Its notifications do not reach the Run. | Same thread ID | Not included: the compaction Turn reports no token totals |
| Pi | The `compact` RPC in the Run's process, before `prompt`. Pi's `compaction_start` and `compaction_end` events are handled as for threshold compaction, and a failed compaction warns through `compaction_end`. A Session too small to summarize, or already compacted, is skipped without a warning. | Same Session file | Included, from `compaction_end` |

Cloud runs Pi and keeps the activity time in its continuity directory, inside the archived workspace, so it survives an
idle reclaim with the Pi history. The Runner
passes the execution's outbox context to the worker in its stdin document.

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
extension. Claude Code uses `acceptEdits` with its native permission callback; Codex uses
`workspace-write` and `on-request` approvals. Cloud runs always use full permissions.
See [Agent permissions](agent-permissions.md) for allowed-command settings and the
Slack/Feishu approval flow. Pi's read-only adapter mode limits exposed tools without
providing an OS isolation boundary. Actual Local Runs enable native extensions,
ambient Skills, prompt templates, themes, and context files. Cloud execution and
readiness/help/model-option queries disable implicit resource discovery. Packaged
Context Tree Skills remain explicit additions to actual execution. Model credentials come
from the operator's configured Pi environment; Local E1 does not introduce a hosted secret
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

OpenTag adds its own MCP services through a supplementary temporary MCP configuration with private
service names generated once per runtime and reused across its Runs. The gateway name stays at
11 characters, preserving its existing
model-facing tool-name budget. External packaged Skills use a private plugin with an explicit,
randomly generated name per runtime. A native user plugin named `opentag` remains loadable alongside
platform resources. Every Run still receives fresh configuration, ports, and execution credentials;
cleanup removes only that Run's resources. Names are not persisted in the Session binding, so a resumed
binding in a new runtime receives a new private identity. Tool grants use the runtime's exact
service names; Skill names come from the
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
`set_editor_text` events as Provider events. Custom extension messages may occur outside model turns
and are retained as Provider events. Interactive dialogs fail with a headless compatibility error;
Pi RPC does not provide the TUI or theme switching.

Startup model activity is rejected before submitting the managed prompt, including active or queued
native state whose start events were not observed. Startup notifications and custom messages remain
allowed. Model ownership starts at the decoded successful prompt ACK, before later events in the same
RPC batch. Agent/turn/message/terminal lifecycle before that ACK is rejected; threshold-compaction
events remain allowed during prompt preflight and never own a terminal or authorize steer alone.
Steer waits for that acknowledgement and the ordered state/event check to establish model ownership; consumed
inputs reject waiting steer without an acceptance event. A settled model cannot accept a late steer. After the steer RPC, the runtime drains its event queue
and checks native active state and settlement again before emitting input acceptance. Native
idle cleanup is not an active model, even if extension handlers have delayed `agent_settled`.

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
[Local Pi harness](https://github.com/first-tree-ai/opentag/blob/main/scripts/e2e/cloud-computer.mjs)
(`node scripts/e2e/cloud-computer.mjs --help`).

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
