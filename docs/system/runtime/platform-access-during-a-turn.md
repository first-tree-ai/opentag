---
title: "Platform access during a Turn"
description: "What a configuration save and a credential change do to a Turn already running: its platform access follows the current configuration, and only a withdrawn right to run ends it."
---

# Platform access during a Turn

A running Turn keeps the prompt, model and workspace it started with. Its access to the platform is different: each
request is checked and resolved against the current configuration. Saving an Agent's configuration doesn't end that
access, a changed credential reaches the Turn on its next request, and a revoked connection stops working on its next
request.

This applies to the provider credential proxy, the MCP gateway, Web tools, Context Tree commands and the Session CLI's
live execution check. Each of them calls `RuntimeScopeResolver.assertExecutionFence` with a fresh database read.

## Why it isn't tied to the Agent revision

Until this decision the fence compared `agents.revision` with the value pinned at execution open. Every configuration
save advances that revision, so an unrelated save, such as a rename or a new model, cut off every running Turn of the
Agent. The Turn then couldn't send its IM reply, because the provider proxy answered `503`. The MCP gateway answered
`409`, and at the next renewal the Client marked its provider grant dead for the rest of the execution.

Owner's decision (刘超, 2026-11-07): an old Turn should not lose platform access over a save that didn't touch its
credentials, a changed credential should take effect as soon as possible, and an old Turn may use the new one.

## What still ends access

`agents.access_generation` advances when the right to run is withdrawn or moved: suspension, deletion, a move to
another Account, and binding to a Computer. An execution pins it at open. The fence compares it instead of the
revision, and answers `agent_access_changed`.

It has to be a separate value because `agents.status` alone can't express this. Stopping Sessions on suspension is best
effort, so a Turn can outlive a suspension whose stop was lost. Without the pin, reactivating the Agent would give that
Turn its access back. Reactivation doesn't advance the generation, because the suspension already did.

The other fences are unchanged: Session ended, internal Session authority, Agent identity and Computer, Agent status,
placement generation, Computer owner, binding status, Slack installation, Cloud Sandbox allocation, Cloud control
credential, current control connection and accepted custody.

### Why it is a plain column

`agents.access_generation` is an `integer NOT NULL DEFAULT 1` column with no index, added by
`packages/server/drizzle/0076_agent_access_generation.sql`.

- Nothing queries by it. It is read with the Agent row by primary key and compared with the value the execution pinned.
  It is written only by the four withdrawals above, each as `+ 1` in the same transaction. An index would add nothing.
- `agents` has no JSON column, so storing it in JSON would still need a migration.
- The JSON fields in `agent_runtime_configs` (`context_trees`, `permissions` and the other runtime settings) hold the
  saved configuration. A save that changes the runtime configuration replaces them. A save that changes neither the
  runtime configuration nor self-configuration skips that write, although it still advances `agents.revision`. The
  access generation must stay independent of configuration saves in both cases, so it cannot live in fields that those
  saves replace.
- A plain column keeps `NOT NULL` and the atomic increment in the database instead of in code.

A validation execution still compares the revision. It is a short Server-issued check of one configuration, and a save
makes its result meaningless.

## When a change takes effect

| Change during a Turn | New requests | A request already running |
| --- | --- | --- |
| Configuration save (name, model, instructions, permissions) | Not affected | Not affected |
| Feishu or Slack credential rotated | The next request uses the new credential | A stream on the old one ends within 5 seconds (`PROVIDER_PROXY_STREAM_REVALIDATE_INTERVAL_MS`) |
| IM binding or Slack installation disabled | Refused on the next request | A stream ends within 5 seconds |
| MCP mount disabled or removed, or its authorization revoked | Refused on the next call, and gone from the next `tools/list` | The call finishes, within its upstream deadline |
| MCP credential changed | The next call reads the current credential | The call finishes on the old one |
| Context Tree removed from the selection | Refused on the next command | A stream ends within 5 seconds |
| Agent suspended, deleted or moved | Refused on the next request, also after a reactivation | A stream ends within 5 seconds |

### No cached credential outlives a change

- **Capabilities** expire after 60 seconds and hold no upstream credential. A capability authorizes this execution's
  use of a binding, so the IM scope hash no longer includes the credential generation, and a capability issued before a
  rotation serves the new credential. Every use still runs the full fence.
- **Feishu tenant tokens** are cached per binding and credential generation, so a rotation never reuses the old token.
  The token stays valid at Feishu until it expires, but it stays on the Server and no request uses it.
- **MCP** reads the mounts and the credential from the database on each call, and keeps no upstream session between
  calls.
- **Web tools** use one deployment-wide key. No Agent configuration affects it.
- **GitHub for Context Tree** keeps its own pin: a change of authorization version refuses the running child execution.

## What doesn't follow the current configuration

- **Newly added access:** services are granted at execution open. A Turn that started with no MCP mount doesn't get the
  gateway until its next Turn. A Turn that already has the gateway sees a newly mounted Server on its next `tools/list`,
  but a provider that listed its tools at the start won't call a tool it doesn't know.
- **Running provider CLIs:** the Feishu app ID in the Turn's environment is fixed at launch. If a binding moved to
  another Feishu app, the proxy serves the new app's credential while the CLI keeps reporting the old ID.
- **The prompt:** a Turn may still mention a connection that was removed. Its calls are refused.

## Security trade-off

Before, a save ended a running Turn's access, whatever the save changed. Now a Turn started before a save keeps access
for as long as it runs. A save that only narrows the prompt or permissions doesn't take platform access away from the
running Turn. Revoking access has to go through the thing that grants it: disable the binding or the mount, remove the
tree, rotate the credential, or suspend the Agent. Execution lifetime stays bounded by the Turn, its custody and the
execution's maximum lifetime.
