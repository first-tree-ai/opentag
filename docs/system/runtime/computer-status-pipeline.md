---
title: "Computer status pipeline (proposed)"
description: "Proposed redesign of how a Computer's self-check reaches the Web: one 30-second heartbeat that carries the latest check results, Server state that keeps only the latest report, and a steady 10-second Web refresh."
---

# Computer status pipeline (proposed)

Status: proposal for engineering review. Nothing here is implemented yet; the current behaviour is described in
[Runtime protocol compatibility](runtime-protocol.md), [Direct Provider CLI](../messaging/direct-provider-cli.md), and
the [Web UI contract](../web/web-ui-contract.md).

## Why

The Web is an admin console. An administrator configures Agents there and reads whether each Agent can work. That
reading has to be timely and steady, and should cost as little machinery as possible.

Today it is neither, because of one root cause: several kinds of evidence expire on their own clocks, and an expired
answer becomes an "uncertain" state (`checking` from the Server, `unconfirmed` in the Web). Each layer added a
workaround for that state:

- per-kind expiry windows (60, 120 and 300 seconds) with exemptions;
- a sealed preparation that ignores heartbeats;
- server-triggered re-validation on reads;
- a Web hold that keeps the last settled status, plus a "Refreshing status" note;
- a re-check on entry.

The proposal removes the uncertain state at its source. The Computer always reports a definite result for every check,
the Server keeps only the latest report, and the Web shows what the Server holds.

## Target behaviour

### Status vocabulary

An Agent's Computer leg reads exactly one of three kinds:

1. **Ready.**
2. **A named problem.** For example: Pi not installed, Codex sign-in required, messaging CLI missing, credentials
   rejected, or a check timed out.
3. **Computer offline.**

No status means "checking", "unconfirmed" or "refreshing".

### Computer (daemon)

One loop runs every 30 seconds on a fixed cadence:

1. Run the local self-check.
2. Send the full result in the heartbeat.

The two parts of the self-check are refreshed differently, because only some of them are cheap and local.

**Re-checked locally on every tick:**
- runtime/Provider readiness for each installed Provider;
- the messaging CLI artifact (installed, version, launcher).

**Re-validated on events and on a slow timer:**
- Messaging CLI credentials are validated against the real Feishu or Slack API with Server-issued grant material.
  Running that every 30 seconds would need standing grants and would call those APIs continuously from every Computer.
- They are therefore re-validated on:
  - `computer:register`;
  - a binding change;
  - **Check again** (`POST /agents/:id/setup/refresh`);
  - a 10-minute timer.
- Between validations the heartbeat repeats the last credential result.

**Rules for every check:**
- Every individual check has its own timeout. A check that times out reports a named "check timed out" result for
  that item. The heartbeat is still sent on time.
- No check ever reports `checking`.
- Every heartbeat carries the latest value of all four parts (runtime/Provider, CLI artifact, CLI credential, and the
  capability set), each with its own `checkedAt`, so freshness is visible without being a state of its own.

### Server

**What it stores:**
- In memory, per Computer (the existing `ConnectionRegistry` entry), only the latest heartbeat's full state. Each
  heartbeat overwrites the previous one.
- `computer:register` counts as the first heartbeat of a connection.
- Nothing about readiness is persisted. The database keeps only presence (`currentInstanceId`, `lastSeenAt`), as today.

**What it removes:**
- The per-kind expiry windows: `RUNTIME_CLIENT_CAPABILITY_TTL_MS` (60s), `RUNTIME_PROVIDER_CLI_CREDENTIAL_TTL_MS`
  (120s), `RUNTIME_PROVIDER_CLI_ARTIFACT_TTL_MS` (300s).
- Every projection that turns missing evidence into `checking` or credential `unconfirmed`.
- The sealed preparation and its 5-minute quarantine. Today a seal makes heartbeats ignored until a matching result
  arrives, a reconnect happens, or a new preparation starts, so a Computer can get stuck.
- The "unavailable never expires" rule. Today an artifact `unavailable` and a credential `needs_attention` are kept
  forever and treated as terminal after three retries. Under this proposal the latest check result is simply what is
  shown.

**When a Computer is offline:**
- It is offline when its socket closes, or when it has sent no heartbeat for 90 seconds.
- Offline is decided from `lastSeenAt` within 90 seconds, as today. The registry's dead-socket sweep, which today
  runs only every 90 seconds, tightens so a dead socket cannot linger for up to about 180 seconds.
- All of an offline Computer's Agents read **Computer offline**.
- **Server restart:** a Computer with no registry entry reads offline. Today the database still says online for up
  to 90 seconds after a restart while no socket exists. Its state returns with the first `computer:register` after
  reconnect.

### Web

**Refresh:**
- Status queries refetch every 10 seconds while the page is visible, immediately on focus, and not in background tabs
  (TanStack's `refetchIntervalInBackground` stays off).
- This uses a dedicated status constant. The shared `LIVE_REFETCH_INTERVAL_MS` (30 seconds) also drives usage, MCP,
  Skills, Tasks and Cloud pages, which keep their cadence.
- The setup page's own 2-second loop stops while the tab is hidden; today it keeps running.

**What it removes:**
- The anti-flicker hold: `observeAgentListStatus`, `steadyAgentListItem`, `transientSince`,
  `AGENT_STATUS_REFRESHING_AFTER_MS`.
- The **Refreshing status** / "状态刷新中" copy.
- The `unconfirmed` / `checking` projections in `agent-model.ts` and `agent-presentation.ts`. A failed read keeps the
  last successful data with the existing refresh-error notice instead of inventing a status.
- Any re-check on entry. The setup page keeps its explicit **Check again** button (`POST /agents/:id/setup/refresh`).

### Latency

- A change on the Computer is visible in the Web within 30 seconds (next heartbeat) plus 10 seconds (next refetch).
- A clean disconnect is visible within one refetch.
- A crashed or unplugged Computer is visible within 90 seconds.

## Compatibility with older daemons

Every connected daemon is runtime protocol v2; v1 is already refused. The heartbeat frame schema is strict, so the new
payload cannot be added silently.

**New capability (name for review):**
- Add a negotiated capability, proposed name `runtime.selfCheckHeartbeat`, to `RUNTIME_CAPABILITY` and both offers.
- A daemon sends the full self-check and its fixed 30-second loop only when the capability was negotiated. This
  follows the existing pattern where `heartbeat:result.channelTarget` is sent only after `runtime.channelTarget` was
  negotiated.

**How a daemon that did not negotiate it is treated:**
- It keeps today's frames: heartbeat with runtime and IM-CLI readiness, and separate `provider-cli:artifact:status`,
  `provider-cli:prewarm:result` and `provider-cli:validation:result` frames in reply to Server requirement and grant
  frames.
- The Server keeps today's requirement/grant flow and evidence path only for such connections. It maps their results
  onto the three-kind vocabulary:
  - expired or missing evidence becomes a named problem asking to update the openTag CLI on that computer, not an
    uncertain state.
- The legacy path is removed after the support window for older CLI releases ends.

**What does not change:**
- Turn delivery does not depend on readiness freshness. The delivery worker requires only a current registry instance
  and negotiated capabilities, and the daemon re-checks the Provider locally before each Turn. Removing the expiry
  windows does not change routing.

## What else reads today's expiry windows

These consumers must move to "latest report or offline":

| Consumer | Today | Proposed |
| --- | --- | --- |
| Agent status (list, home) | 60s runtime expiry; missing evidence reads `checking` / `unconfirmed` | Latest report; three kinds |
| Agent setup | Stages `waiting` / `needs-runtime`; IM CLI gate needs `ready` with a non-null `observedAt` | Same stages, from the latest report; no `waiting` from missing evidence |
| IM handoff readiness | Artifact (300s) and credential (120s) expiry; phases `preparing_cli` / `checking_credentials`; re-validation on reads | Latest artifact and credential results; no re-validation on reads |
| Feishu activation gating (`connection-manager.ts`) | Runtime readiness via the 60s expiry | Latest report |
| Computers list | Readiness projection with `checking` fallback | Latest report or offline |
| CLI (`runtime:unconfirmed`) | Reported from the CLI's own probe | Reports the latest result or a named problem |
| MCP | Does not read readiness; shares the 30s live cadence | Unchanged |
| Cloud Agents / Computers | Readiness from deployment Cloud availability, not the registry | Unchanged |

## Credentials that break between validations

Revocations the Server observes from the provider already surface as a named problem. For example, Slack
`tokens_revoked` moves the binding to "reauthorization required", which the Web shows as **Update permissions**.

An authentication failure that the Agent hits while sending through the messaging CLI during a Turn does not feed
back into readiness today. It is listed as an open question below rather than designed here.

## Files to change

**shared:**
- `packages/shared/src/runtime-protocol.ts`: the new capability and offer; an optional heartbeat field for the full
  self-check; retire the expiry constants.
- `packages/shared/src/computer.ts`: readiness status values. These are public API, so keep the wire values for older
  peers and stop producing `checking`.
- `packages/shared/src/runtime-domain.ts`: Provider CLI frames.
- `packages/shared/src/agent-setup.ts` and `im-binding.ts`, if the setup states and handoff phases change.
- The package index and browser export.

**client:**
- `packages/client/src/runtime/runtime-connection.ts`: the fixed-cadence heartbeat builder; remove the client-side
  60-second expiry per observation.
- `packages/client/src/runtime/client-runtime-composition.ts`: fold the 30-second capability/probe timer into the
  heartbeat loop; a deadline per check; no `publishChecking`.
- `packages/client/src/runtime/provider-cli/reconciler.ts` and `validation-runner.ts`: an artifact check on every
  tick; credential validation on events plus the 10-minute timer, with its own timeout.
- `apps/cli/src/core/computer/preparation.ts` and `runtime-probe.ts`.

**server:**
- `packages/server/src/runtime/connection-registry.ts`: latest-report storage; remove the expiry logic, seal,
  quarantine and terminal exemptions.
- `packages/server/src/runtime/runtime-session.ts`: heartbeat parse and capability gating.
- `packages/server/src/api/runtime.ts`: the dead-socket sweep.
- `packages/server/src/runtime/provider-cli-reconcile-owner.ts`: keep the requirement/grant flow for legacy
  connections only.
- `packages/server/src/services/computers/provider-readiness.ts`, `cloud-computer.ts`, `computer-service.ts`.
- `packages/server/src/index.ts`: the readiness and handoff wiring that today supplies `checking` / `unconfirmed`.
- `packages/server/src/services/im-bindings/im-binding-provider-cli.ts`, `im-binding-service.ts`.
- `packages/server/src/services/im-bindings/feishu/connection-manager.ts`, `setup-service.ts`.
- `packages/server/src/services/agents/agent-setup-service.ts`.
- `packages/server/src/api/account.ts`, `api/provider-cli-reason.ts`.

**web:**
- `apps/web/src/query/live.ts`: a dedicated 10-second status cadence.
- `apps/web/src/features/agents/agent-list-status.ts` (removed), `agents-page.tsx`, `agent-model.ts`,
  `agent-presentation.ts`, `agent-queries.ts` (the 2-second / 90-second handoff polling).
- `apps/web/src/onboarding-v2/agent-setup-page.tsx`, `preparation-readiness.ts`, `messaging-readiness-copy.ts`, and
  the setup lab model and page.
- `apps/web/src/im/slack-custom-app.tsx`.
- `apps/web/messages/agents/{en,zh}.json`: remove the refreshing and checking copy.

**docs:**
- `docs/system/runtime/runtime-protocol.md`: the capability, heartbeat schema and readiness sections.
- `docs/system/messaging/direct-provider-cli.md`: terminal observation and periodic inspection.
- `docs/system/web/web-ui-contract.md`: the status hold, Refreshing status, and expiry statements.
- `docs/system/agent-session-computer-model.md`.
- `docs/system/web/computer-connection-controls.md`.
- `docs/product/cloud-computer.md` and `docs/system/capabilities/mcp-server-integration.md`, where they cite the
  30-second live cadence.
- `apps/cli/README.md`.

## Open questions for reviewers

- **Capability name:** `runtime.selfCheckHeartbeat` is a placeholder.
- **Credential failures during Turns:** should a messaging-CLI authentication failure during a Turn feed back as a
  named credential problem before the next scheduled validation, and through which channel?
- **Support window:** how long the legacy evidence path stays for daemons that did not negotiate the capability.
- **Timeouts:** the per-check timeout values (today 10 seconds for Provider probes and CLI validation) and whether a
  timed-out item should be retried within the same tick.
