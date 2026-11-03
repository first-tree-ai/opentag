# Runner shutdown diagnostic validation

The [observability contract](../../../docs/operations/observability.md) describes the opt-in stream.
This companion change builds on the approved collection design in [TELEMETRY-PROPOSAL.md](TELEMETRY-PROPOSAL.md),
including its terminal-cleanup boundary and existing streams, retention and Staging selection.
It leaves the original Turn schema, reader, protocol and collection ownership unchanged.

## Motivation and interpretation

A controlled Cloud startup pilot on 2026-11-03 observed five owned Instances with provider
`deleteTime` to terminal `Running` condition intervals of 75.032, 10.932, 72.661, 74.455 and
7.550 seconds. These are provider metadata intervals, not observed signal receipt or process exit.
The slow first generation also emitted repeated platform shutdown notices and two authenticated
channel-ready lines; neither proves the Runner cleanup boundary. No cause or shutdown speedup is
established. Private resource identities and raw operational logs remain outside the repository.

The new process-local stream measures the existing cleanup calls without changing their order,
error propagation, signal ownership or native-destroy policy. It is separate from Turn statistics:
one shutdown can follow many Turns, and a stopped allocation is not another Turn.

## Local checks

- `runner-shutdown-observer.test.ts`: explicit Staging gate, malformed/oversized/unselected allowlists,
  no attribution before welcome, captured identity, privacy, monotonic phase durations, logging
  failure preserving original errors, false cleanup failures, repeated calls and incomplete summaries.
- `runner-bin-signals.test.ts`: real Node child with production bin/CLI/signal wiring and only the
  native boundary replaced. Verify startup SIGTERM emits no invented Session records, ready SIGTERM
  waits for delayed destroy, active acceptance SIGINT cancels exactly once, and failed destroy is
  recorded without changing the existing global signal exit policy.
  Active acceptance can destroy the namespace while the connection drains before cleanup entry;
  the request-to-summary elapsed interval includes it, while `native_cleanup` can then be a no-op.
- Existing focused Runner serve tests cover cleanup, workspace and controller interactions; client
  typecheck/build verify the Runner artifact. This change does not touch Agent Runtime coverage inputs.

## Live follow-up

Deployment and new native execution require the corresponding operational authorization. Enable
the existing flag only for selected Staging Session UUIDs. Do not change retention, image resource
limits, idle budgets, acknowledgement semantics or provider permissions to collect this evidence.

For an independently approved controlled allocation, retain intended population, revision/image,
Session/Sandbox/generation and provider UID evidence outside the repository. Correlate records by
captured scope and process clock; verify eight ordered records, observed phase ends and summary.
Keep failed/missing streams in the denominator. A summary is not a process-exit receipt. Combine
it with separately observed Instance transitions, conditional delete receipts and final GET 404.
Do not subtract clocks across hosts without an offset bound, infer zero duration from missing
records, or claim improved startup latency from the added instrumentation alone. The existing
Turn latency reader intentionally ignores this distinct operation.

Live arrival, shutdown cause, logging overhead and full Cloud latency/cost distributions remain
unverified until that follow-up is authorized and completed.
