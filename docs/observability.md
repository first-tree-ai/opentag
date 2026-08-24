# Server observability

[简体中文](./zh-CN/observability.md)

OpenTag Server can export optional OpenTelemetry traces through OTLP/HTTP. The implementation is disabled by default and covers provider connections, IM ingress, durable delivery, and Runtime lifecycle boundaries.

Tracing is not log shipping. Pino continues to write server logs to stdout, and this feature does not upload all stdout logs to Logfire. Logfire receives spans, span attributes, and bounded exception events only.

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

The service resource is fixed to `service.name=opentag-server`. Every process also emits its random startup identity as `service.instance.id`, which distinguishes replicas and restarts.

For CapRover, add the four values as app environment variables and mark the header value as secret. Do not commit a Logfire token to `.env.example`, Docker image layers, repository files, or CapRover build arguments. Restart the app after changing tracing configuration.

The endpoint and attribute vocabulary remain OTLP-oriented. Logfire is the currently documented backend, but collectors using an API key, tenant headers, non-Bearer authorization, or a custom trace path are also supported. Malformed or duplicate header entries fail server startup without echoing their values.

The server owns an explicit OpenTelemetry trace provider and OTLP exporter. Only the canonical Fastify instrumentation and OpenTag's explicit business spans are accepted. Logfire's automatic process exception reporting and Node auto-instrumentations are not installed, so Pino records, PostgreSQL queries, outbound transports, and arbitrary process errors cannot bypass the telemetry scrubber.

## What is traced

- One root span per ordinary Fastify request, with route-template names and `x-trace-id` response correlation. Health, readiness, static assets, and the Runtime WebSocket upgrade are excluded.
- `runtime.ws.connection` plus short, non-heartbeat Runtime business-frame spans.
- Short Feishu connection attempt, transition, and error spans.
- One independent `im.inbound.process` root per Feishu SDK callback, including normalize and persistence failures.
- One `im.inbound.process` span per Slack Events API delivery, nested under the request span, covering acknowledged,
  ignored, rejected, and failed outcomes.
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

Slack ingress adds bounded attributes on `im.inbound.process`: `slack.envelope_type`, `slack.event_type`,
`slack.subtype`, `slack.ignored_reason`, `slack.retry_num`, `slack.retry_reason`, and `slack.ingest.duration_ms`. Every
Slack-controlled label is matched against `^[a-z0-9_.]{1,64}$` and reported as `other` when it does not fit, and
`slack.retry_reason` is narrowed to Slack's documented values, so a Slack-chosen string can never become unbounded
attribute cardinality.

Message text, raw provider events, mentions, resources, sender identity, provider response bodies, prompts, model output, tool payloads, authorization headers, cookies, tokens, secrets, and credentials are excluded or scrubbed.

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

## Troubleshooting a silent Slack Bot

Start with current state, as with Feishu:

```bash
opentag agent im diagnose <agent-id>
```

Slack ingress is request-driven rather than connection-driven, so there are no connection spans to check. Query
`im.inbound.process` with `opentag.im.provider = slack` for the incident window and read `opentag.operation.outcome`:

| Outcome | What it means | Where to look next |
| --- | --- | --- |
| `succeeded` | The event was normalized and persisted. | Follow `opentag.im.message.id` into delivery and Runtime spans. |
| `ignored` | OpenTag answered `200` on purpose and ingested nothing. | Read `slack.ignored_reason`. |
| `rejected` | OpenTag answered non-2xx. The caller should stop sending this request unchanged. | Read `opentag.error.code`. |
| `failed` | Processing threw. Slack will retry. | Read `opentag.error.code`. |

The typed failure codes are:

- `SLACK_INBOUND_SIGNATURE_INVALID` — the signature did not verify against the stored Signing Secret.
- `SLACK_INBOUND_UNROUTABLE` — no binding matched, or the body could not establish a route at all.
- `SLACK_INBOUND_IDENTITY_MISMATCH` — the envelope's App or Team did not match the binding.
- `SLACK_INBOUND_UNSUPPORTED_EVENT` — well-formed and routable, but not an event type or subtype OpenTag ingests.
- `SLACK_INBOUND_NORMALIZE_FAILED` — the verified event could not be normalized.
- `SLACK_INBOUND_DATABASE_FAILED` — persistence failed.
- `SLACK_INBOUND_FAILED` — an unclassified processing failure.

### The event-subscription failure budget

Slack disables an App's event subscription when more than roughly 95% of deliveries fail within a 60-minute window, and
it counts every non-2xx response as a failure. A silent Bot is therefore often a *disabled subscription* caused by
earlier errors rather than a fault in the current request path.

OpenTag reserves non-2xx for requests a caller should stop sending unchanged: signature failure, an unroutable or
unknown binding, an App/Team identity mismatch, and structurally invalid bodies. Those responses also carry
`x-slack-no-retry`, because a redelivery would fail identically. A well-formed, routable callback whose event type or
subtype OpenTag deliberately ignores answers `200` with `{"ok":true,"ignored":"<reason>"}` and records
`slack.ignored_reason`, so ordinary system-message traffic never spends the budget.

When a subscription is already disabled, no request arrives and therefore no span exists. Absence of
`im.inbound.process` is not evidence that Slack delivered anything; check the App's **Event Subscriptions** page for a
disabled subscription, then combine that with `lastInboundAt`, `providerCliReadiness`, and granted scopes.

### Signing-secret regeneration

Regenerating the Signing Secret in the Slack App configuration invalidates every signature OpenTag can verify. The
symptom is a burst of `rejected` spans with `SLACK_INBOUND_SIGNATURE_INVALID` for a binding that was previously healthy,
and — because those are non-2xx — the failure budget starts draining immediately. Recover by submitting the new secret
through **Edit credentials** on the IM page; see [Slack App setup](./slack-app-setup.md). A rotation that OpenTag does
not know about is indistinguishable from an attacker's forged signature, which is why it is rejected rather than
acknowledged.

### `app_rate_limited`

Slack sends an `app_rate_limited` envelope instead of events when a workspace exceeds the event delivery limit for a
minute. OpenTag acknowledges it with `200`, records a `slack.app_rate_limited` span event carrying
`slack.minute_rate_limited`, and logs a `SLACK_APP_RATE_LIMITED` warning. No binding column stores it, so the span is
the only durable record. Events for that minute were dropped by Slack and are never redelivered, so a gap in message
history around such a span is expected rather than an OpenTag defect.

### Retries and duplicates

Slack redelivers an event up to three times after a non-2xx or slow response, with `X-Slack-Retry-Num` and
`X-Slack-Retry-Reason`. Both headers are read before signature verification, so they are treated as untrusted: the
number is length-bounded and the reason is narrowed to Slack's documented set. They are recorded as `slack.retry_num`
and `slack.retry_reason` on both the ingress and persistence spans. Provider-event uniqueness makes the retry a no-op,
so several `200` responses for one `opentag.im.provider_event.id` with only one stored message is the expected shape,
not double delivery.

## Sampling and limits

The default sample rate is `1`. Keep production at `1` while traffic is low and silent-message incidents are rare; lower the single global rate only after measuring trace volume and cost. The MVP does not use route-specific or provider-specific sampling.

Known limits:

- Async roots are correlated by business IDs, not persisted W3C trace context.
- A server restart loses in-memory parent context and pending connection spans.
- There is no OpenTelemetry Logs exporter, metrics exporter, Client tracing, Agent trace conversion, or PostgreSQL query tracing.
- A missing inbound callback cannot produce message-specific IDs or a message span.
