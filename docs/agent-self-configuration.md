# Agent self-configuration

[简体中文](./zh-CN/agent-self-configuration.md)

An Agent running inside an OpenTag-managed Session can inspect and change part of its own configuration through the
CLI, without an Account login, only after its owner enables self-configuration:

```text
opentag agent self show
opentag agent self update [--instructions <text> | --instructions-file <path>]
                          [--model <model> | --clear-model]
                          [--reasoning-effort <effort> | --clear-reasoning-effort]
opentag agent self mcp list
opentag agent self mcp available
opentag agent self mcp attach <server> [--disabled]
opentag agent self mcp enable <server>
opentag agent self mcp disable <server>
opentag agent self mcp detach <server>
```

Every command accepts `--json`. `<server>` is an MCP Server name or ID.

## Owner opt-in

Self-configuration is disabled by default for new and existing Agents. The owner can enable the **Self-configuration**
switch in the Agent's settings. The Account-scoped Agent update API also accepts `selfConfigurationEnabled`.
The Agent cannot change this flag through `agent self update`.

When `selfConfigurationEnabled` is false, every route under `/api/v1/runtime/agent` returns HTTP 403 with
`AGENT_SELF_CONFIGURATION_DISABLED`, including read routes. The managed prompt includes the Self-configuration
section only when the flag is true and the Session CLI is available. Enable this setting only when you trust the
messages that the Agent receives: a configuration change can affect all of its future Turns.

## Identity

The commands authenticate with the managed Session proof described in
[Internal Session collaboration](./internal-session-collaboration.md). No command accepts an Agent ID: the Server
resolves the Agent from the proof, reads its owning Account from the Agent row, and then calls the same Account-scoped
services that back `agent update` and `agent mcp`. A request therefore cannot address a different Agent, and ownership
checks, revision conflicts, and Cloud model validation behave exactly as they do for a human operator. Outside a
managed Session the commands fail with `AGENT_SELF_SESSION_REQUIRED` before any network call.

The Server routes live under `/api/v1/runtime/agent` and authenticate the proof before they read the request body.

## What an Agent may change

| Setting | `agent self` | Why |
| --- | --- | --- |
| Instructions, model, reasoning effort | Yes | How the Agent works; the user asks it to adjust. |
| Attach an Account MCP Server that requires credentials | Yes | A human must authorize the credentials before the mount is usable. |
| Attach an Account MCP Server with `defaultAuthKind: "none"` | No | Attachment would immediately grant access, including definition headers. |
| Enable, disable, or unmount an existing Account MCP Server | Yes | Chooses among mounts the Account already has. |
| Self-configuration opt-in | No | Only the owner can enable or disable the surface. |
| Display name, receive mode | No | Changes how humans and IM see the Agent. |
| Maximum Turn duration | No | Would let the Agent raise its own resource limit. |
| MCP endpoint and header overrides | No | Would redirect an existing bearer credential to another origin. |
| MCP credentials, OAuth, Server definitions | No | Credentials stay a human decision. |

A human keeps the full surface through `agent update`, `agent mcp`, `mcp`, and the web app.

`agent self mcp attach` rejects Servers with `defaultAuthKind: "none"` with HTTP 403 and
`MCP_SELF_ATTACH_NONE_AUTH_FORBIDDEN`. Human attach paths are unchanged: a human can still attach these Servers,
which become active without a separate credential step.

## When changes apply

- Instructions, model, and reasoning effort are read from the live Agent configuration when each Turn is assembled, so
  a change applies from the next Turn of every existing Session. These fields are part of the effective runtime
  snapshot hash, so that Turn starts a new provider conversation instead of resuming the previous one: earlier
  conversation context is not carried over. Internal Sessions created with their own model or reasoning-effort override
  keep that override.
- MCP mounts are read by the MCP gateway on each request, so attaching, enabling, or disabling a Server changes the
  tool catalog on the next MCP request. An Agent that had no usable MCP Server gets MCP access at its next execution.
- Detaching a Server drops this Agent's authorization for it. For Servers that require credentials, a human must
  authorize it again after a later attach. Prefer `disable` when the Server may be needed again.

`agent self update` reads the current revision first and sends it as `expectedRevision`. A concurrent change returns
`AGENT_REVISION_CONFLICT`; read again and retry. `--instructions` replaces the whole instruction text, so read the
current value with `agent self show` and keep what still applies.

## Observability

The Server logs `agent_self.config_updated`, `agent_self.mcp_attached`, `agent_self.mcp_binding_updated`, and
`agent_self.mcp_detached` at `info` with the Agent ID, Session ID, and changed field names or MCP Server ID.
Instruction text is never logged.
