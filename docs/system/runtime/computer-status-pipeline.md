---
title: "Agent status pipeline (decided)"
description: "Decided direction for Agent status: Computer offline after three missed heartbeats overrides everything, three sub-statuses kept in Redis, Agent status derived on read, and a Web that reads the Server directly every 10 seconds while visible."
---

# Agent status pipeline (decided)

Status: decided; not implemented yet. The current behaviour is described in
[Runtime protocol compatibility](runtime-protocol.md), [Direct Provider CLI](../messaging/direct-provider-cli.md), and
the [Web UI contract](../web/web-ui-contract.md). Those pages change with the implementation.

## Why

The Web is an admin console. An admin configures Agents there and reads whether each Agent can work, so that reading
has to be timely and steady at minimal complexity.

Today readiness evidence expires on separate clocks: 60 seconds for Provider readiness, 120 for messaging CLI
credentials and 300 for the CLI artifact. An expired answer becomes an uncertain state (`checking` from the Server,
`unconfirmed` in the Web), and that uncertain state is the root of the layered workarounds:
- a sealed preparation that ignores heartbeats;
- re-validation on reads;
- a Web hold with a "Refreshing status" note;
- a re-check on entry.

The decided direction removes the uncertain state instead of working around it.

## Decisions

### Computer offline overrides everything

- A Computer is offline after three missed heartbeats (90 seconds at the 30-second cadence), or as soon as its socket
  closes.
- Offline is the top-priority status. While the Computer is offline, every other sub-status is void, and every Agent
  on it reads **Computer offline**.

### Three sub-statuses in Redis; Agent status derived on read

- **Storage:** the Server stores three sub-statuses per Agent's dependencies in **Redis**. Each report overwrites the
  previous one; no history is kept.
  - Computer (online/offline and last heartbeat);
  - runtime (Provider readiness on that Computer);
  - messaging channel (binding, messaging CLI and credentials).
- **Not stored:** the aggregated Agent status. It is derived on every read from the three sub-statuses, with Computer
  offline taking precedence.
- **Vocabulary:** an Agent reads exactly one of three kinds: ready, a named problem, or Computer offline. No status
  means "checking", "unconfirmed" or "refreshing".
- **Restart:** after a Server restart, a Computer reads offline until its next report arrives.

### Web reads the Server directly

- The Web keeps no status cache of its own and no anti-flicker hold. It shows what the Server returns.
  - Removed: `observeAgentListStatus`, `transientSince`, `AGENT_STATUS_REFRESHING_AFTER_MS`, and the
    **Refreshing status** / "状态刷新中" copy.
  - Removed: any re-check on entry.
  - Kept: the setup page's explicit **Check again** button (`POST /agents/:id/setup/refresh`).
- **Agent status** refetches every 10 seconds, and only while the tab is in the foreground.
- **Usage, MCP and Skill pages** refetch every 30 seconds.
- **Latency:**
  - a change on the Computer shows within 30 seconds (next heartbeat) plus 10 seconds (next refetch);
  - a clean disconnect shows within one refetch;
  - a crash shows within 90 seconds.

## Facts from today's code the implementation must account for

Each was checked against `main`.

**Storage:**
- OpenTag runs no Redis today. The lockfile mentions `@upstash/redis` only as an optional peer of `drizzle-orm`, and
  no service, compose file or configuration starts one.
- Readiness evidence lives in memory in `ConnectionRegistry`, one entry per Computer. Nothing about readiness is
  persisted. The database keeps only presence (`currentInstanceId`, `lastSeenAt`).

**Heartbeat:**
- The heartbeat is not a fixed interval. The client re-arms it only after `heartbeat:result` returns, so the period is
  30 seconds plus the round trip plus the Server's write.
- The local probe runs on its own 30-second timer (half the 60-second capability window).

**Credentials:**
- Messaging CLI credentials are never re-checked by the daemon on a timer. The Server starts each validation with
  grant material valid for 15 seconds, and the check calls the real Feishu or Slack API.

**Offline and restart:**
- After a Server restart, the database still reads a Computer as online for up to 90 seconds with no socket.
- The first evidence after reconnect comes from `computer:register`.
- The registry's dead-socket sweep runs every 90 seconds, so a dead socket can linger for up to about 180 seconds.

**Preparation and terminal results:**
- A sealed preparation ignores heartbeat readiness until a matching result, a reconnect, or a new preparation. Its
  5-minute quarantine keeps the seal.
- An artifact `unavailable` and a credential `needs_attention` never expire, and are treated as terminal after three
  retries.

**What does not depend on readiness:**
- Turn delivery does not need fresh readiness evidence. It needs only a current registry instance and negotiated
  capabilities, and the daemon re-checks the Provider locally before each Turn.

## Open points for the owner

These came out of verification. They are proposals, not decisions.

- **Redis:** OpenTag has no Redis. Introducing it means deployment, local development, the UX sandbox and CI fixtures.
  Should Redis be required, or is there a fallback for single-instance deployments?
- **Check cadence per part:**
  - Runtime/Provider readiness and the CLI artifact are cheap local checks and can run on every 30-second tick.
  - Credentials are not local. Proposal: re-validate on register, on a binding change, on **Check again**, and on a
    10-minute timer, with each check's own timeout.
  - Every report carries each part's `checkedAt`.
  - A timed-out check reports a named "check timed out" result for that item rather than `checking`.
- **Fixed-cadence heartbeat:** send every 30 seconds rather than re-arming after each reply, so "three missed
  heartbeats" means 90 seconds.
- **Older daemons:** every connected daemon is protocol v2, and the heartbeat frame schema is strict.
  - A new payload needs a negotiated capability, proposed name `runtime.selfCheckHeartbeat`, following the existing
    `channelTarget` pattern.
  - A daemon that does not negotiate it keeps today's requirement/grant frames until the support window ends. Its
    missing results should read as "update the openTag CLI on this computer", a named problem.
- **Credentials that break between validations:** revocations the Server observes from the provider already surface
  as a named problem (Slack `tokens_revoked` moves the binding to "reauthorization required"). An authentication
  failure the Agent hits while sending through the messaging CLI during a Turn does not feed back into status today.
  Should it?
- **Readers of today's expiry windows:** these move to "sub-status in Redis or Computer offline".

| Consumer | Today | After |
| --- | --- | --- |
| Agent status (list, home) | 60s runtime expiry; missing evidence reads `checking` / `unconfirmed` | Derived on read from the three sub-statuses |
| Agent setup | Stages `waiting` / `needs-runtime`; IM CLI gate needs `ready` with a non-null `observedAt` | Same stages from the stored sub-statuses |
| IM handoff readiness | Artifact (300s) and credential (120s) expiry; phases `preparing_cli` / `checking_credentials`; re-validation on reads | Stored messaging sub-status; no re-validation on reads |
| Feishu activation gating (`connection-manager.ts`) | Runtime readiness via the 60s expiry | Stored runtime sub-status |
| Computers list | Readiness projection with a `checking` fallback | Stored sub-status or offline |
| CLI (`runtime:unconfirmed`) | Reported from the CLI's own probe | Latest result or a named problem |
| MCP | Does not read readiness | Unchanged; 30-second refetch |
| Cloud Agents / Computers | Readiness from deployment Cloud availability | Unchanged |

## Files that change

**shared:**
- `packages/shared/src/runtime-protocol.ts`: retire the expiry constants; the new heartbeat capability and payload.
- `packages/shared/src/computer.ts`: readiness status values. These are public API, so keep the wire values for
  older peers and stop producing `checking`.
- `packages/shared/src/runtime-domain.ts`, `agent-setup.ts`, `im-binding.ts`.

**client:**
- `packages/client/src/runtime/runtime-connection.ts` and `client-runtime-composition.ts`: one fixed-cadence loop;
  a deadline per check.
- `packages/client/src/runtime/provider-cli/reconciler.ts` and `validation-runner.ts`.
- `apps/cli/src/core/computer/preparation.ts` and `runtime-probe.ts`.

**server:**
- Redis client and configuration (new).
- `packages/server/src/runtime/connection-registry.ts` and `runtime-session.ts`; `packages/server/src/api/runtime.ts`
  (the sweep).
- `packages/server/src/runtime/provider-cli-reconcile-owner.ts`.
- `packages/server/src/services/computers/provider-readiness.ts`, `cloud-computer.ts`, `computer-service.ts`.
- `packages/server/src/index.ts`: readiness and handoff wiring.
- `packages/server/src/services/im-bindings/im-binding-provider-cli.ts`, `im-binding-service.ts`, and
  `feishu/connection-manager.ts`, `feishu/setup-service.ts`.
- `packages/server/src/services/agents/agent-setup-service.ts`, `api/account.ts`, `api/provider-cli-reason.ts`.

**web:**
- `apps/web/src/query/live.ts`: a 10-second foreground status cadence; 30 seconds for usage, MCP and Skills.
- `apps/web/src/features/agents/agent-list-status.ts` (removed), `agents-page.tsx`, `agent-model.ts`,
  `agent-presentation.ts`, `agent-queries.ts`.
- `apps/web/src/onboarding-v2/agent-setup-page.tsx` and the setup readiness helpers; `apps/web/src/im/slack-custom-app.tsx`.
- `apps/web/messages/agents/{en,zh}.json`.

**docs:**
- `runtime-protocol.md`, `messaging/direct-provider-cli.md`, `web/web-ui-contract.md`,
  `agent-session-computer-model.md`, `web/computer-connection-controls.md`, and the pages citing the 30-second live
  cadence.
