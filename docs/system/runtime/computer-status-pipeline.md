---
title: "Agent status pipeline"
description: "Single-replica Agent status derived from database authority and the existing runtime registry, with independent heartbeats, bounded first validation and foreground batch reads."
---

# Agent status pipeline

## Authority and storage

The Server derives Agent status on read from its current Computer, runtime Provider and messaging
binding. It does not store a separate aggregate. Durable ownership, placement, binding identity and
credential generation remain in PostgreSQL. High-frequency evidence lives in the existing
`ConnectionRegistry`; no Redis or additional status table is required. This design assumes one
Server replica. A multi-replica deployment needs a separately agreed presence/evidence design.

`GET /api/v1/agents/status?ids=...` accepts one to one hundred unique Agent IDs and reads the whole
owner-authorized batch in one read-only Repeatable Read snapshot, with at most three SELECTs.
Missing or unauthorized IDs fail the whole batch. A registry/database connection-fence mismatch
retries the whole snapshot once, then returns a conflict. The response is private and not cacheable.
Credential decryption/inspection happens after the transaction and performs no provider I/O.

## Computer offline overrides everything

A negotiated self-check peer sends a heartbeat every 30 seconds independently of acknowledgements,
with at most three acknowledgements outstanding. The Server records receipt before database work.
Monotonic elapsed time of 90 seconds without a heartbeat makes the Computer offline; a sweep runs
at most five seconds apart. Closing the socket also removes online presence. Computer offline has
priority even over a paused Agent. After a Server restart the Computer stays offline until it reconnects.

## Completed evidence and bounded initialization

`runtime.selfCheckHeartbeat` version 1 negotiates the independent heartbeat and self-check path.
The composed Client probes local runtime and messaging CLI capability every 30 seconds, with a
10-second logical deadline. A timeout reports a named problem, while the actual probe remains
owned until it settles; another probe never overlaps that work. A completed report is sent immediately
with its epoch, sequence and check time. Stale epochs and conflicting sequence replays cannot refresh
the evidence. Completed local evidence becomes unavailable after 75 seconds without a fresh report.

Credentials are checked on registration or binding/generation change, an explicit Check again,
an authenticated credential-failure hint, and at most every ten minutes. A new-peer episode grants
one external attempt, with a 15-second grant budget and 10-second provider-call budget; rate limits
leave a named problem and a cooldown. Rechecking keeps the last completed verdict. A valid verdict
may survive the same Computer/installation/binding/generation reconnect until its original expiry.

Only the first validation may show a neutral initializing state, for at most 15 seconds. Afterwards
status is ready, a named problem, or Computer offline. Local changes normally reach a foreground
viewer within roughly 50 seconds (30-second probe cadence, 10-second deadline and 10-second poll).
An unresponsive or crashed connection is visible within the offline budget plus the next poll.

## Web and mixed-version compatibility

The Agent-list request negotiates `x-opentag-agent-status: 1`; a Server with the batch service returns
`statusVersion: 1`. The Web then reads batches of at most one hundred Agents every ten seconds
while visible. It has no separate status hold or Refreshing status note and makes no per-Agent
binding/handoff status fan-out. The setup page retains its explicit Check again action.

An older Server omits the negotiated metadata and the Web uses its existing read contract. An
older Client keeps its existing readiness TTL and bounded validation behavior; legacy refresh is
coalesced per Computer. Reading the status of a new self-check peer does not start a probe or grant.
See [Runtime protocol](runtime-protocol.md) and the [Web contract](../web/web-ui-contract.md).
