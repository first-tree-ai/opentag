---
title: "Server observability"
description: "Optional OpenTelemetry tracing, the logging vocabulary, what is and is not exported, and the production alerts and log pipeline on Google Cloud."
---

# Server observability

openTag Server can export optional OpenTelemetry traces through OTLP/HTTP. The implementation is disabled by default and covers provider connections, IM ingress, durable delivery, and Runtime lifecycle boundaries.

Tracing is not log shipping. Pino continues to write server logs to stdout, and this feature does not upload all stdout logs to Logfire. Logfire receives spans, span attributes, and bounded exception events only. A separate path does ship stdout logs: production forwards `WARNING` and above to Cloud Logging. See [Production monitoring on Google Cloud](#production-monitoring-on-google-cloud).

Failures that happen in the Web App or the CLI rather than on the server travel a separate path: the server relays them to Google Cloud Error Reporting. See [Client error reporting](error-reporting.md).

## Logging contract

Logs use a fixed vocabulary. Use one key for each concept so dashboards and later adoption lanes do not have to merge
synonyms:

| Concept | Pino field | Notes |
| --- | --- | --- |
| Module | `module` | Owning package or service boundary. |
| Operation | `operation` | Stable operation name, not a free-form explanation. |
| Request correlation | `requestId` | HTTP or client request identifier. |
| Trace correlation | `traceId` | Active OpenTelemetry trace identifier injected via logger mixin. |
| Account boundary | `accountId` | Tenant boundary for an Agent and its resources. |
| Agent, Computer, Session, Delivery, Turn, Sandbox | `agentId`, `computerId`, `sessionId`, `deliveryId`, `turnId`, `sandboxId` | Stable resource and Turn execution identifiers. |
| Sandbox environment generation | `environmentGeneration` | Monotonic allocation generation for a Cloud Sandbox. |
| Provider / External service | `provider`, `externalService` | External dependency identifier (`slack`, `feishu`, `github`, `mcp`, `cloud-router`, `web-router`, `cloud-run`, `gcp-metadata`, `gcs`, `sandbox-runner`, `s3-skills`, `skill-source`, `gcp-error-reporting`, `channel-target`), kept distinct from the Pino base `service="opentag-server"`. |
| Outcome | `outcome` | A stable state transition such as `accepted`, `started`, `completed`, `failed`, or `rejected`. |
| Error identity | `errorCode`, `code` | Use the structured error code (dual-written as `errorCode` and `code` for compatibility). Do not invent `reason`, `errorReason`, `failureReason`, `dropReason`, or `detail` for the same concept. |
| Attempt and retry counts | `attempt`, `attemptCount`, `retryCount`, `timedOut` | Numeric execution attempt, total attempts, retry count, and timeout indicator on external calls. |
| Duration | `durationMs` | Elapsed time in milliseconds. |
| Status | `status` | Protocol or provider status when it is not an outcome. |
| Base service identity | `service`, `environment`, `revision` | Standard service metadata present on all server records. |

Level has an operational meaning: `fatal` is process crash, `error` is terminal or unrecoverable, `warn` is handled or degraded, `info` is a
state transition, and `debug` is per-request detail. Keep messages short and put queryable values in the fields above.

Client IP addresses in HTTP request logs (`req.remoteAddress`) are truncated for privacy:
IPv4 addresses are truncated to `/24` (e.g. `198.51.100.0`), and IPv6 addresses are truncated to `/48` (e.g. `2001:db8:abcd::`).

A failed request emits one `Request failed` record. Its `err` field carries `type`, `message`, the redacted `stack`,
the structured `code` and `errorCode` when the thrown error has one, and a redacted `cause` chain up to three levels deep. A `code` is
emitted only when it passes two guards, at the top level and inside causes: it matches the established structured
diagnostic-code shape (`StructuredErrorCodeSchema`) and it survives `redactForLog` unchanged. The shape check alone is
not enough, because that character set admits `:`, so `token:…` is structurally valid yet credential-shaped. A value
that fails either guard is omitted rather than replaced or half-redacted, because a fabricated code would point at the
wrong failure. Attach the provider, database, or transport failure as `cause` instead of folding it into the message:
the cause chain is what makes a wrapped status such as `IM_BINDING_TEMPORARILY_UNAVAILABLE` diagnosable from the log
alone.

Server startup installs process-level handlers for `uncaughtException` and `unhandledRejection`
(`installProcessFatalHandlers`). They emit a redacted single-line Pino `fatal` (level 60) record with
`code` and `errorCode` set to `SERVER_PROCESS_FATAL` and an `origin`, then exit with code 1.
If the application logger is unavailable, a structured stderr fallback keeps the same fatal identity.

## Cross-system request correlation and client error reporting

Every web frontend request generated by `fetchWithRefresh` creates a unique UUID `requestId` and transmits it in the `x-request-id` header.
When the client encounters a response with HTTP status >= 500 or an invalid response schema (`invalid_response_schema`), it reports the diagnostic event to the server error report relay (`/api/v1/error-reports`) with level `error`.

The error report schema admits optional `requestId` and `traceId` correlation fields. The server error ingestion handler logs client diagnostic reports at `warn` level with the client-supplied `requestId` and `traceId`, and sets `untrusted: true` to indicate client-originated metadata for downstream log ingestion and AI agent safety.

The client logger follows this `OPENTAG_LOG_LEVEL` matrix:

| Environment | OPENTAG_LOG_LEVEL | Effective level |
| --- | --- | --- |
| Tests | unset | `silent` |
| Service mode or explicit `file`/`dual` destination | unset | `info` |
| One-shot client with no configured destination | unset | `warn` |
| Any mode | valid `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent` | The selected level |
| Any mode | invalid value | `info`, plus one safe warning |

The daemon service resolves `OPENTAG_LOG_LEVEL` from its `config/daemon.env` file, the same file that
carries the daemon's other environment variables, so the level applies to the service process without
editing the LaunchAgent or systemd unit.

`imAttrs()` and `runtimeAttrs()` are OpenTelemetry helpers. They emit dotted span keys such as
`opentag.im.binding.id` and `opentag.runtime.connection.id`; do **not** pass their result as a Pino payload. Map values to
the fixed camelCase Pino vocabulary instead.

## GitHub refresh phase diagnostics

The Server maintenance worker emits `module=github-maintenance`, `operation=github.refresh` records
for each claimed refresh. `connectionId`, `attemptId`, and the decimal-string `credentialGeneration`
correlate the attempt without logging its credential envelope. The `decrypt`, `exchange`, `seal`, and
`persist` phases have INFO `started` and `completed` records; a stale completion has `outcome=skipped`
and `casApplied=false`. `durationMs` measures the phase and `elapsedMs` the attempt, both using the
process-local monotonic clock rather than credential expiry or wall time.

A handled phase failure emits WARN with its phase, controlled `errorCode`, observed HTTP `status`
when available, and an allowlisted `transportCode` when recognized. A malformed HTTP 200 response
retains status 200; an unobserved response has no fabricated status. Timeout and caller cancellation
have separate controlled transport codes. Unknown transport codes are omitted. Error messages,
names, stacks, response bodies, OAuth error descriptions, URLs, headers, tokens, client secrets,
ciphertexts and key IDs are never included in these records.

The subsequent WARN `phase=settle` record carries `failurePhase`, `outcome` (`released`, `failed`,
or `skipped`) and `casApplied`. An applied failure also records the persisted reauthorization error
code. If settlement itself throws, a separate ERROR retains `failurePhase`; it does not replace the
earlier phase failure record. Logger exceptions cannot change refresh processing. Claims, CAS,
timeouts, retry decisions, and reauthorization semantics remain unchanged: an uncertain exchange
is never replayed, while local decrypt failures and rate limits still release their claims.

Query `operation=github.refresh` together with `connectionId` or `attemptId`. Production's existing
WARN-and-above stdout shipping retains failures and settlement records, not the INFO phase stream.
Process termination can leave only a started phase; missing completion is not proof of a timeout.

## Google sign-in transport budget

The built-in Google authorization-code exchange has a 10 s native fetch budget,
including token-body parsing. An uncertain exchange is not retried with the same
code. A complete token result keeps its original commit/rollback handling during
client disconnect or shutdown. A pinned core patch preserves this boundary until
the library provides equivalent native cancellation.

## Cloud Pi phase diagnostics

Cloud Turn workers emit a bounded diagnostic stream independently of `OPENTAG_LOG_LEVEL`.
The worker writes fixed-prefix JSON lines to stderr; the parent consumes them while native
`exec` is still running and writes standalone JSON lines to the Runner's existing stderr.
No diagnostic is stored in the workspace, database, or Turn report. Local Pi runs do not enable
this stream.

The parent owns `turnId`, `dispatchRequestId`, `deliveryId` (or `messageId` for Session collaboration), `sessionId`,
`sandboxId`, `environmentGeneration`, and the Instance's `resourceName`. Child fields cannot
replace them. The parent's startup record includes the probed Runner and Pi versions once.
Use `module=cloud-pi`, `operation=pi.diagnostic`, and `provider=pi` to identify this stream.
Failures have `severity=ERROR`; normal transitions have `severity=INFO`.

| Phase | Boundary |
| --- | --- |
| `worker_startup` | Parent launch to first valid worker diagnostic; includes module loading and input delivery. |
| `worker_preparation` | Worker setup, proxy readiness, Context Tree preparation, and runtime construction. |
| `pi_spawn` | Pi client creation; spawning does not establish readiness. |
| `get_state` | First state RPC, with `rpcCommand=get_state`. |
| `session_restore` | State validation and history restoration. |
| `prompt_acceptance` | One prompt until acknowledgement, with `rpcCommand=prompt`. |
| `await_terminal` | Acknowledged prompt until terminal result and queued events settle. |
| `cleanup` | Pi shutdown; any failure remains separate from the original failure. |

The first Pi `turn_start` accepted for the owned prompt emits one `event=milestone`,
`milestone=first_turn_start` record per OpenTag Turn. It has child `elapsedMs` and Runner
`receivedElapsedMs`, `clockId`, and `monotonicMs`, with parent-owned allocation, Turn, and
`dispatchRequestId` correlation. The milestone can precede the `prompt_acceptance` end
because the native prompt also waits for a post-ack state fence. It leaves phase tracking intact.
The `get_state` end can include the OS child-spawn observation and the OpenTag MCP gateway
extension's own module-load and Session-start durations, when those stderr markers have arrived.
These are independently observed, potentially overlapping timings. Other Pi extensions and native
MCP connections have no per-extension attribution in this stream.

Each phase has `start` and `end` or `failure` records. `durationMs` measures the current phase,
`elapsedMs` measures worker elapsed time, and `seq` orders worker records. All use process-local
monotonic clocks; `receivedElapsedMs` is the parent's independent receive clock. Never subtract
clocks across processes. The `worker_preparation` `end` record also attaches optional sub-phase
durations (`proxyStartMs`, `contextTreePreparationMs`, and `skillsAssembleMs`) when reached. The parent
`worker_end` summary uses `durationMs` for the entire native exec span (not the last RPC) and
attaches `credentialOpenMs` for the parent-side credential bridge open latency. Existing
RPC budgets, compaction handling, Turn deadlines, cancellation, retry, stdout completion, and report
classification are unchanged.

Prompt diagnostics include compaction count and duration, the current acceptance-window sequence
and elapsed time, and whether its timer is paused. These observe the existing pause/re-arm hooks.
Total prompt wall time can exceed the RPC budget during compaction. An acknowledged prompt's
timer is already cleared, so its end record reports it as paused. Cancellation before acknowledgement
records the aborted RPC in `prompt_acceptance` and does not enter `await_terminal`.

A failed result returned after acknowledgement adds `terminalFailureCategory` to the
`await_terminal` end record with `outcome=failed`. An allowlisted runtime provider failure code
takes precedence. Without one, the category is `unfinished_tool_use` for Pi's `toolUse` stop
or `unknown` otherwise. Only the category is emitted. The Cloud delivery v1 Turn report still
uses `provider_failed` for these results.

The first failure has `primaryFailure=true`; the parent summary retains `failurePhase` even
when later cleanup fails. Errors preserve safe name/code, including the owned `AgentRuntimeError`
code union and `provider_start_failed`, up to two causes, and bounded stack
frames with function names and source basenames/line numbers. Trusted fixed RPC messages,
including `Pi RPC request timed out: get_state` and `Pi RPC request timed out: prompt`, are kept.
Free text, including Pi stderr embedded in exit errors, is replaced with an explicit omission
marker (`messageOrigin=omitted`, `redacted=true`). No prompts, request/response bodies, tool
payloads, raw stdout/stderr, absolute paths, or credentials are forwarded. `truncated` marks
bounded stacks/causes. `exitCode` and `exitSignal` describe the directly spawned Cloud Pi child;
`workerExitCode` describes the parent native exec and is a separate fact.

The parent always attempts a final `worker_end` summary, including on exec rejection. It carries
the last `phase`, `phaseComplete`, `failurePhase`, `originalErrorReceived`, `stopType`, and
`diagnosticIncomplete`. Stop types distinguish worker exit, caller shutdown, bridge failure,
exec timeout, and other exec rejection. `abortSource` distinguishes a Turn deadline from caller
shutdown when observed inside the worker. A started phase with no end is unconfirmed, not a
fabricated RPC timeout. A worker that never emits a valid diagnostic remains in `worker_startup`.

The parser accepts only the fixed prefix, schema version, known phases, and allowed fields.
It bounds partial lines and ignores unrelated stderr. Output is limited to 4 KiB per line,
32 records and 64 KiB per Turn, with reserved capacity for failure, cleanup and the parent
summary. Dropped, rejected, missing worker-end or truncated diagnostics set `diagnosticIncomplete=true`.
An observer or log-write exception does not change execution results. A shared stderr error listener
handles asynchronous write failures, including EPIPE; later diagnostic writes stop without
terminating the worker or Runner. The existing Cloud Logging
pipeline and retention policy apply; deployment and actual Cloud Logging arrival require live
acceptance. Simultaneous loss of the Instance and both processes cannot create a missing exception.

A Cloud Logging query after deployment can correlate the complete stream without filtering away
its INFO phase records:

```text
jsonPayload.module="cloud-pi"
jsonPayload.operation="pi.diagnostic"
jsonPayload.turnId="<turn UUID>"
```

## Cloud response-time evaluation

Evaluate Cloud latency with separate ingress-to-first-useful-send-receipt,
ingress-to-terminal-cleanup, ingress-to-checkpoint-commit and ingress-to-durable-report-ack
endpoints. Client-send-to-rendered-response is a separate user-perceived metric that needs client
or provider evidence. A custody acknowledgement, Pi spawn or first model token does not establish
useful output; a provider send receipt does not establish client rendering or a read receipt.

Retain attempted, successful, failed, timed-out and incomplete counts alongside successful-duration
quantiles and missing-stage coverage. Use process-local monotonic durations, and do not subtract
unrelated process clocks or sum overlapping phase envelopes. Allocation state, source/image,
trigger, workspace and resource limits define separate cohorts. Missing diagnostics are unavailable
evidence, not zero duration or a proven timeout.

The [Cloud evaluation tooling](https://github.com/first-tree-ai/opentag/tree/main/scripts/e2e/cloud-latency) provides a repeatable
offline synthetic fixture, report generator and comparison guard. Its subprocess/model/tool/IM
replacements do not measure production Cloud latency. Existing spans and Pi diagnostics do not
form a complete end-to-end dataset, especially for ingress, outbound CLI receipts and model/tool
attribution. New collection, export or retention paths require their own approved read/write design.

An opt-in Staging lane observes Cloud IM preparation/allocation calls and Runner workspace-ready,
worker-execution, checkpoint and matching report-ack boundaries on the existing log streams.
It includes an IM dispatch span. Runner `runner.turn.startup` events mark the journal receipt
send attempt, authorization, credential bridge open, and native exec. Join with the first-Turn
milestone by allocation, Turn, and dispatch request. Compare `monotonicMs` only within one
Runner `clockId`. Duplicate receipt and verification observations can occur on a retry.
Server performance records use `deliveryId` and `attempt` for IM claims and retries, and
`messageId` plus `dispatchRequestId` for Session messages. Allocation ensure outcomes and
the dispatch send and receipt records connect those identities to the Sandbox generation.
It requires `OPENTAG_ENV=staging`, `OPENTAG_CLOUD_LATENCY_DIAGNOSTICS=true` and an explicit
`OPENTAG_CLOUD_LATENCY_SESSION_IDS` list of at most 16 UUIDs. It emits no added records by default
or in other environments. `OPENTAG_REVISION` is a full lowercase Git SHA, otherwise `unknown`.

The production composition snapshots the validated selection into a typed Cloud Run Admin option.
Only new Staging Instances whose birth Session is selected receive `OPENTAG_ENV=staging`,
`OPENTAG_CLOUD_LATENCY_DIAGNOSTICS=true` and the full approved Session list in their container
environment. Other create requests retain their existing shape. Both create API versions share
this construction. The Server revision is not forwarded as the Runner revision.

Existing or adopted Instances are never patched to change diagnostics. Borrowing an Instance born
without these settings can leave Runner records unavailable; retain that sample as missing evidence.
Disabling Server selection affects future creation only: existing immutable settings last until
normal reclamation, while the Runner continues to apply the Session allowlist after a transfer.

Each observation reserves a summary within 32 records / 64 KiB. Observers retain at most 1,024
identities for quota enforcement without evicting them to reopen budgets. Server retries share
one delivery budget and have separate attempt identities; duplicate attempts and repeated workspace
preparations do not reopen budgets. Unavailable allocations emit failure, and non-dispatch Server
summaries are incomplete rather than successful handoffs. Records carry existing correlation
IDs, a process clock identity, UTC and monotonic durations; they exclude content and credentials.
Logging failures do not change operation outcomes, custody, retries or checkpoint policy.

The [manual stdin-only aggregator](https://github.com/first-tree-ai/opentag/blob/main/packages/server/scripts/cloud-latency-report.ts) reuses existing
Pi phase durations and the Runner-observed native-exec-to-first-Turn interval, rejects incomplete/conflicting evidence for complete-trace metrics, and emits
aggregate counts/quantiles without resource IDs or raw files. It does not infer timeout or genuine
end-to-end latency from missing records. Deployment, live collection and actual log arrival remain
separate operational acceptance; no exporter, scheduler, storage or retention change is installed.

The same Staging selection enables a separate Runner shutdown stream on existing stderr:
`module=cloud-runner`, `operation=shutdown.diagnostic`, `version=1`. It captures the
Session, Sandbox and generation from the current committed assignment, falling back to the last
accepted authenticated welcome if no assignment exists. Capture happens at the first stop request,
or at cleanup entry for an exit without a stop request. A prior accepted welcome in this process
is required; a persisted assignment alone cannot attribute unauthenticated startup. A refused
cross-Session rebind keeps the held assignment's identity and Session selection. This diagnostic-only identity
survives control-channel closure, including Server release before provider SIGTERM; it never
authorizes execution on a closed channel. No prior accepted welcome means no attributed records.
Repeated signals do not reopen the stream, and a later welcome cannot change its captured identity.

Each Runner serve invocation emits at most eight records / 16 KiB, including its reserved summary.
The stream measures `controller_drain` (the existing controller close call), `native_cleanup`
(active acceptance cancellation/wait and the existing conditional native destroy), and
`gateway_health_close` (the existing web gateway and health listener close calls). Existing caught
errors and no-op cleanup remain part of those call boundaries. A false native cleanup result emits
failure. Dropped records leave sequence gaps. Missing phases, output loss and absent summaries are
incomplete evidence. The summary describes these cleanup calls, not the global process exit code
or proof that the process exited.
Elapsed time between the request and first phase includes existing connection/acceptance draining
before cleanup entry; a native destroy may already have happened during that interval.

Shutdown records share the bounded payload and process-local clock rules above, carry no Turn ID,
and remain separate from Turn latency reports. They add no wait, flush or retry policy. Their
durations cannot establish provider deletion time, SIGTERM delivery time or an ingress latency
distribution; provider state transitions require independent evidence. Keep shutdown experiment
plans, observations and limitations in the related GitHub PR or Issue.

## Full-stack performance logging

When `OPENTAG_PERF_LOG_ENABLED` is `true` (the default), the Server emits paired `started` and
`completed` or `failed` Pino records across four boundaries:

- **Entrypoints (`perfCategory="http" | "ws" | "worker"`)** — Fastify HTTP requests (excluding `/healthz`, `/readyz`, and WebSocket upgrade requests), non-heartbeat Runtime and Cloud Runner WebSocket frames (`ws.runner.frame.<type>`), Runtime Provider Proxy data-plane streams (`ws.provider_proxy.stream` with `provider`, `requestBytes`, `responseBytes`, and `firstByteMs`), and background worker passes.
- **Domain services (`perfCategory="service"`)** — Public methods on core Server services (including `SandboxRunnerService`, `CloudDeliveryOwner`, `CloudSessionCollaborationOwner`, and `RunnerWorkspaceService`) and trusted Git subprocess invocations (`module="git-subprocess"`, `operation="subprocess.git.<subcommand>"`), wrapped via non-intrusive proxies and context-bound child spans.
- **Database queries (`perfCategory="db"`)** — Every executed Drizzle and `postgres.js` query (`operation="db.query"`), transaction (`operation="db.transaction"`), and savepoint (`operation="db.savepoint"`). Lazy queries that are never awaited and `no_pipeline` readiness probes do not emit records. Records carry `sqlCommand`, `dbTarget`, `paramCount`, `rowCount`, `inTransaction`, and `sqlState` on error, without logging raw SQL text or bound parameters.
- **External service calls (`perfCategory="external"`)** — Outbound requests through `ExternalCallPolicy` (Feishu and Slack), Feishu channel handshakes (`external.feishu.channel.connect`), `McpOutboundFetcher`, GitHub API and proxy transports, Runtime Provider Proxy (`slack`, `feishu`, `github`), Cloud Model and Web Routers, Cloud Run Admin and GCP Metadata Server, S3/GCS object stores, Sandbox Runner control RPCs (`external.sandbox-runner.deliveryDispatch`, `external.sandbox-runner.deliveryRun`, `external.sandbox-runner.deliverySteer`, `external.sandbox-runner.deliveryQuery`, `external.sandbox-runner.sessionMessage`, `external.sandbox-runner.runAcceptance`, and `external.sandbox-runner.sealWorkspace`), remote Skill sources, Channel Target releases, and Error Reporting. Every external call settlement record includes `provider`, `externalService`, `operation`, `durationMs`, `outcome`, `attemptCount`, and `retryCount` (plus `errorCode`, `transportCode`, and `timedOut=true` when a call fails or times out; pre-dispatch rejections record `attemptCount=0`). Streaming responses settle on body EOF or body error rather than header arrival. User-configured or user-content URLs (MCP, Skill sources, Slack file downloads, provider proxy) log `httpMethod` and `targetHost` only; `targetPath` is included only for fixed, server-owned API route templates.

Provider proxy stream failure warnings retain registered IM adapter failure codes, including
`validation_scope`, `operation_not_registered`, and body/header rejection codes, alongside the
existing transport and GitHub allowlists. Unknown codes use `upstream_unavailable`. These warnings
contain only provider and controlled code; they omit raw error messages, paths, headers, bodies,
capabilities, and identities.

Each provider proxy call forwarded by the passthrough rule rather than an explicit operation emits one
`info` record with `code="PROVIDER_PROXY_PASSTHROUGH"`, `provider`, `method`, and a `path`. Feishu paths
keep only `open-apis`, the domain word, the version, and words from a fixed list of Feishu route words;
every other segment becomes `{id}` whatever its shape, and a path without a version segment is redacted
entirely. Slack paths are the fixed `/api/<method>` and are logged as is. The record never carries the
query string, request or response bodies, headers, capabilities, or tokens.

Every started operation generates a unique `callId` and records `startedAt` (ISO-8601 UTC). Its matching
settlement record carries the same `callId` and `startedAt` plus `endedAt` (ISO-8601 UTC) and monotonic
`durationMs`. Nested operations propagate `requestId`, `parentCallId`, `callerOperation`, and Turn/resource
correlation identifiers (`accountId`, `agentId`, `computerId`, `sessionId`, `deliveryId`, `turnId`,
`sandboxId`, and `environmentGeneration`) through `AsyncLocalStorage`, so every database query and external
service call within a Turn can be correlated end to end. Routine completion records emit at
`OPENTAG_PERF_LOG_LEVEL` (default `debug`), while `outcome="started"` records emit at
`OPENTAG_PERF_START_LOG_LEVEL` (default `debug`) and fast database completions (`perfCategory="db"`,
`slow` absent) emit at `OPENTAG_PERF_DB_LOG_LEVEL` (default `debug`). Operations whose `durationMs` meets
or exceeds `OPENTAG_PERF_SLOW_THRESHOLD_MS` attach `slow=true` and emit at `OPENTAG_PERF_LOG_LEVEL`, and
failed operations emit at `warn`. Because the production Google Cloud Ops Agent pipeline uploads `WARNING`
(Pino `warn`) and above by default, failed external calls are always ingested in Cloud Logging; to ingest
routine `started`/`completed` performance records into Cloud Logging during a production bottleneck window
without changing Ops Agent filters, set `OPENTAG_PERF_LOG_LEVEL=warn` (alongside `OPENTAG_LOG_LEVEL=info`
or `debug` for local stdout). Setting `OPENTAG_PERF_LOG_ENABLED=false` bypasses proxy/fetch wrapping and
context allocation.

In addition to paired performance spans, the Server and Cloud Runner emit structured lifecycle and
streaming telemetry:

- **Sandbox lifecycle (`module="sandboxes"`)** — `sandbox.lifecycle.provision` (`startupMode="cold_start"`), `sandbox.lifecycle.borrow` (`startupMode="warm_reuse"`), `sandbox.lifecycle.ready` (`startupDurationMs` on initial promotion, `startupMode="cold_start" | "warm_reuse" | "reconnect"`, `runnerVersion`), `sandbox.lifecycle.seal` (`durationMs`, `outcome`), and `sandbox.lifecycle.release` (`previousLifecycle`).
- **Provider allocation and control connection** — Server allocation performance spans time start/ensure and report readiness outcomes. `sandbox.lifecycle.create_accepted` identifies an accepted v1/v2 create submission, and `sandbox.lifecycle.instance_verified` records the verified instance UID. Runner `runner.connection.auth` measures total time from dialing through an accepted welcome, a renewal-only reply, or an unsuccessful end to the attempt. `wsOpenDurationMs` measures from dialing to WebSocket open, or to the end of an attempt that never opens. Once the socket opens, `authRoundTripMs` measures from the open handler sending the auth frame to the end of the handshake, including rejection, close, or timeout. The phases are rounded independently. `runner.connection.rebind` measures assignment binding or reuse. Match auth records by request ID.
- **Workspace persistence (`module="sandboxes"` on Server, `module="cloud-runner"` on Runner)** — Server-side `runner.workspace.claim`, `runner.workspace.download`, and `runner.workspace.upload` log `sandboxId`, `sessionId`, `environmentGeneration`, `workspaceGeneration`, `archiveBytes`, `saved`, and `sealed`. Runner-side `runner.workspace.restore`, `runner.workspace.save`, and `runner.workspace.seal` emit single-line JSON records to stderr with `durationMs`, `archiveBytes`, `workspaceBytes`, `entryCount`, `workspaceGeneration`, `saved`, and `sealed` (never workspace file paths or contents). Runner claim times the initial metadata fence. Restore streams download and extraction concurrently. `downloadMs` measures request start through consumption of the compressed response, including extraction backpressure. `extractMs` measures from response headers through staged validation, fingerprinting and installation of the verified tree. Use the total restore duration for end-to-end comparisons. Ordinary saves compute their fingerprint within `packMs`. The standalone `fingerprintMs` phase measures the pre-seal check against an existing saved archive. Save also reports upload and uncertain-commit verification durations where applicable. Use matching phase boundaries when comparing versions. Upload includes the object write and its response, and verification covers read-back after a failed response. The Server upload record includes the object-store write span. A save without a prior saved archive has `reason=initial_empty_workspace`, including retries of the initial save. An existing archive is fenced and restored without this save.
- **Runner native sandbox lifecycle (`module="cloud-runner"`)** — `runner.native_sandbox.start`, `runner.native_sandbox.probe`, `runner.native_sandbox.reset`, and `runner.boot.ready` emit single-line JSON records to stderr with `durationMs`, `thresholdMs`, `slow`, `outcome`, and `runnerVersion`.
- **Cloud Model streaming (`module="cloud-model-proxy"`, `operation="cloud_model.chat_completions"`)** — Records `firstEventMs` (time to first upstream chunk), `streamDurationMs`, `responseBytes`, `retryCount`, and `retryWaitMs`.
  `cloud_model_cancel_failed` reports a failure in active upstream cancellation. An upstream body that has already errored, including after a request abort or deadline, has no cancellation work left.
- **MCP probe and Skill archive operations** — `McpProbe` logs `durationMs` on both `"MCP probe succeeded"` and `"MCP probe failed"`. `SkillService` records `normalizeDurationMs` on archive validation and `durationMs` on bundle opening, while `RemoteSkillService` records `openDurationMs` and `durationMs` on source resolution and installation.

## Configuration

Tracing is disabled when `OPENTAG_OTEL_ENDPOINT` is empty. The exporter sends traces to the configured URL exactly as written and accepts any valid OTLP collector headers.

```bash
OPENTAG_OTEL_ENDPOINT=https://logfire-us.pydantic.dev/v1/traces
OPENTAG_OTEL_HEADERS="Authorization=Bearer <write-token>"
OPENTAG_OTEL_ENVIRONMENT=production
OPENTAG_OTEL_SAMPLE_RATE=1
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENTAG_OTEL_ENDPOINT` | empty | OTLP/HTTP traces endpoint; non-empty enables tracing |
| `OPENTAG_OTEL_HEADERS` | empty | Comma-separated `key=value` headers passed unchanged to the OTLP trace exporter |
| `OPENTAG_OTEL_ENVIRONMENT` | `OPENTAG_ENV` | `deployment.environment.name` resource label |
| `OPENTAG_OTEL_SAMPLE_RATE` | `1` | Global head sample rate in the inclusive range `0` to `1` |
| `OPENTAG_LOG_LEVEL` | `info` | Server Pino level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent` |
| `OPENTAG_PERF_LOG_ENABLED` | `true` | Enables paired start/end performance logs across HTTP/WS entrypoints, services, database queries, and external calls |
| `OPENTAG_PERF_LOG_LEVEL` | `debug` | Default Pino level (`debug`, `info`, or `warn`) for routine performance completion records (and slow DB completions) |
| `OPENTAG_PERF_DB_LOG_LEVEL` | `debug` | Pino level (`debug`, `info`, or `warn`) for routine fast database completion records (`perfCategory="db"`) |
| `OPENTAG_PERF_START_LOG_LEVEL` | `debug` | Pino level (`debug`, `info`, or `warn`) for `outcome="started"` performance records |
| `OPENTAG_PERF_SLOW_THRESHOLD_MS` | `1000` | Slow-operation threshold in milliseconds; completions at or above this duration set `slow=true` |
| `GOOGLE_CLOUD_PROJECT` | unset | Forwards relayed Web App and CLI errors to Google Cloud Error Reporting; see [Client error reporting](error-reporting.md) |
| `OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON` | unset | Service account key JSON for that forwarding; unset uses Application Default Credentials |

The service resource is fixed to `service.name=opentag-server`. Every process also emits its random startup identity as `service.instance.id`, which distinguishes replicas and restarts.

For CapRover, add the four values as app environment variables and mark the header value as secret. Do not commit a Logfire token to `.env.example`, Docker image layers, repository files, or CapRover build arguments. Restart the app after changing tracing configuration.

The endpoint and attribute vocabulary remain OTLP-oriented. Logfire is the currently documented backend, but collectors using an API key, tenant headers, non-Bearer authorization, or a custom trace path are also supported. Malformed or duplicate header entries fail server startup without echoing their values.

The server owns an explicit OpenTelemetry trace provider and OTLP exporter. Only the canonical Fastify instrumentation and openTag's explicit business spans are accepted. Logfire's automatic process exception reporting and Node auto-instrumentations are not installed, so Pino records, PostgreSQL queries, outbound transports, and arbitrary process errors cannot bypass the telemetry scrubber.

## What is traced

- One root span per ordinary Fastify request, with route-template names and `x-trace-id` response correlation. Health, readiness, static assets, and the Runtime WebSocket upgrade are excluded.
- `runtime.ws.connection` plus short, non-heartbeat Runtime business-frame spans.
- Short Feishu connection attempt, transition, and error spans.
- One independent `im.inbound.process` root per Feishu SDK callback, including normalize and persistence failures.
- Provider-neutral `im.inbound.persist`, delivery/recovery, and Runtime reconcile/delivery/report spans.

Asynchronous jobs intentionally use independent roots. Search by stable attributes instead of expecting one continuous parent chain:

- `opentag.im.binding.id`
- `opentag.im.provider_event.id`
- `opentag.im.external_message.id`
- `opentag.im.message.id`
- `opentag.im.delivery.id`
- `opentag.session.id`
- `opentag.sandbox.id`
- `opentag.sandbox.environment_generation`
- `opentag.agent.id`
- `opentag.computer.id`
- `opentag.runtime.connection.id`
- `opentag.runtime.instance.id`
- `opentag.runtime.protocol.version`

Message text, raw provider events, mentions, resources, sender identity, provider response bodies, prompts, model output, tool payloads, authorization headers, cookies, tokens, secrets, and credentials are excluded or scrubbed.

## Feishu inbound deduplication

Feishu inbound delivery has two independent deduplication keys:

- The in-memory adapter fast path scopes an envelope event ID and the message/revision identity to the
  tenant and conversation. It is bounded to 10 minutes and 10,000 entries, so it only protects a live
  process from immediate WebSocket retries.
- The durable receipt claim uses `(im_binding_id, event_id)`. The unique index on
  `feishu_inbound_receipts` is the cross-instance winner election. A successful claim is marked
  `processed` after inbox persistence, or `failed` with a bounded diagnostic code when processing
  fails.
- Inbox persistence independently enforces `(im_binding_id, channel_id, external_message_id,
  provider_revision_key)`. Therefore a different envelope event ID cannot create a second revision of
  the same logical message, while an edited or recalled revision remains actionable.

Feishu does not always include an envelope `event_id`. In that case normalization creates a stable
message/revision fallback for the inbox only; no durable receipt row is claimed. The binding and
conversation-scoped semantic unique key remains the authority for retries without an envelope ID.
Receipt rows are operational evidence and should be retained for 30 days. A scheduled database
maintenance job may delete only `processed` or `failed` rows older than that window; never delete
`processing` rows as part of routine cleanup, because they identify an in-flight delivery.

Duplicate outcomes are redacted and stable: the `feishu.inbound.deduplicated` span records the binding,
provider event ID when available, external message ID, and `duplicate=true`, but never tokens or message
content. A duplicate is acknowledged without a second inbox write, Session run, Task, or context entry.

## IM history and delivery retention

The IM delivery worker runs a bounded expiry pass every 5 seconds by default. Retention runs in its own bounded pass
every 60 seconds by default because its 90-day window does not need the expiry cadence. Retention is based on
`occurred_at` for messages, `expires_at` for deliveries, and `received_at` for provider receipts.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENTAG_IM_DELIVERY_JANITOR_INTERVAL_MS` | `5000` | Expiry pass interval |
| `OPENTAG_IM_DELIVERY_RETENTION_INTERVAL_MS` | `60000` | Retention pass interval |
| `OPENTAG_IM_DELIVERY_EXPIRY_BATCH_SIZE` | `100` | Maximum pending deliveries marked `expired` per pass |
| `OPENTAG_IM_DELIVERY_RETENTION_BATCH_SIZE` | `100` | Maximum rows removed from each history table per pass |
| `OPENTAG_IM_MESSAGES_RETENTION_MS` | 90 days | `im_messages` retention window |
| `OPENTAG_IM_MESSAGE_DELIVERIES_RETENTION_MS` | 90 days | `im_message_deliveries` retention window |
| `OPENTAG_SLACK_WEBHOOK_RECEIPTS_RETENTION_MS` | 30 days | Slack receipt retention window |
| `OPENTAG_FEISHU_INBOUND_RECEIPTS_RETENTION_MS` | 30 days | Feishu receipt retention window |

The janitor never removes a delivery belonging to a live Session, a delivery still referenced as a steer target, or
an in-flight (`processing`) receipt. It removes only terminal delivery rows (`expired`, `terminal_rejected`, reported
`accepted`, or completed `steered` rows), and removes a message only after no delivery references it. Set explicit
windows and batch sizes through the environment when the deployment needs a different audit period; values must be
positive integers in milliseconds or rows.

## Troubleshooting a silent Feishu Bot

Start with current state:

```bash
opentag agent im diagnose <agent-id>
```

Then query traces for the incident time window:

1. Filter `feishu.connection.connect`, `feishu.connection.transition`, and `feishu.connection.error` by `opentag.im.binding.id`. Confirm that a current replica connected and did not enter a reconnect or credential failure loop.
2. Search for `im.inbound.process` with the same binding. Its presence proves the openTag SDK callback ran; its error code separates admission, normalization, fencing, and persistence failures.
3. When persistence succeeded, follow `opentag.im.message.id` and `opentag.im.delivery.id` into `im.delivery.dispatch`, `runtime.reconcile`, `runtime.delivery`, and `runtime.report`.
4. If the Agent ran but no reply appeared, inspect the Agent trace, the provider CLI result, and the Turn report's captured Lark outgoing-reply snapshot when present. openTag does not trace provider outbound writes; Task history may include bounded send receipts, which are not read receipts.

No `im.inbound.process` span means openTag did not observe the provider callback during the sampled window. It does not prove that Feishu delivered the event. Combine that negative evidence with `connection`, `lastInboundAt`, `providerCliReadiness`, granted scopes, and Feishu event-subscription state.

## Production monitoring on Google Cloud

The production Server runs on one Compute Engine VM with a dedicated Cloud SQL instance, both in the production Google
Cloud project. This page states the reusable parts only: the policy thresholds, the probe choice, and the log pipeline.
The repository is public, so it does not carry the project, VM, or instance names; read those from the Cloud Monitoring
console. Cloud Monitoring watches the Server from outside and through the platform metrics:

| Signal | Policy | Threshold | Notifies |
| --- | --- | --- | --- |
| Uptime check on `https://app.opentag.build/readyz`, content must contain `"status":"ready"`, every 60 s from four regions | Production down | Fails from more than one region for 3 minutes | Email and SMS |
| Same uptime check, certificate lifetime | TLS certificate expiry | Less than 14 days left | Email |
| Cloud SQL disk utilization | Database disk | Above 80% for 10 minutes | Email and DB alert email |
| Cloud SQL memory utilization | Database memory | Above 90% for 10 minutes | Email and DB alert email |
| Cloud SQL CPU utilization | Database CPU | Above 50% for 5 minutes | Email, SMS, and DB alert email |
| Production VM CPU utilization | VM CPU | Above 85% for 10 minutes | Email |
| VM memory used (Ops Agent) | VM memory | Above 90% for 10 minutes | Email |
| VM root disk `/dev/sda1` used (Ops Agent) | VM root disk | Above 85% for 10 minutes | Email |
| Server log at `CRITICAL` (Pino `fatal`), including `SERVER_PROCESS_FATAL` | Fatal log | Any entry; at most one notice per 10 minutes | Email and SMS |
| Server log at `ERROR` or above, other than `IM_DELIVERY_RUNTIME_UNAVAILABLE` | New error type | Any entry; at most one notice per 30 minutes | Email |

`/readyz` is the probe target because it answers `503` until bootstrap readiness has completed all four stages
(`configuration`, `migration`, `application`, `listen`), and again whenever the database probe fails. `/healthz` only
proves that the process is up. The check needs no credential.

Database readiness combines `select 1` on a dedicated single connection with a query on the shared
application pool, each bounded to 1 s. The shared probe waits for an idle connection and runs exclusively,
so its short deadline cannot interrupt a healthy query ahead of it or behind it in a pipeline. Concurrent checks share one attempt. A healthy dedicated connection
cannot hide an exhausted application pool. An expired queued probe is removed; a probe that loses its
transport discards that connection. Plain `/healthz` remains liveness-only.

PostgreSQL cancels application statements after `OPENTAG_DATABASE_STATEMENT_TIMEOUT_MS` (default 30 s,
SQLSTATE `57014`) and terminates sessions idle inside a transaction after
`OPENTAG_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` (default 60 s). Application connections use 10 s TCP keepalive.
The startup log `Resolved database timeouts` records the configured application bounds.

The pinned postgres.js patch supplies the remaining client transport bound, including pool queue time:
`OPENTAG_DATABASE_QUERY_TIMEOUT_MS` (default 35 s). It applies to ordinary queries and the driver's own
`BEGIN`, `SAVEPOINT`, `COMMIT`, and `ROLLBACK`. Expired queued work is removed without affecting healthy
holders; an expired dispatched operation destroys its socket and frees that pool slot. Closed transactions
remain invalid after a new connection opens, so late callbacks cannot write or commit outside their original
transaction. Application callbacks still own their non-database work. A lost write or `COMMIT` response leaves
its outcome unknown; disposal does not prove rollback and never automatically replays the operation.
The deadline warning carries only `check: "database"` and `timeoutMs`, without SQL or parameters.

Routine migrations use native limits of 5 s to connect, 2 s per lock acquisition, and 5 s per statement.
On PostgreSQL 17 or later, native `transaction_timeout` also caps the migration transaction at 10 s. The whole migration operation has a
15 s client budget, including connection, advisory lock, every pending migration, commit acknowledgement and
unlock; it does not restart for each file. PostgreSQL 16 uses a stricter 10 s client operation budget instead of the unsupported native transaction limit;
its native statement and transaction-idle limits still apply. Verification has a 10 s total budget. Direct timeout parameters in the connection URL cannot disable this startup policy. Losing the dedicated startup session invalidates the attempt;
a replacement cannot inherit its advisory lock. Failure ends that startup attempt without widening its budget.
Large index builds and bulk backfills require a separate measured execution, compatibility and recovery design.

HTTP request stages and producer work drain before the first database-pool close.
Shutdown also joins a pending listen attempt and cannot restart prewarm or publish
readiness after a stop request.

Database shutdown supplies `end({ timeout: 1 })` on its first call, including startup cleanup. After the graceful
budget the driver destroys remaining sockets, even if a peer withholds its closing acknowledgement.
Unsent global work is rejected when closing starts; admitted transactions can still finish within that budget.
Graceful close waits for physical socket closure even when the last query has already completed. Cleanup
has its own 1 s budget. Other worker shutdown waits are independent. A resource cleanup failure does not skip
later workers, database disposal or telemetry cleanup. Signal shutdown logs each failed resource and its redacted
cause, then exits with code 1; a clean shutdown exits normally. Keep the patch until an upstream release
passes the database timeout, disconnect, startup and availability regressions.

Startup failure follows the same cleanup rule: application, Cloud model, billing, shared database pool and telemetry cleanup are
attempted independently, including failures before the application and its close hooks exist. Direct database admin
commands use the same 1 s connection-close budget. The original failure and nested cleanup errors are reported once through secret
redaction, and the failure path sets exit code 1 even when cleanup rejects.

The Cloud Monitoring uptime check stays on `/readyz`. `/healthz?deep=1` is an additional probe for an external uptime
monitor that should not depend on bootstrap stages or deployment headers; it does not replace the `/readyz` check, which
still owns the bootstrap and application-stage signal. The deep probe returns `200` with
`{"status":"ok","service":"opentag-server","checks":{"database":"ok"}}` when the database probe passes, and `503`
with `"status":"degraded"` and `"database":"fail"` when it fails or exceeds the one-second deadline. It reuses the
`/readyz` database probe, never includes error text in the body, and logs the redacted error at `warn`. Only `deep=1`
and `deep=true` enable it.

The image `HEALTHCHECK` and `opentag doctor` keep the plain, database-independent `/healthz`. A health-triggered
container restart cannot repair a database outage: the `postgres` client reconnects on the next query, while the
replacement boots into migrations against the same unavailable database. It would also drop live Computer and Runner
connections, so the deep probe stays a monitoring signal only.

### Server logs in Cloud Logging

The Ops Agent on the production VM tails the Docker `json-file` logs under `/var/lib/docker/containers/` and writes the
log `opentag_server`. Each line is a Docker wrapper around a Pino line, so the pipeline unwraps both layers. Pino writes
`level` as a number, which the agent's `map_values` cannot match, so a regex first captures it as a string and then maps
`40`, `50`, and `60` to `WARNING`, `ERROR`, and `CRITICAL`. The agent keeps only `WARNING` and above, and drops `info`
lines and the CapRover nginx lines before upload, which keeps volume low and keeps routine resource identifiers on the
host. Entries carry the label `service=opentag-server`. The agent config is `/etc/google-cloud-ops-agent/config.yaml`.

- `exclude_logs` rejects `<` comparisons and panics the logging sub-agent at start, so the filter uses a regex on
  `severity`. Validate any edit before restarting with
  `google_cloud_ops_agent_engine -service=fluentbit -in <file> -logs <dir> -state <dir>`.
- The agent reads new lines only. A restart does not replay older logs.
- `IM_DELIVERY_RUNTIME_UNAVAILABLE` is still excluded from the new-error alert. The exclusion exists because an offline
  Computer was retried at a fixed interval; the delivery worker now retries at a falling rate and reports a repeated
  failure once, so the exclusion is no longer what keeps the alert quiet, and it hides a genuine return of the code.
  Dropping it is a pending operational step in the Cloud Monitoring policy, not a change this repository can make: the
  table above states the current policy, including that exclusion. Remove the exclusion in the console and delete this bullet in the same
  change. A temporary exclusion may only be added with a written exit condition, never as the permanent state.
- Every delivery diagnostic carries `phase` plus the durable identifiers `deliveryId`, `agentId`, `computerId`, and
  `attemptCount` in `jsonPayload`, so one production error can be attributed to one delivery. No message body, prompt,
  credential, or provider payload is included.
- The agent collects host metrics only. The Docker engine metrics endpoint that the staging VM scrapes needs a Docker
  daemon restart, which restarts the Server container, so it is not enabled on production.

Known gaps:

- Staging is not probed. It is publicly reachable on its own public URL, so this is a missing uptime check rather than a
  reachability limit.
- The Server is a single VM, so a VM outage also stops its own logs; the uptime check covers that case.

## Sampling and limits

The default sample rate is `1`. Keep production at `1` while traffic is low and silent-message incidents are rare; lower the single global rate only after measuring trace volume and cost. The MVP does not use route-specific or provider-specific sampling.

Known limits:

- Async roots are correlated by business IDs, not persisted W3C trace context.
- A server restart loses in-memory parent context and pending connection spans.
- There is no OpenTelemetry Logs exporter, metrics exporter, Client tracing, Agent trace conversion, or PostgreSQL query tracing.
- A missing inbound callback cannot produce message-specific IDs or a message span.
