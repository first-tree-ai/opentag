---
title: "Agent status pipeline"
description: "How an Agent's status reaches the Web: Computer offline after three missed heartbeats overrides everything, three sub-statuses kept in a TTL key-value cache, Agent status derived on read, and a Web that reads the Server directly every 10 seconds while visible."
---

# Agent status pipeline

> **Planned — not yet implemented.** Tracking: #1215

## Why

The Web is an admin console. An admin configures Agents there and reads whether each Agent can work, so that reading
has to be timely and steady at minimal complexity.

Readiness evidence today expires on separate clocks: 60 seconds for Provider readiness, 120 for messaging CLI
credentials and 300 for the CLI artifact. An expired answer becomes an uncertain state (`checking` from the Server,
`unconfirmed` in the Web), and that uncertain state is the root of the layered workarounds. This design removes the
uncertain state instead of working around it.

## Computer offline overrides everything

- A Computer is offline after three missed heartbeats (90 seconds at the 30-second cadence), or as soon as its socket
  closes.
- Offline is the top-priority status. While the Computer is offline, every other sub-status is void, and every Agent
  on it reads **Computer offline**.

## Three sub-statuses in a TTL cache; Agent status derived on read

- **Storage:** the Server stores three sub-statuses for each Agent's dependencies in Redis, each with a TTL of about
  one minute. Each report overwrites the previous one; no history is kept.
  - Computer: online or offline, and the last heartbeat.
  - Runtime: Provider readiness on that Computer.
  - Messaging channel: the binding, the messaging CLI, and credentials.
- **Not stored:** the aggregated Agent status. It is derived on every read from the three sub-statuses, with Computer
  offline taking precedence.
- **Vocabulary:** an Agent reads exactly one of three kinds: ready, a named problem, or Computer offline. No status
  means "checking", "unconfirmed" or "refreshing".
- **Restart:** after a Server restart, a Computer reads offline until its next report arrives.

Why the state lives outside the process: Server services keep no in-process state, so the Server can run as more than
one instance. High-frequency state that can be lost, such as these sub-statuses, goes to a TTL key-value cache; durable
data goes to PostgreSQL.

What it replaces:
- the in-memory evidence in `ConnectionRegistry`, with its per-kind expiry windows
  (`RUNTIME_CLIENT_CAPABILITY_TTL_MS`, `RUNTIME_PROVIDER_CLI_CREDENTIAL_TTL_MS`,
  `RUNTIME_PROVIDER_CLI_ARTIFACT_TTL_MS`);
- the sealed preparation;
- the "never expires" exemptions;
- the `checking` and `unconfirmed` projections.

[Runtime protocol compatibility](runtime-protocol.md), [Direct Provider CLI](../messaging/direct-provider-cli.md) and
the [Web UI contract](../web/web-ui-contract.md) still describe that current behaviour until this ships.

## Web reads the Server directly

- The Web keeps no status cache of its own and shows what the Server returns.
- Agent status refetches every 10 seconds, and only while the tab is in the foreground.
- **Removed:** the anti-flicker hold, the **Refreshing status** / "状态刷新中" note, and any re-check on entry.
- **Kept:** the setup page's explicit **Check again** button (`POST /agents/:id/setup/refresh`).
- A crashed or disconnected Computer shows as offline within 90 seconds plus the next 10-second refetch.
