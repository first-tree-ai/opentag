# Error taxonomy and background supervision

[简体中文](./zh-CN/error-taxonomy.md)

OpenTag reports operational failures as a small, structured diagnostic event. The event is safe to
send to a log sink, metric exporter, or trace because the payload is redacted before it crosses that
boundary. A structured error is an operational contract, not an API response contract: keep the
existing `ErrorEnvelope` for client-facing HTTP responses.

## Shape

`StructuredErrorSchema` requires these fields:

| Field | Meaning |
| --- | --- |
| `code` | Stable, bounded identifier for dashboards and alert rules. Use an uppercase domain prefix where possible. |
| `category` | High-level failure class from the table below. |
| `retryability` | The safe retry policy. A retry still requires an idempotent operation and a caller-owned deadline. |
| `phase` | Lifecycle boundary where the failure was observed. |
| `message` | Short human-readable detail. It is bounded and must not contain credentials or request content. |
| `requestId` | Optional request or delivery correlation identifier. Do not use a token or provider credential. |
| `cause` | Optional bounded chain of similarly safe cause fields. Raw exception objects do not cross the boundary. |

### Categories

| Category | Use for |
| --- | --- |
| `validation` | Input, protocol, or schema data is invalid. |
| `auth` | Authentication material is absent, expired, or invalid. |
| `authorization` | The principal is known but is not allowed to perform the operation. |
| `unavailable` | A required service or runtime cannot currently be reached. |
| `timeout` | A bounded deadline elapsed before completion. |
| `internal` | An unexpected OpenTag failure with no safer classification. |
| `conflict` | The requested state conflicts with a newer or exclusive state. |
| `not_found` | The addressed resource does not exist in this boundary. |
| `rate_limit` | Work was rejected by a local or provider quota. |
| `protocol` | A peer sent an unsupported or malformed protocol frame. |
| `configuration` | Local configuration is missing or inconsistent. |
| `cancelled` | Work ended because its owner or shutdown signal cancelled it. |
| `dependency` | A dependency returned a failure that is not better described as unavailable or timeout. |

### Retryability

| Value | Meaning |
| --- | --- |
| `never` | Do not retry automatically. Fix input, state, permission, or code first. |
| `immediate` | A single immediate retry is safe. Use only for a transient, idempotent operation. |
| `backoff` | Retry with bounded exponential backoff and jitter. Stop at the caller's deadline or attempt budget. |
| `after_auth` | Retry only after credentials or authorization have been refreshed. Never retry the same credential blindly. |

`phase` identifies where to look first. Supported values include `validation`, `authentication`,
`authorization`, `configuration`, `startup`, `request`, `transport`, `provider`, `persistence`,
`dispatch`, `socket`, `scheduler`, `worker`, `serialization`, `shutdown`, and `unknown`.

## Redaction and serialization

Use `redactSensitive(value)` for an in-memory detached copy and `boundedSerialize(value)` for a log
or trace string. The helpers redact key names containing authorization, cookie, token, secret,
credential, password, API key, request/response body, payload, prompt, or tool input/output. They
also scrub bearer and other authorization schemes, cookie/header values, credential query
parameters, and database URL credentials inside strings. Cycles, excessive depth, large arrays,
and large objects are replaced or bounded. The default serialized budget is 16 KiB UTF-8 bytes.

Redaction is a last boundary, not permission to put secrets in a diagnostic object. Do not log
complete request bodies, prompts, provider responses, cookies, authorization headers, access
tokens, passwords, or connection strings. Preserve the original exception for the business path;
only the derived structured error is observable.

## Logging vocabulary and levels

Operational logs use one fixed Pino key per concept. Use `module`, `operation`, `requestId`, `accountId`, `agentId`,
`computerId`, `sessionId`, `deliveryId`, `provider`, `outcome`, `errorCode`, `attempt`, `durationMs`, and `status` for
their corresponding values. In particular, `errorCode` is the only field for a structured failure identity; do not use
`reason`, `errorReason`, `failureReason`, `dropReason`, or `detail` as synonyms. `error` means terminal or unrecoverable,
`warn` means handled or degraded, `info` means a state transition, and `debug` means per-request detail.

The client `OPENTAG_LOG_LEVEL` behavior is: an unset test logger is `silent`, an unset service or explicit file/dual logger
is `info`, an unset one-shot logger is `warn`, a valid level selects that level, and an invalid value falls back to `info`
with one safe warning. The supported values are `trace`, `debug`, `info`, `warn`, `error`, `fatal`, and `silent`.

`imAttrs()` and `runtimeAttrs()` emit dotted OpenTelemetry span keys. They are not Pino payloads. Convert their values to
the fixed log vocabulary before writing a log record.

## Adoption guide

### Runtime and socket boundaries

Wrap detached scheduler work, WebSocket lifecycle callbacks, heartbeat/close cleanup, and process
signal shutdown promises with `BackgroundFailureSupervisor.track`. Use `supervise` when the caller
awaits the operation and must receive the original rejection. Supply the request or delivery ID,
the runtime phase, a stable code, and an explicit retry policy. Keep stale-connection and overload
outcomes as normal diagnostic events when they are useful for capacity analysis.

### I/O and provider boundaries

Catch provider, database, filesystem, and child-process failures at the boundary that has the
context to classify them. Pass the error as a cause, not as a serialized request or response.
Classify provider connection loss as `unavailable`, deadline expiry as `timeout`, and malformed
provider data as `protocol` or `dependency`. A provider message may be retained in local debugging
tools only when it has passed the same redaction and size limits.

### CLI boundaries

Use the same code/category/retryability/phase values for command failures. Present a short,
redacted message to the user and a request or operation ID for support. Do not print the structured
event as an unbounded stack trace. A non-zero exit status is a presentation decision and does not
change the event's retryability.

## Current integration points

The initial survey found several places that need call-site adoption in a later integration pass:

- `ImDeliveryWorker.#schedule()` currently converts a rejected detached run into a diagnostic code;
  it should call `track` with `phase: "worker"` and the delivery code.
- `KeyedTaskScheduler` currently consumes task rejections in its pump; it should report the task
  key and scheduler phase without exposing task input.
- Runtime socket business frames catch failures and return a protocol failure frame. The frame
  boundary should also use `supervise` or `track` so the cause and request ID reach diagnostics.
- Feishu connection/setup timers and lifecycle callbacks classify failures locally. They should
  emit the shared event while preserving their existing persisted diagnostic code contracts.
- Process-signal cleanup in `packages/server/src/index.ts` starts an unawaited `app.close()`; it
  should be tracked with `phase: "shutdown"`.

These are adoption notes only. This definition lane does not change runtime, service, API, client,
or application call sites.
