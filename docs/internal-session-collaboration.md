# Internal Session collaboration

OpenTag Agents can delegate work to reusable internal Sessions with two hosted tools:

- `create_internal_session` creates an internal Session and submits its first text message atomically. The optional
  `messageId` is the idempotency key; after an `unknown` or `unreachable` result, retry with the returned ID and the
  exact same initial message and overrides.
- `send_session_message` sends text to an existing Session in the same collaboration scope. Its optional `messageId`
  has the same explicit-retry semantics.

Internal Sessions inherit the creator's Agent, IM binding, channel or thread scope, Computer placement, and shared
Agent Workspace. They have an independent Agent Runtime and may override the model, reasoning effort, and maximum Run
duration at creation time. They do not receive IM deliveries, provider message references, or
`OPENTAG_PROVIDER_ENV_FILE`; results and follow-up questions return only through `send_session_message`.

## Delivery and persistence

Session messages are real-time, best-effort collaboration. `accepted` means that the target Client placed the message
in its bounded in-memory FIFO; it does not mean that the target Agent completed the work. A busy target starts a new
prompt Run after its current Run finishes rather than steering the active Run.

The Server stores each authorized logical message once in `session_messages`, including its source and target Sessions,
text hash, attempt count, and latest observed delivery outcome. This durable fact provides cross-restart conflict
detection and idempotency. It is not a delivery queue: there is no pending state, lease, next-attempt timestamp,
background worker, startup scan, or automatic replay. An `unknown` or `unreachable` message is retried only when the
caller explicitly invokes the tool again with the same `messageId`.

Every explicit attempt is fenced by its monotonically increasing attempt number, so a late result from an older attempt
cannot overwrite a newer observation. Unauthorized, ended, stale-placement, or cross-scope requests are rejected before
a message fact is created.

## Rolling compatibility

The Client and Server expose collaboration only when runtime protocol v2 negotiates the optional
`runtime.sessionCollaboration` capability. Existing v1 connections and v2 peers without that capability continue to use
the existing IM and Agent Runtime paths without seeing collaboration tools or internal-Session reconcile fields.
When a reconnect changes the negotiated hosted-tool set, the Client re-prepares existing idle Sessions even when their
placement and runtime revisions are unchanged. The old provider runtime is closed before the Session resumes with the
newly negotiated tool surface.

Codex App Server registers dynamic tools only when a thread starts. When a durable Codex binding predates collaboration,
the Client replaces that provider thread once and records the hosted-tool definition hash in the binding. Later starts
resume the replacement thread normally; provider-default native tools remain available alongside the hosted tools. If
collaboration is no longer negotiated, the Client symmetrically replaces a marked provider thread without dynamic tools
and clears the marker, so an older peer never exposes tools for which it has no handler.
