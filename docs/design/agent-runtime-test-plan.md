# Agent Runtime Provider Test Plan

Status: active quality gate

Last updated: 2026-08-20

## Goal and Scope

This plan verifies that the provider-neutral Agent Runtime contract and its
Codex, Claude Code, and Pi Provider implementations are safe to use as the
lowest Client execution layer. It covers these production boundaries:

- `src/agent-runtime/base-agent-runtime.ts`
- `src/agent-runtime/errors.ts`
- `src/agent-runtime/types.ts`
- `src/agent-runtime/validation.ts`
- `src/providers/codex/agent-runtime.ts`
- `src/providers/codex/app-server-wire.ts`
- `src/providers/claude-code/agent-runtime.ts`
- `src/providers/claude-code/process-wire.ts`
- `src/providers/pi/agent-runtime.ts`
- `src/providers/pi/rpc-wire.ts`

Production Client execution now uses this contract through:

- `src/runtime/runtime-tool-host.ts`
- `src/runtime/session-runtime-manager.ts`
- `src/runtime/agent-turn-runner.ts`
- `src/runtime/client-runtime-composition.ts`

The coverage gate requires 100% statements, branches, functions, and lines for
the contract, Codex translation, hosted-tool host, Session Runtime manager, and
Claude Code translation, Turn runner, and Session Runtime/hosted-tool integration.
Coverage is a floor, not the acceptance criterion by itself: production
composition, crash recovery, protocol behavior, and live local Provider sessions
are tested separately.

There are no file-level or broad range exclusions. Narrow local V8 annotations
document non-executable invariant branches such as synthetic `finally` edges,
guards already fenced by Base admission, and callbacks made unreachable by
synchronous ownership and listener detachment. Their normal and failure
semantics are exercised at the public boundary; the annotations do not omit a
supported Provider outcome.

## Local Provider Artifact Boundary

The Client does not declare a Codex, Claude Code, or Pi package, SDK, CLI, or
bundled-binary dependency and does not contain an installer or download fallback.
In normal operation the Providers launch the literal `codex`, `claude`, or `pi`
command without a shell; the operating system resolves it from the allow-listed
`PATH` inherited from the user environment. Explicit command overrides remain
available only for caller-supplied local executables or deterministic process
test doubles.

Readiness probes invoke those same local executables. Codex checks `--version`
and `app-server --help`; Claude Code checks `--version`, `--help`, and local
`auth status --json`; Pi checks `--version`, `--help`, and the offline model list.
Pi requires 0.80.6 or newer so RPC provides both `agent_settled` and the accepted
`max` thinking level. Model discovery uses the same extension, skill, template,
theme, context-file, and project-trust disabling arguments as production Runs.
Missing, incompatible, or unauthenticated artifacts fail with typed issues; the
Client never installs or fetches a Provider. The offline suite locks this boundary
by checking dependency manifests and by asserting the default process launch
commands and inherited `PATH`. Explicit live E2E commands prove that installed
executables can create and resume Runtime sessions.

## Test Layers

### 1. Agent Runtime contract tests

The Base implementation is exercised with deterministic Provider subclasses.
Required cases are:

- manifest, capability, binding, and state immutability;
- prompt admission and strict single-active-Run behavior;
- strict FIFO follow-ups and independent typed results;
- Run ID, input, configuration, binding, and JSON validation limits;
- ordered, awaited event delivery before Promise settlement;
- steer, respond, abort, and interaction Run fences;
- caller `AbortSignal` handling for active and queued Runs;
- rejected interrupts before and after an authoritative Provider terminal claim;
- completed, failed, aborted, and cancelled terminal mappings;
- event-sink failure fallback and irrecoverable Runtime shutdown;
- provider failure versus caller close semantics;
- idempotent close, close failures, wait-for-idle, and race behavior.

### 2. Codex Provider translation tests

A scripted interactive App Server client verifies:

- `thread/start` create and exact `thread/resume`;
- `turn/start`, `turn/steer(expectedTurnId)`, and `turn/interrupt`;
- workspace, sandbox, network, approval, model, effort, and Provider config mapping;
- fail-closed rejection of policy combinations Codex cannot enforce;
- ordered message, tool, usage, warning, Provider extension, and terminal events;
- terminal ingress precedence over a following interrupt rejection while prior event delivery is blocked;
- approval, permissions, structured question, and MCP elicitation responses;
- foreign Thread/Turn events, duplicate requests, malformed data, and process failure;
- probe outcomes, credential discovery, process environment allow-listing, and cleanup.

The same suite verifies the experimental hosted-tool protocol: initialization
advertises experimental API support, `thread/start` receives the exact canonical
dynamic-tool definitions, `thread/resume` restores persisted definitions, and
unknown, duplicate, late, cancelled, malformed, or failed calls settle with a
deterministic fail-closed response. A Codex artifact without this protocol is
reported unavailable; there is no provider-default tool fallback.

### 3. Real JSONL process tests

The wire client runs against a child-process fixture rather than an in-memory
mock. It verifies initialization ordering, JSONL framing and bounds, request
timeouts and cancellation, server-initiated requests, duplicate IDs, malformed
and truncated output, unexpected exits, write failures, and process-tree cleanup.

These tests remain part of the normal offline unit suite and require neither a
public network nor Provider credentials.

### 4. Claude Code Provider translation tests

A scripted `stream-json` process verifies:

- generated UUID session binding and exact `--resume` continuation;
- FIFO follow-ups with `steer` and interactive callbacks explicitly unsupported;
- fail-closed rejection of filesystem and network constraints that managed settings can override;
- unrestricted filesystem, enabled network, and approval mapping with tool allow-lists rejected;
- streamed model turn, text, tool, usage, warning, extension, and result events;
- terminal ingress precedence over a following Abort while prior delivery is blocked;
- parallel tool-delta ownership by content-block index;
- malformed, crossed-session, missing-terminal, process, and event-sink failures;
- probe outcomes, environment allow-listing, and process-tree cleanup.

### 5. Pi Provider translation tests

A scripted Pi RPC client verifies:

- exact UUID session creation and resume with local-project `--session-id` lookup;
- post-start session-file fingerprint binding without exposing the local path;
- process-per-Run operation, prompt, steer, abort, model, thinking, and Provider configuration mapping;
- fail-closed policy mapping for Pi's no-sandbox and no-approval runtime;
- fail-closed rejection of common hosted tools, which Pi RPC cannot register;
- extension, skill, template, theme, context-file, and approval disabling;
- ordered message, tool, usage, warning, Provider extension, and `agent_settled` terminal events;
- hidden reasoning content, model errors, late process failures, and terminal ingress precedence;
- malformed or crossed session state, parent/child turn ordering, invalid event transitions, and disabled extension UI requests;
- probe outcomes, credential discovery, process environment allow-listing, and process-tree cleanup.

The Pi wire tests additionally enforce correlated strict JSONL responses,
bounded stdout and stderr, request cancellation and timeout, truncated output,
asynchronous spawn errors, command rejection, and graceful-to-forced process
tree termination.

### 6. Live local end-to-end tests

The explicit `test:e2e:codex-agent-runtime`,
`test:e2e:claude-code-agent-runtime`, and `test:e2e:pi-agent-runtime` commands
use the installed and authenticated local CLIs. Each performs:

1. deterministic local readiness probing;
2. real Provider protocol initialization and persistent session creation;
3. one text-only Agent Runtime prompt and terminal-result assertion;
4. Runtime close without deleting the persistent Provider session;
5. a new process with exact opaque-binding resume;
6. a second prompt proving conversation continuity;
7. ordered-event and clean-close assertions.

The live Codex test uses a temporary read-only workspace, disabled network
policy, `approvalPolicy: never`, no tool request, and bounded Run timeouts. It
makes real model requests and is therefore intentionally excluded from the
default test command.

The explicit `test:e2e:claude-code-agent-runtime` command applies the same
shape to the user-installed `claude`: it creates a UUID-bound session, records a
nonce, closes the process, resumes that exact binding in a new process, and
requires the resumed Run to return the nonce. The Claude Code Provider uses only
documented CLI `stream-json`, `--session-id`, and `--resume` surfaces. It does not
depend on the Agent SDK or an undocumented control protocol.

Because Claude Code managed settings outrank CLI sandbox settings, the Claude
Code live test explicitly requests unrestricted filesystem and enabled network
with `approvals: never`. The Provider rejects stricter common policies rather
than claiming a boundary it cannot guarantee.

The Pi test uses a temporary read-only workspace, disabled network policy,
`approvals: never`, no tool request, bounded Run timeouts, and an isolated
temporary session directory. It proves conversation continuity by recalling a
random project codename after exact resume. The live tests make real model
requests and are therefore intentionally excluded from the default test command.

### 7. Production Client Runtime integration and recovery

The production-path tests verify:

- daemon composition constructs the provider-neutral `createClientRuntime`
  entry point and registers only the supported Codex factory;
- a new Session creates a Provider Runtime and durably writes an opaque v2
  binding before Run admission;
- legacy v1 Codex bindings migrate on read and resume the exact Provider Thread;
- effective configuration or tool-policy changes close the old Runtime and
  create a new Provider session instead of silently reusing stale definitions;
- IM hosted tools remain scoped to the active Run identity, allow-list, Session,
  placement generation, and idempotent request correlation;
- Agent Runtime events feed generic traces and typed results feed the existing
  Turn Report path while Client Runtime retains custody;
- restart recovery reports accepted-but-not-started work as `not_started` and
  starting/running work as `turn_state_unknown`, without replaying the Run;
- stop, shutdown, repeated reconcile, binding-write failures, and reporting
  failures do not admit an unbound Run or leak a Runtime owner.

Repository acceptance also audits that `CodexAdapter`, `CodexTurnRunner`,
`createCodexClientRuntime`, and their old smoke path have no remaining source,
export, test, or production consumer. The Agent Runtime live E2E is the sole
Codex live smoke.

## Commands and Acceptance

```bash
pnpm --filter @opentag/client test:agent-runtime:coverage
pnpm --filter @opentag/client test:e2e:codex-agent-runtime
pnpm --filter @opentag/client test:e2e:claude-code-agent-runtime
pnpm --filter @opentag/client test:e2e:pi-agent-runtime
pnpm check
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @opentag/server test:integration
git diff --check
```

Acceptance requires the offline commands to pass and all four scoped coverage
metrics to equal 100%. A Provider introduced or modified by a change must also
pass its live command: the local probe must report ready, both live Runs must
complete, exact resume must preserve the opaque binding, and no unhandled
rejection or child process may leak. A failed or unavailable live Provider check
is reported as a failure; it is never converted into a skipped success.

## Latest Local Execution

On 2026-08-20 the merged Agent Runtime, three-Provider, and production Client
Runtime suite passed 207 tests with 100% statements, branches, functions, and
lines. All 304 Client tests passed. Repository formatting, notice, build, and
type-check gates passed, as did all 96 Server integration tests.

The Pi live test passed against the user-installed `pi` 0.83.0 executable:
both create and resumed Runs completed, the materialized opaque binding was
preserved, and the Runs produced 53 and 95 ordered events respectively. The
Client manifests contain no Pi package, SDK, CLI, or bundled-binary dependency.

The monorepo test command retains two unrelated existing macOS CLI failures
caused solely by `/tmp` versus `/private/tmp` path spelling. All other package
tests passed; the Pi and Client suites are green.
