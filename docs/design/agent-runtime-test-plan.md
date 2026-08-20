# Agent Runtime, Codex, and Claude Code Provider Test Plan

Status: active quality gate

Last updated: 2026-08-19

## Goal and Scope

This plan verifies that the provider-neutral Agent Runtime contract and the
Codex and Claude Code Provider implementations are safe to use as the lowest
Client execution layer. It covers these production boundaries:

- `src/agent-runtime/base-agent-runtime.ts`
- `src/agent-runtime/errors.ts`
- `src/agent-runtime/types.ts`
- `src/agent-runtime/validation.ts`
- `src/providers/codex/agent-runtime.ts`
- `src/providers/codex/app-server-wire.ts`
- `src/providers/claude-code/agent-runtime.ts`
- `src/providers/claude-code/process-wire.ts`

The coverage gate requires 100% statements, branches, functions, and lines for
that exact source set. Coverage is a floor, not the acceptance criterion by
itself: protocol behavior and live local Provider sessions are tested separately.

There are no file-level or broad range exclusions. Five local V8 annotations in
the shared Runtime and Codex implementation document non-executable invariant
branches: one synthetic `finally` branch reported by V8, three defensive Codex
guards already fenced by Base admission plus the serial Provider envelope
queue, and one stale queued-signal callback guard fenced by synchronous queue
ownership and listener detachment. Their normal and failure semantics are
exercised at the public boundary. Two equivalent local annotations in the
Claude Code Provider cover its synthetic `finally` branch and an impossible
cleared-context queue guard. The annotations do not omit a supported Provider
outcome.

## Local Provider Artifact Boundary

The Client does not declare a Codex or Claude Code package, SDK, CLI, or
bundled-binary dependency and does not contain an installer or download
fallback. In normal operation the Providers launch the literal `codex` and
`claude` commands without a shell; the operating system resolves them from the
allow-listed `PATH` inherited from the user environment. Explicit command
overrides remain available only for caller-supplied local executables or
deterministic process test doubles.

Readiness probes invoke those same local executables. Codex checks `--version`
and `app-server --help`; Claude Code checks `--version`, `--help`, and local
`auth status --json`. Missing, incompatible, or unauthenticated artifacts fail
with typed issues; the Client never installs or fetches either Provider. The
offline suite locks this boundary by checking dependency manifests and by
asserting the default process launch commands and inherited `PATH`. Explicit
live E2E commands prove that the installed executables can create and resume a
Runtime session.

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

### 5. Live local end-to-end tests

The explicit `test:e2e:codex-agent-runtime` command uses the installed and
authenticated local Codex CLI. It performs:

1. deterministic local readiness probing;
2. real App Server initialization and `thread/start`;
3. one text-only Agent Runtime prompt and terminal-result assertion;
4. Runtime close without deleting the persistent Codex Thread;
5. a new process with exact binding `thread/resume`;
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

## Commands and Acceptance

```bash
pnpm --filter @opentag/client test:agent-runtime:coverage
pnpm --filter @opentag/client test:e2e:codex-agent-runtime
pnpm --filter @opentag/client test:e2e:claude-code-agent-runtime
pnpm check
pnpm build
pnpm typecheck
pnpm test
```

Acceptance requires all commands to pass, all four scoped coverage metrics to
equal 100%, the local probe to report ready, both live Runs to complete, exact
resume to preserve the Thread ID, and no unhandled rejection or leaked child
process. A failed or unavailable live Provider check must be reported as a
failure; it is never converted into a skipped success.

## Latest Local Execution

On 2026-08-20 the scoped Agent Runtime, Codex, and Claude Code suite passed 139
tests with 100% statements, branches, functions, and lines. All 243 Client tests
passed. Repository formatting, notice, build, and type-check gates passed. The
Codex live test passed against `codex-cli 0.144.1`: both create and resumed Runs
completed, the opaque binding was preserved, and each Run produced 16 ordered
events.

The local `claude` 2.1.210 executable was discovered from the user `PATH`. The
create/resume success E2E remains blocked because `claude auth status --json`
reports no active login; readiness reports `credential_missing` and does not
skip the gate. The monorepo test command also retains two unrelated existing
macOS CLI failures caused solely by `/tmp` versus `/private/tmp` path spelling.
