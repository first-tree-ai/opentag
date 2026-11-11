---
title: "Runtime protocol compatibility"
description: "Runtime protocol v2 version layers, capability negotiation, and connection fencing between Client and Server."
---

# Runtime protocol compatibility

## Scope

Runtime protocol v2 removes the release-time dependency between the openTag Client and Server. It keeps the existing v1 dialect and its separately negotiated Provider-readiness extension frozen for rolling upgrades, then adds capability negotiation plus a per-connection fence. Domain delivery, Turn, and Session idempotency remain owned by their existing request identities and hashes.

This phase does not add durable drain state, a minimum secure Client release policy, or a persistent generic request ledger.

## Version layers

- **Protocol version** changes the handshake, control-frame state machine, or connection fencing. The current version is v2; the Server also accepts frozen v1.
- **Schema version** belongs to one domain payload or persisted artifact. An additive field does not require a global protocol bump; a semantic or incompatible payload change requires that domain's schema or capability version to change.
- **Capability version** identifies one namespaced behavior contract, including its request/result schemas and semantics. Offers are inclusive `{min,max}` ranges. Unknown optional offers are ignored.
- **Provider-readiness version** describes the schema for dynamic Computer-plus-Provider observations. It is negotiated independently from behavior capabilities and never proves authorization or durable support.
- **Release version** is diagnostic and policy input only. It is not proof of wire compatibility.

## v2 state machine and handshake

```text
disconnected -> connecting -> authenticating -> welcoming -> registering -> registered
                         \-> terminal rejection
                         \-> explicit v1 fallback -> connecting
```

1. The Client sends a strict v2 `auth` bootstrap frame with its supported protocol range.
2. After authentication, the Server sends an extensible v2 `server:welcome` with its protocol range, capability offers, required Client capabilities, heartbeat policy, and an optional acknowledgement of the independently offered Provider-readiness schema.
3. The Client computes the highest version in every capability intersection, validates required capabilities, and sends a strict v2 `computer:register` with its offers and required Server capabilities. It includes dynamic Computer-plus-Provider readiness only when the Server acknowledged that separate schema.
4. The Server repeats the intersection, rejects missing requirements, registers the Computer, creates a random `connectionId`, and returns the final negotiated map.
5. The Client recomputes and compares the final map before entering `registered`.

For each capability, selection is `min(local.max, remote.max)` when that value is at least `max(local.min, remote.min)`. A required capability without an intersection closes the connection with `PROTOCOL_CAPABILITY_UNSUPPORTED`.

## Rolling compatibility

| Client | Server | Result |
| --- | --- | --- |
| v1 | v1 | Frozen v1 handshake |
| v1 | v2 | Server's frozen v1 adapter |
| v2 | v1 | A second connection uses v1 only after a matching `PROTOCOL_VERSION_UNSUPPORTED` response |
| v2 | v2 | v2 negotiation and connection fencing |

Roll out Server v2 before Client v2. A v2 Client never falls back after a timeout, transport failure, TLS failure, malformed response, unmatched error, or incompatible welcome. Once an old Server explicitly selects the fallback, that Client process stays on v1 until restart; this avoids a rejection loop while allowing a later restart to probe v2 again.

## Provider-readiness vocabulary

Provider-readiness versioning is independent of transport protocol v1/v2. Its v1
vocabulary is frozen to `codex` and `claude-code`; v2 adds `pi`. Both vocabularies
are explicit lists, so adding a product provider cannot silently expand a wire version.

A new Client sends both `x-opentag-provider-readiness: 1` and
`x-opentag-provider-readiness-v2: 2`. A new Server selects v2 only after that explicit
opt-in and acknowledges `{version: 2, providers: [...]}` in its welcome. An old
Server sees its original v1 header and returns only its original vocabulary.
The Client reports only the providers acknowledged by that connection, and the
Server rejects unnegotiated observations on registration and heartbeat.

| Client offer | New Server response |
| --- | --- |
| No recognized readiness header | Readiness omitted |
| v1 only | v1, Codex and Claude Code |
| v1 plus v2, or v2 only | v2, Codex, Claude Code, and Pi |
| Unsupported v2 value plus valid v1 | v1, Codex and Claude Code |

The same headers control the Account Computer-list HTTP projection. Legacy callers
retain the v1 provider list, explicit v2 callers may receive Pi, and callers without
a recognized opt-in receive no readiness extension. The stored/live observations
remain complete; HTTP compatibility filtering does not change provider admission.

The Computer projection also respects the active daemon's negotiated provider set.
A provider outside that set is `unavailable` with no probe timestamp; a negotiated
provider awaiting a fresh observation remains `checking`. Thus a new Web/CLI caller
can see that Pi is unavailable on a v1-only daemon instead of waiting indefinitely.
Replacing the connection replaces this support boundary as well.

## Local model options and cache ownership

The optional `runtime.agentRuntimeOptions` capability (version 1) serves
`GET /api/v1/agents/:agentId/runtime-options?model=...`. The Server checks Account
ownership, resolves the Agent's bound Local Computer and provider, then sends an
`agent-runtime:options` request to that Computer's current daemon. The Client queries
the native provider CLI and returns model IDs and reasoning efforts for the selected
model. The Server rechecks Agent placement before returning the response.

| Data | Location and identity | Lifetime |
| --- | --- | --- |
| Web query result | Browser memory, keyed by `agentId`, `computerId`, provider, and model | Fresh for 30 seconds; a visible model page polls every 30 seconds; focus and reconnect request again; signing out clears the cache |
| Server request | In-memory pending map, keyed by a random `requestId` and fenced by `computerId` and `instanceId` | Removed on completion, cancellation, or timeout; no model catalog is persisted |
| Native provider catalog | Owned by the CLI and its local provider configuration | Provider-specific; openTag does not clear or persist this cache |
| Saved model and effort | PostgreSQL `agent_runtime_configs`, keyed by `agent_id` | Written only when configuration is saved, with an expected-revision check |

The HTTP response uses `Cache-Control: no-store`. The model page updates automatically
while mounted and visible, and stops polling when hidden, unmounted, or its Computer
is offline. Background updates preserve unsaved selections and do not show a loading
message over confirmed options. Each update is a new native query, not a background
catalog upload or a provider-cache purge. Computers do not overwrite
a shared Server catalog. A response from another Computer or an old daemon instance
cannot complete the pending request.

The Web model selector uses successful native results without adding preset suggestions,
including when the native catalog is empty. Presets are used only while no confirmed
native result is available, with the existing loading or unavailable feedback. Saved
IDs and custom input remain available. Suggestions are not proof of account access.
Reasoning efforts use the selected model's native metadata; an empty list stays empty,
while unknown metadata keeps suggested values explicitly unconfirmed.

Directory queries require the provider to be ready and reuse the same selected CLI
factory as task creation and resume, including its executable path and provider
environment. A query never discovers a separate CLI or initiates readiness repair.
This does not migrate already-running processes when a CLI installation changes.

Refreshing options does not save Agent configuration or modify the local CLI's
defaults. Saving `null` model or effort values means inheriting local configuration;
these are per-Agent overrides, not per-Computer model catalogs.

## Parsing and fencing

- The base v1 handshake and control schemas remain strict and byte-compatible. A Client offers the optional, separately versioned Provider-readiness extension through its WebSocket headers; only an acknowledging Server may add its welcome field and accept readiness on register or heartbeat frames.
- v2 authentication, registration, required capabilities, and fence fields are strict and fail closed.
- v2 welcome fields and capability offers are additive. Unknown optional fields and offers do not activate behavior.
- Unknown required capabilities, unknown control frames, malformed known frames, binary frames, oversized frames, and unknown business frames fail closed.
- Every v2 heartbeat and business frame carries the Server-issued `connectionId`. Both peers reject a missing or stale value before domain parsing or side effects. Bootstrap/error frames stay unversioned so an unsupported peer can reject a connection safely; they remain bound to the exact socket. The transport removes the fence before passing a business frame to a domain schema, so it cannot change a domain idempotency hash.
- `instanceId` fences a daemon process lifetime; `connectionId` fences one registered socket; placement generation continues to fence Session placement. The Server registry still verifies the exact current socket before and after sends.
- Transport queues are never replayed across sockets. Domain retries reuse their stable `requestId` and semantic payload hash under the existing domain policy.

## Approval presentation

The optional `runtime.approvalPresentation` capability (version 1) allows `approval:request` to
carry `commandPresentation` with a separately redacted command and reason. The complete legacy
`description` is always retained. Clients omit the additional field unless the capability is
negotiated, so older Servers with strict request schemas still receive their original payload.
Servers accept requests without this field and render their full description; this capability
changes presentation only, never approval authority or decision semantics.
Decision frames contain only the request identity and decision. Request-only presentation fields
are never copied into decisions, including automatic declines and expired requests.

The Server checks the durable Computer/connection and approval status under their row
locks through synchronous decision enqueue. It releases SQL before waiting for the
WebSocket callback. An uncertain send retains the owner's no-replay fence; late
transport errors cannot replace an acknowledged decision because status updates
require the expected status. Runtime test callers wait on their existing result
TTL/cancellation promise immediately after dispatch; a delayed send callback does
not extend that budget. Transport completion remains owned by the registry/socket.

## Session configuration

The optional `runtime.sessionConfiguration` capability (version 1) has no frames. A Client that offers it compares Agent
configuration against what each Session prepared on, and keeps a recovering Turn on its pinned snapshot when another
Session has already prepared a newer revision. Only for such a Client does the Server run Local IM Turns of one Agent
concurrently. A Client without it compares per Agent and would abandon that recovery, so the Server keeps one Turn per
Agent for it.

Rollback: a downgraded Client can inherit Turns accepted concurrently on different revisions. The Server then recovers them
oldest revision first, answering `session:recover` with `retry` (`older_configuration_recovering`) until the older Turns
have reported. The Client's recover attempts bound that wait at about 5 minutes. After that, it reports the waiting Turn
through its ordinary failure path, so that Turn gets a failure message and isn't resumed.

## Session recovery

The optional `runtime.sessionRecovery` capability (version 1) lets a restarted Local daemon ask the Server to prepare
a Session whose accepted work it is about to retry. The Client sends `session:recover` with the Session, Agent and
placement generation, plus the delivery and Turn identity when the interrupted work is an accepted IM Turn. The Server
answers `session:recover:result`:

- `scheduled`: it moved the named Turn's report ownership to the requesting connection and will send an ordinary
  `session:reconcile` (`desired: ready`) for the Session. For an IM Turn the reconcile carries the frozen dispatch
  snapshot; otherwise it carries the current assembled snapshot (with `sessionKind: internal` and the creator for an
  internal Session).
- `rejected` (final, with a reason such as `session_ended`, `placement_stale` or `turn_not_recoverable`), `retry`
  (transient), or `unsupported_capability`.

Only the exact current connection of the Session's placement Computer is served; a superseded connection is rejected.
Authorization and the report-owner takeover run in one transaction that locks the Agent and binding, the Session,
its placement, and the Computer (whose `current_instance_id` must equal the requesting connection) before the delivery
row, so a concurrent end, move, suspend, or reconnect either wins and refuses the request or waits for it. `scheduled`
does not end the Client's ownership: the Client keeps the recovery until the ready reconcile prepares the Session and
sends the request again when it does not arrive.
The request never redelivers input and never writes a Turn Report. A Client whose Server did not negotiate the
capability keeps the previous behavior: it reports interrupted IM Turns and fails waiting Session messages instead of
retrying them. See [Automatic retry of accepted work](../server-client-boundary.md#automatic-retry-of-accepted-work).

## Channel target advertisement

The optional `runtime.channelTarget` capability (version 1) lets a connected Client learn the exact channel latest target for automatic upgrades. When the capability is negotiated, every v2 `heartbeat:result` may carry an optional `channelTarget` field: the Server's release channel and the exact SemVer it currently advertises, read from the channel's published release pointer. The field is additive and negotiated, so older Clients with strict heartbeat schemas never receive it, and a Client behind an older Server simply sees no target. The Client treats only an exact version-string match as already current; SemVer precedence is used solely to reject an older target, while an equal-precedence target with different build metadata is installed. A target for another channel is rejected before any upgrade decision.

## Adversarial checks

The implementation and tests cover downgrade attempts with unmatched errors, missing required capabilities, unknown optional capabilities, invalid ranges, unacknowledged or unadmitted Provider readiness, out-of-order control frames, stale connection IDs, replacement sockets, frame-size limits, and mismatched negotiated maps. Authentication happens before capability use; capability negotiation cannot grant authorization or readiness.

## Release and rollback

Release gates are the v1/v2 compatibility matrix, package tests, build, typecheck, lint/format checks, and the Client Agent Runtime coverage gate. Deploy the dual-stack Server with v2 capabilities at their existing behavior versions, then canary the v2 Client.

Before a new capability changes durable data or semantics, rollback is a Server image rollback and Client v1 fallback. After such a capability is activated, its own expand/contract and rollback plan is required; protocol negotiation is not a database rollback mechanism. Keep v1 until fleet telemetry and an explicit deprecation decision justify removal.

## Provider failure categories

`runtime.turnReport` v3 extends `errorReason` with provider authentication, access, quota,
rate limit, availability, connection, context limit, execution limit, request rejection,
and process exit categories. Adapters classify declared provider codes and HTTP statuses,
not arbitrary error prose. Unknown errors retain `provider_failed`.

The Client freezes the negotiated report version when a Turn starts. New reports use
`provider_failed` when that version is v1 or v2, before computing the report hash. A Turn
started on v3 retains its category even if it finishes during a disconnect. A durable
v3 report waits for v3 support after reconnection; its reason and hash are never rewritten
for replay. Reply snapshots remain supported on both v2 and v3.

`runtime.turnReport` v4 splits two causes out of `credential_unavailable` that a person can fix:
`im_connection_unavailable`, when the Server refuses the Feishu or Slack connection (`binding_inactive` or
`credential_stale` on a credential acquire), and `model_login_missing`, when the Computer's model CLI has no
signed-in account (`credential_missing` in its readiness probe), and `tool_setup_failed`, when the CLI the Agent
replies through or its credential environment could not be prepared. On v1 to v3 the Client sends
`credential_unavailable` instead, under the same freeze rule. A missing or expired Cloud model grant stays
`credential_unavailable`.

`runtime.turnReport` v5 adds an optional `retryAt` to a `provider_quota_exceeded` report: when the used-up quota is
available again, as the model CLI reported it in structured output. It is rejected on any other reason. The Server
keeps it only inside the Turn report the delivery already stores and passes it to the quota card; nothing else reads
it. A report without `retryAt` keeps its v4 hash.

Cloud `delivery:report` uses the independently negotiated `cloudDeliveryVersion: 1` contract.
It retains the legacy failure vocabulary: new provider categories become `provider_failed`
before the Runner hashes or journals the report. Replay preserves that compatible reason and
hash. Categorized Cloud delivery reports require a future Cloud protocol extension.

## Context Tree command executions

`runtime.contextTreeExecution` version 1 gates both the `context-tree` service request/grant and the optional execution-open `contextTree` selector with `parentExecutionId`. A parent receives only the pure `context-tree:git` service. A separate short-lived child receives the GitHub provider binding after exact parent and authoritative tree checks. Ordinary executions never receive GitHub bindings or acquire GitHub credentials.

Runner authentication advertises `contextTreeExecutionVersion: 1`; the Server echoes the supported version and includes it in the Cloud runtime fence. Local capability negotiation follows the ordinary runtime offer. Emit the new service or selector only after Server support is established. Deploy the Server before updated Clients and Runner images. Old peers retain IM/MCP behavior but require an upgrade for managed Context Tree commands.

## Local self-check heartbeat

The composed daemon offers `runtime.selfCheckHeartbeat` version 1. The Server requests a fresh
`runtime:self-check` epoch on registration and explicit Check again. Completed reports carry that
epoch, an increasing sequence, a checked-at timestamp, runtime observations and messaging CLI
observations. The current connection fence and epoch reject late results. Exact duplicate reports
do not renew freshness. A new check retains the previous complete result while actual work runs.
Runtime checks are shared by Computer and Provider; credential checks remain scoped to Agent,
binding and credential generation.

The daemon checks local runtime and CLI state every 30 seconds and publishes completed results
immediately. Each component has a ten-second logical deadline. A timeout reports a named problem;
the owner retains the actual work until settlement, preventing overlapping probes and joining it
on shutdown. Freshness starts at registration even if no first report is accepted. A missing completed report
becomes stale after 75 seconds; heartbeats and rejected reports do not extend that deadline. Heartbeats run every
30 seconds independently of the previous acknowledgement, with at most three outstanding IDs.
Delayed and out-of-order acknowledgements keep their exact connection fence. Read-time presence
uses a monotonic 90-second deadline; the stale socket sweep runs at most five seconds apart.

Credential validation runs on registration or a changed binding generation, explicit Check again,
a scoped authentication-failure hint, and a ten-minute timer. A new-protocol validation episode
makes one external attempt within the existing 15-second grant budget and the provider's ten-second
request deadline. It does not add automatic retry attempts. A Computer runs one validation process,
so a check it answers as busy made no external attempt; the Server sends it again within the same
budget. Rate limiting sets a ten-minute cooldown; manual checks and hints cannot bypass it. Current scoped proxy HTTP 401 responses and Slack's
recognized revoked/invalid authentication responses trigger a debounced recheck, without changing
or replaying the original operation. The first check can expose a neutral initialization for at most
15 seconds. Later checks preserve the previous complete answer until they settle, including an
explicit timeout failure. A ready answer stands for 60 seconds past the ten-minute interval, because
a recheck can start late and still use its whole budget; after that it reads as a timeout.

Only a verdict from the provider is a failed credential check. A check that could not reach the
provider (network, DNS, HTTP 5xx, a token endpoint outage) reads as provider unreachable, and rate
limiting and timeouts keep their own reasons. These resolve on the next check, so they never ask the
user to reconnect, and they do not replace a rejection the provider already gave for the same
credential generation. Feishu's rate limit code `99991400` counts as rate limiting on any HTTP status.
A Server-side token exchange that Feishu refuses is answered to the CLI in Feishu's own shape, so
proxied checks reach the same verdict as direct ones. A reconnect may reuse one unexpired credential result only for the same
Computer, installation, binding and credential generation, until its original ten-minute expiry.
Offline presence always overrides it. No readiness survives Server restart.

The implementation uses the existing single-replica in-memory registry. There is no Redis status
store. Status never grants execution authority: Account ownership, active machine credentials,
current connection and binding generations are still checked at their owning boundaries. Peers
without the capability retain the existing preparation, readiness TTL and demand-refresh protocol.

The foreground web status poll is ten seconds. A local change is ordinarily visible within roughly
30 seconds to the next probe, ten seconds for the probe and ten seconds for the next poll, plus
transport delay. Credential changes without an explicit hint can take ten minutes plus validation
and polling time. These are cadence bounds, not a guarantee against network or service outages.
