# Agent Runtime and Codex Provider Test Plan

Status: active quality gate

Last updated: 2026-08-19

## Goal and Scope

This plan verifies that the provider-neutral Agent Runtime contract and the first
Codex Provider implementation are safe to use as the lowest Client execution
layer. It covers these production boundaries:

- `src/agent-runtime/base-agent-runtime.ts`
- `src/agent-runtime/errors.ts`
- `src/agent-runtime/types.ts`
- `src/agent-runtime/validation.ts`
- `src/providers/codex/agent-runtime.ts`
- `src/providers/codex/app-server-wire.ts`

The coverage gate requires 100% statements, branches, functions, and lines for
that exact source set. Coverage is a floor, not the acceptance criterion by
itself: protocol behavior and a live local Codex session are tested separately.

There are no file-level or broad range exclusions. Five local V8 annotations in
the Codex implementation document non-executable invariant branches: one
synthetic `finally` branch reported by V8, three defensive Codex guards already
fenced by Base admission plus the serial Provider envelope queue, and one stale
queued-signal callback guard fenced by synchronous queue ownership and listener
detachment. Their normal and failure semantics are exercised at the public
boundary; the annotations do not omit a supported Provider outcome.

## Local Codex Artifact Boundary

The Client does not declare a Codex package, SDK, CLI, or bundled-binary
dependency and does not contain an installer or download fallback. In normal
operation the Provider launches the literal `codex` command without a shell;
the operating system resolves it from the allow-listed `PATH` inherited from
the user environment. An explicit command override remains available only for
a caller-supplied local executable or deterministic process test double.

Readiness probes invoke that same local executable with `--version` and
`app-server --help`. If it is missing or incompatible, readiness fails with a
typed issue; the Client never installs or fetches Codex. The offline suite locks
this boundary by checking the root and Client dependency manifests and by
asserting the default process launch command and inherited `PATH`. The live E2E
then proves that the actual user-installed executable can create and resume a
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

### 4. Live local end-to-end test

The explicit `test:e2e:codex-agent-runtime` command uses the installed and
authenticated local Codex CLI. It performs:

1. deterministic local readiness probing;
2. real App Server initialization and `thread/start`;
3. one text-only Agent Runtime prompt and terminal-result assertion;
4. Runtime close without deleting the persistent Codex Thread;
5. a new process with exact binding `thread/resume`;
6. a second prompt proving conversation continuity;
7. ordered-event and clean-close assertions.

The live test uses a temporary read-only workspace, disabled network policy,
`approvalPolicy: never`, no tool request, and bounded Run timeouts. It makes real
model requests and is therefore intentionally excluded from the default test
command.

## Commands and Acceptance

```bash
pnpm --filter @opentag/client test:agent-runtime:coverage
pnpm --filter @opentag/client test:e2e:codex-agent-runtime
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

On 2026-08-19 the final scoped suite passed 79 tests with 100% statements,
branches, functions, and lines. The live test passed against `codex-cli 0.144.1`:
both create and resumed Runs completed, the opaque binding was preserved, and
each Run produced 16 ordered events. The monorepo formatting, build, and
type-check commands also passed after the live run.
