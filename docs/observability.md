# Server observability

[简体中文](./zh-CN/observability.md)

OpenTag Server can export optional OpenTelemetry traces through OTLP/HTTP. The implementation follows First Tree's disabled-by-default, trace-only model, while adding spans for OpenTag's provider connections, IM ingress, durable delivery, Runtime, and outbound message boundaries.

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
- Provider-neutral `im.inbound.persist`, delivery/recovery, Runtime reconcile/delivery/report, and outbound spans.

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

## Troubleshooting a silent Feishu Bot

Start with current state:

```bash
opentag agent im diagnose <agent-id>
```

Then query traces for the incident time window:

1. Filter `feishu.connection.connect`, `feishu.connection.transition`, and `feishu.connection.error` by `opentag.im.binding.id`. Confirm that a current replica connected and did not enter a reconnect or credential failure loop.
2. Search for `im.inbound.process` with the same binding. Its presence proves the OpenTag SDK callback ran; its error code separates admission, normalization, fencing, and persistence failures.
3. When persistence succeeded, follow `opentag.im.message.id` and `opentag.im.delivery.id` into `im.delivery.dispatch`, `runtime.reconcile`, `runtime.delivery`, and `runtime.report`.
4. For reply failures, search `im.outbound.execute` by `opentag.session.id`, `opentag.agent.id`, or `opentag.request.id`.

No `im.inbound.process` span means OpenTag did not observe the provider callback during the sampled window. It does not prove that Feishu delivered the event. Combine that negative evidence with `connection`, `lastInboundAt`, `runtimeToolAvailable`, granted scopes, and Feishu event-subscription state.

## Sampling and limits

The default sample rate is `1`. Keep production at `1` while traffic is low and silent-message incidents are rare; lower the single global rate only after measuring trace volume and cost. The MVP does not use route-specific or provider-specific sampling.

Known limits:

- Async roots are correlated by business IDs, not persisted W3C trace context.
- A server restart loses in-memory parent context and pending connection spans.
- There is no OpenTelemetry Logs exporter, metrics exporter, Client tracing, Agent trace conversion, or PostgreSQL query tracing.
- A missing inbound callback cannot produce message-specific IDs or a message span.
