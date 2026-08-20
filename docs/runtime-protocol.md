# Runtime protocol compatibility

[简体中文](./zh-CN/runtime-protocol.md)

## Scope

Runtime protocol v2 removes the release-time dependency between the OpenTag Client and Server. It keeps the existing v1 dialect frozen for rolling upgrades and adds capability negotiation plus a per-connection fence. Domain delivery, Turn, and Session idempotency remain owned by their existing request identities and hashes.

This phase does not add durable drain state, a minimum secure Client release policy, or a persistent generic request ledger.

## Version layers

- **Protocol version** changes the handshake, control-frame state machine, or connection fencing. The current version is v2; the Server also accepts frozen v1.
- **Schema version** belongs to one domain payload or persisted artifact. An additive field does not require a global protocol bump; a semantic or incompatible payload change requires that domain's schema or capability version to change.
- **Capability version** identifies one namespaced behavior contract, including its request/result schemas and semantics. Offers are inclusive `{min,max}` ranges. Unknown optional offers are ignored.
- **Release version** is diagnostic and policy input only. It is not proof of wire compatibility.

## v2 state machine and handshake

```text
disconnected -> connecting -> authenticating -> welcoming -> registering -> registered
                         \-> terminal rejection
                         \-> explicit v1 fallback -> connecting
```

1. The Client sends a strict v2 `auth` bootstrap frame with its supported protocol range.
2. After authentication, the Server sends an extensible v2 `server:welcome` with its protocol range, capability offers, required Client capabilities, and heartbeat policy.
3. The Client computes the highest version in every capability intersection, validates required capabilities, and sends a strict v2 `computer:register` with its offers and required Server capabilities. Runtime readiness such as `imMessageTool` remains a separate, refreshable fact.
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

## Parsing and fencing

- v1 handshake and control schemas remain strict and byte-compatible.
- v2 authentication, registration, required capabilities, and fence fields are strict and fail closed.
- v2 welcome fields and capability offers are additive. Unknown optional fields and offers do not activate behavior.
- Unknown required capabilities, unknown control frames, malformed known frames, binary frames, oversized frames, and unknown business frames fail closed.
- Every v2 heartbeat and business frame carries the Server-issued `connectionId`. Both peers reject a missing or stale value before domain parsing or side effects. Bootstrap/error frames stay unversioned so an unsupported peer can reject a connection safely; they remain bound to the exact socket. The transport removes the fence before passing a business frame to a domain schema, so it cannot change a domain idempotency hash.
- `instanceId` fences a daemon process lifetime; `connectionId` fences one registered socket; placement generation continues to fence Session placement. The Server registry still verifies the exact current socket before and after sends.
- Transport queues are never replayed across sockets. Domain retries reuse their stable `requestId` and semantic payload hash under the existing domain policy.

## Adversarial checks

The implementation and tests cover downgrade attempts with unmatched errors, missing required capabilities, unknown optional capabilities, invalid ranges, out-of-order control frames, stale connection IDs, replacement sockets, frame-size limits, and mismatched negotiated maps. Authentication happens before capability use; capability negotiation cannot grant authorization or readiness.

## Release and rollback

Release gates are the v1/v2 compatibility matrix, package tests, build, typecheck, lint/format checks, and the Client Agent Runtime coverage gate. Deploy the dual-stack Server with v2 capabilities at their existing behavior versions, then canary the v2 Client.

Before a new capability changes durable data or semantics, rollback is a Server image rollback and Client v1 fallback. After such a capability is activated, its own expand/contract and rollback plan is required; protocol negotiation is not a database rollback mechanism. Keep v1 until fleet telemetry and an explicit deprecation decision justify removal.
