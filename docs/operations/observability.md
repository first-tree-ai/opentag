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
| Account boundary | `accountId` | Tenant boundary for an Agent and its resources. |
| Agent, Computer, Session, Delivery | `agentId`, `computerId`, `sessionId`, `deliveryId` | Stable resource identifiers. |
| Provider | `provider` | A provider name such as `feishu` or `slack`. |
| Outcome | `outcome` | A stable state transition such as `accepted`, `failed`, or `rejected`. |
| Error identity | `errorCode` | Use the structured error code. Do not invent `reason`, `errorReason`, `failureReason`, `dropReason`, or `detail` for the same concept. |
| Attempt | `attempt` | Numeric retry or execution attempt. |
| Duration | `durationMs` | Elapsed time in milliseconds. |
| Status | `status` | Protocol or provider status when it is not an outcome. |

Level has an operational meaning: `error` is terminal or unrecoverable, `warn` is handled or degraded, `info` is a
state transition, and `debug` is per-request detail. Keep messages short and put queryable values in the fields above.

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

## Cloud Pi phase diagnostics

Cloud Turn workers emit a bounded diagnostic stream independently of `OPENTAG_LOG_LEVEL`.
The worker writes fixed-prefix JSON lines to stderr; the parent consumes them while native
`exec` is still running and writes standalone JSON lines to the Runner's existing stderr.
No diagnostic is stored in the workspace, database, or Turn report. Local Pi runs do not enable
this stream.

The parent owns `turnId`, `deliveryId` (or `messageId` for Session collaboration), `sessionId`,
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

Each phase has `start` and `end` or `failure` records. `durationMs` measures the current phase,
`elapsedMs` measures worker elapsed time, and `seq` orders worker records. All use process-local
monotonic clocks; `receivedElapsedMs` is the parent's independent receive clock. Never subtract
clocks across processes. The parent `worker_end` summary uses `durationMs` for the entire native
exec span, not the last RPC. Existing RPC budgets, compaction handling, Turn deadlines, cancellation,
retry, stdout completion, and report classification are unchanged.

Prompt diagnostics include compaction count and duration, the current acceptance-window sequence
and elapsed time, and whether its timer is paused. These observe the existing pause/re-arm hooks.
Total prompt wall time can exceed the RPC budget during compaction. An acknowledged prompt's
timer is already cleared, so its end record reports it as paused. Cancellation before acknowledgement
records the aborted RPC in `prompt_acceptance` and does not enter `await_terminal`.

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
| Server log at `CRITICAL` (Pino `fatal`); no server code emits it yet, see Known gaps | Fatal log | Any entry; at most one notice per 10 minutes | Email and SMS |
| Server log at `ERROR` or above, other than `IM_DELIVERY_RUNTIME_UNAVAILABLE` | New error type | Any entry; at most one notice per 30 minutes | Email |

`/readyz` is the probe target because it answers `503` until bootstrap readiness has completed all four stages
(`configuration`, `migration`, `application`, `listen`), and again whenever the database probe fails. `/healthz` only
proves that the process is up. The check needs no credential.

The database probe runs `select 1` on its own single connection, not on the application pool, and fails after 1 s.
On that deadline the Server destroys the probe connection and opens a new one on the next probe. At most two probe
attempts younger than 10 s count as live; an older attempt no longer holds a slot. A database outage therefore turns
`/readyz` to `503`, and `/readyz` returns to `200` within about 10 s after the database answers again.

Application queries have two bounds. PostgreSQL cancels a statement after `OPENTAG_DATABASE_STATEMENT_TIMEOUT_MS`
(SQLSTATE `57014`) and ends a session that stays idle inside a transaction after
`OPENTAG_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`. When the server does not answer, for example on a lost network path,
the Server rejects the query after `OPENTAG_DATABASE_QUERY_TIMEOUT_MS` and logs the warning
`Database query exceeded client deadline` with `check: "database"` and `timeoutMs`. The log has no SQL text or
parameters. Pool connections send TCP keepalive probes after 10 s idle. Startup logs the resolved values once as
`Resolved database timeouts`.

A transaction gets the same bound where the server cannot help. postgres.js sends `commit`, `rollback`, and a nested
transaction's opening `savepoint` itself, so the Server bounds those phases separately: the scope gets
`OPENTAG_DATABASE_QUERY_TIMEOUT_MS` until the callback starts, and the commit or rollback that follows gets the same
window again. A callback that already failed on a query deadline rejects at once. Either way the caller stops waiting,
while the connection stays busy until TCP gives up, the same limit as a timed-out single query. A deadline during
`commit` leaves the outcome unknown, not rolled back: the transaction may have committed on the server.

The pinned postgres.js dependency patch invalidates a transaction when its connection closes. In-flight and queued
queries reject, and later statements and savepoints from that callback reject even after the pool reconnects. Its
commit or rollback cannot act on a replacement transaction. The driver clears the closed connection's buffered writes
and protocol error state before reuse. Application callbacks still need to finish their own non-database work; the
driver does not cancel arbitrary JavaScript or replay the transaction. Replace the patch only with an upstream version
that passes the database disconnect process regressions.

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
- `IM_DELIVERY_RUNTIME_UNAVAILABLE` is excluded from the new-error alert because it fires continuously. Remove the
  exclusion once its cause is fixed, so that its return is visible.
- The agent collects host metrics only. The Docker engine metrics endpoint that the staging VM scrapes needs a Docker
  daemon restart, which restarts the Server container, so it is not enabled on production.

Known gaps:

- Staging is not probed. It is publicly reachable on its own public URL, so this is a missing uptime check rather than a
  reachability limit.
- A crash produces no `fatal` line. Nothing in the Server calls `.fatal(` and no `uncaughtException` or
  `unhandledRejection` handler is installed, so Node prints a plain-text stack that carries no Pino `level`. The
  severity filter cannot match that line, so it never reaches Cloud Logging. A crash is therefore visible only as an
  uptime-check failure, and a crash that restarts faster than the 3-minute threshold is invisible. Install a
  process-level `fatal` log before relying on the `CRITICAL` policy.
- The Server is a single VM, so a VM outage also stops its own logs; the uptime check covers that case.

## Sampling and limits

The default sample rate is `1`. Keep production at `1` while traffic is low and silent-message incidents are rare; lower the single global rate only after measuring trace volume and cost. The MVP does not use route-specific or provider-specific sampling.

Known limits:

- Async roots are correlated by business IDs, not persisted W3C trace context.
- A server restart loses in-memory parent context and pending connection spans.
- There is no OpenTelemetry Logs exporter, metrics exporter, Client tracing, Agent trace conversion, or PostgreSQL query tracing.
- A missing inbound callback cannot produce message-specific IDs or a message span.
