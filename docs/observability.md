# Server observability

[简体中文](./zh-CN/observability.md)

OpenTag Server can export optional OpenTelemetry traces through OTLP/HTTP. The implementation is disabled by default and covers provider connections, IM ingress, durable delivery, and Runtime lifecycle boundaries.

Tracing is not log shipping. Pino continues to write server logs to stdout, and this feature does not upload all stdout logs to Logfire. Logfire receives spans, span attributes, and bounded exception events only.

## Logging contract

Logs use a fixed vocabulary. Use one key for each concept so dashboards and later adoption lanes do not have to merge
synonyms:

| Concept | Pino field | Notes |
| --- | --- | --- |
| Module | `module` | Owning package or service boundary. |
| Operation | `operation` | Stable operation name, not a free-form explanation. |
| Request correlation | `requestId` | HTTP or client request identifier. |
| Workspace boundary | `workspaceId` | Tenant boundary for an Agent and its resources. |
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

`imAttrs()` and `runtimeAttrs()` are OpenTelemetry helpers. They emit dotted span keys such as
`opentag.im.binding.id` and `opentag.runtime.connection.id`; do **not** pass their result as a Pino payload. Map values to
the fixed camelCase Pino vocabulary instead.

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

The service resource is fixed to `service.name=opentag-server`. Every process also emits its random startup identity as `service.instance.id`, which distinguishes replicas and restarts.

For CapRover, add the four values as app environment variables and mark the header value as secret. Do not commit a Logfire token to `.env.example`, Docker image layers, repository files, or CapRover build arguments. Restart the app after changing tracing configuration.

The endpoint and attribute vocabulary remain OTLP-oriented. Logfire is the currently documented backend, but collectors using an API key, tenant headers, non-Bearer authorization, or a custom trace path are also supported. Malformed or duplicate header entries fail server startup without echoing their values.

The server owns an explicit OpenTelemetry trace provider and OTLP exporter. Only the canonical Fastify instrumentation and OpenTag's explicit business spans are accepted. Logfire's automatic process exception reporting and Node auto-instrumentations are not installed, so Pino records, PostgreSQL queries, outbound transports, and arbitrary process errors cannot bypass the telemetry scrubber.

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

## Troubleshooting a silent Feishu Bot

Start with current state:

```bash
opentag agent im diagnose <agent-id>
```

Then query traces for the incident time window:

1. Filter `feishu.connection.connect`, `feishu.connection.transition`, and `feishu.connection.error` by `opentag.im.binding.id`. Confirm that a current replica connected and did not enter a reconnect or credential failure loop.
2. Search for `im.inbound.process` with the same binding. Its presence proves the OpenTag SDK callback ran; its error code separates admission, normalization, fencing, and persistence failures.
3. When persistence succeeded, follow `opentag.im.message.id` and `opentag.im.delivery.id` into `im.delivery.dispatch`, `runtime.reconcile`, `runtime.delivery`, and `runtime.report`.
4. If the Agent ran but no reply appeared, inspect the Agent trace and the provider CLI result. OpenTag does not receive or trace provider outbound writes.

No `im.inbound.process` span means OpenTag did not observe the provider callback during the sampled window. It does not prove that Feishu delivered the event. Combine that negative evidence with `connection`, `lastInboundAt`, `providerCliReadiness`, granted scopes, and Feishu event-subscription state.

## Sampling and limits

The default sample rate is `1`. Keep production at `1` while traffic is low and silent-message incidents are rare; lower the single global rate only after measuring trace volume and cost. The MVP does not use route-specific or provider-specific sampling.

Known limits:

- Async roots are correlated by business IDs, not persisted W3C trace context.
- A server restart loses in-memory parent context and pending connection spans.
- There is no OpenTelemetry Logs exporter, metrics exporter, Client tracing, Agent trace conversion, or PostgreSQL query tracing.
- A missing inbound callback cannot produce message-specific IDs or a message span.
