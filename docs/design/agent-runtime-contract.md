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
[Runtime protocol compatibility](../runtime-protocol.md).

Local Pi runs with unrestricted filesystem access, enabled network, and no approval
gate. Unsupported stricter product settings are rejected. Pi's read-only adapter
mode limits exposed tools; it is not an OS isolation boundary. Automatic extensions,
ambient skills, prompt templates, themes, and context-file discovery are disabled.
Packaged Context Tree skills are passed explicitly. Model credentials come from the
operator's configured Pi environment; Local E1 does not introduce a hosted secret
proxy or Cloud sandbox.

### Pi binding lifecycle

A new Pi binding records the provider Session UUID before Run admission. Its
`sessionFileHash` is added only after Pi materializes conversation history. A
pre-prompt `get_state` path is a prospective filename, not evidence that the file
exists: Pi defers the first JSONL write until an assistant message is persisted.

If the first Run is interrupted before materialization, a later Turn reopens the
same Pi UUID with `--session-id`. Pi loads existing history if present, or starts
an empty file for that UUID if the first file was never created. This also preserves
history saved just before a crash that prevented OpenTag's binding update. An
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
[maintained acceptance harness](../testing/cloud-computer.md).

## Verification

The required CI coverage command is:

```bash
pnpm --filter @opentag/client test:agent-runtime:coverage
```

It enforces 100% statements, branches, functions, and lines over the common
contract, all Provider adapters and wires, shared process ownership, and the
production Agent Runtime composition path. Live Provider tests remain explicit
because they use installed user credentials and make real model requests.
