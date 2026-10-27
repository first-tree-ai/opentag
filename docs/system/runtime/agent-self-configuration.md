---
title: "Agent self-configuration"
description: "Which parts of its own configuration an Agent may read and change through the CLI once its owner enables it."
---

# Agent self-configuration

An Agent running inside an openTag-managed Session can inspect and change part of its own configuration through the
CLI, without an Account login, only after its owner enables self-configuration:

```text
opentag self show
opentag self update [--instructions <text> | --instructions-file <path>]
                    [--model <model> | --clear-model]
                    [--reasoning-effort <effort> | --clear-reasoning-effort]
opentag self mcp search <query> [--limit <n>]
opentag self mcp add <name> <url> [oauth|bearer] [--api-key-stdin | --api-key <key>]
opentag self mcp use <server> [--api-key-stdin | --api-key <key>]
opentag self mcp delete <server>
opentag self mcp list [--page <n>] [--limit <n>]
opentag self mcp available
opentag self mcp attach <server> [--disabled]
opentag self mcp enable <server>
opentag self mcp disable <server>
opentag self mcp detach <server>
opentag self mcp generate_oauth_url <server> [--scopes <list>]
opentag self mcp check_oauth_status <server> [--wait [seconds]]
```

Every command accepts `--json`. `<server>` is an MCP Server name or ID. `opentag self` and `opentag agent self` are the
same command group: inside a managed Session the Agent is implied by the proof, so the top-level form is what the managed
prompt shows.

## Owner opt-in

Self-configuration is disabled by default for new and existing Agents. The web settings currently do not expose
this permission. The owner can still enable or disable it through the Account-scoped Agent update API using
`selfConfigurationEnabled`; hiding the web control does not revoke existing opt-ins.
The Agent cannot change this flag through `self update`.

When `selfConfigurationEnabled` is false, every route under `/api/v1/runtime/agent` returns HTTP 403 with
`AGENT_SELF_CONFIGURATION_DISABLED`, including read routes. The managed prompt includes the Self-configuration
section only when the flag is true and the Session CLI is available, and only on a Local Computer. That section
covers instructions, model, and reasoning effort.

The same two conditions include an MCP section on Local and Cloud. That section tells the Agent to configure
Servers in the current chat, and to branch on the operation before it replies. An enable, disable, remove, or
reauthorize request resolves the mounted name with `self mcp list` and runs that operation. It does not search
the catalog and it does not run `self mcp add`, because `add` only creates a definition. A new connection
checks mounted Servers and available Account definitions first. A mounted Server is not finished while
`authorization` is null or its status is expired, revoked, or error, including an enabled binding that has
not completed OAuth. The Agent reuses that mounted name and enables it when it is disabled. A missing Bearer
key is written with `self mcp use`, not with another `add`. A status of `pending` waits on the link already
sent; it does not start a new OAuth flow. The Agent does not create a second definition. The Agent searches
the catalog only when neither list has the Server, asks the user to paste an MCP configuration when the
catalog has no installable match, then runs `self mcp add`. The user opens an OAuth consent screen. A reply
that sends the user to the web console, Agent settings, or the Connectors page, or that lists connectors and
tools the command did not return, is the failure this section forbids. Enable this setting only when you
trust the messages that the Agent receives: a configuration change can affect all of its future Turns.

## Identity

The commands authenticate with the managed Session proof described in
[Internal Session collaboration](../messaging/internal-session-collaboration.md). No command accepts an Agent ID: the Server
resolves the Agent from the proof, reads its owning Account from the Agent row, and then calls the same Account-scoped
services that back `agent update` and `agent mcp`. A request therefore cannot address a different Agent, and ownership
checks, revision conflicts, and Cloud model validation behave exactly as they do for a human operator. Outside a
managed Session the commands fail with `AGENT_SELF_SESSION_REQUIRED` before any network call.

`self mcp search` is the exception: it reads the catalog shipped in `@opentag/mcp-presets`, so it needs neither a
Session nor the network. It answers "which connector do I need, and what is its endpoint?" before any definition
exists, which is what makes the add flow possible at all.

The Server routes live under `/api/v1/runtime/agent` and authenticate the proof before they read the request body.

## What an Agent may change

| Setting | `self` | Why |
| --- | --- | --- |
| Instructions, model, reasoning effort | Yes | How the Agent works; the user asks it to adjust. |
| Register a Server definition and mount it on itself | Yes | A user asking for a connector gets one without an Account login. The definition is written into the Account pool, so a human can see, adopt, or remove it. |
| Write its own Bearer key for a Server it mounts | Yes | The key belongs to this Agent alone; no other Agent's credential is reachable. |
| Start an OAuth flow | Yes | The Agent can produce the URL; only a human can complete the consent screen. |
| Register or mount an anonymous Server (`defaultAuthKind: "none"`) | No | An anonymous mount is usable immediately, with no credential step for a human to review. |
| Attach, enable, disable, or unmount an Account MCP Server | Yes | Chooses among mounts the Account already has. |
| Edit a definition another Agent mounts | No | Shared state; a human decides. `self mcp delete` unmounts the Server and drops this Agent's credential, but retains the Account definition. |
| Another Agent's mount or credential | No | No command accepts an Agent ID. |
| Self-configuration opt-in | No | Only the owner can enable or disable the surface. |
| Display name, receive mode | No | Changes how humans and IM see the Agent. |
| Maximum Turn duration | No | Would let the Agent raise its own resource limit. |
| MCP endpoint and header overrides on a shared definition | No | Would redirect an existing bearer credential to another origin. |

A human keeps the full surface through `agent update`, `agent mcp`, `mcp`, and the web app.

Two rules keep the credential power bounded. A definition the Agent registers is always its own: `mcp_servers` names
are unique per Account, so a self-registration that reuses a name fails with `MCP_SERVER_NAME_CONFLICT` instead of
shadowing or redirecting an existing definition. And `self mcp attach` rejects Servers with `defaultAuthKind: "none"`
with HTTP 403 and `MCP_SELF_ATTACH_NONE_AUTH_FORBIDDEN`, so the anonymous path stays closed on every route. Human
attach paths are unchanged: a human can still attach these Servers, which become active without a separate credential
step.

`self mcp add` creates the definition and mounts it atomically inside a single database transaction under a row lock on
the Agent. If the mount fails or the Agent's ownership / self-configuration permission changes concurrently,
PostgreSQL rolls back the entire operation so no orphan definition is left in the Account pool.

`self mcp use` writes a Bearer key onto a Server this Agent already mounts. It uses the existing credential
endpoint and does not create a definition. A second `add` of a name the Account already keeps fails with
`MCP_SERVER_NAME_CONFLICT`.

`self mcp generate_oauth_url` starts a new flow and replaces any pending state and PKCE verifier. That
invalidates a link the user may still be opening. A status of `pending` means that link is still the one to
finish. Start another flow only when no authorization exists yet, when the status is `expired`, `revoked`, or
`error`, or when the user says the previous link was refused or already used.

Every other self-service write path — writing a Bearer key, starting an OAuth flow, enabling or disabling the mount,
and unmounting it — re-checks `selfConfigurationEnabled` inside its own transaction under the same row lock a human
edit takes. The proof-authenticated request that preceded it is not enough on its own: an owner who revokes the opt-in
while a request is in flight must not end up with a credential or a mount change written after the revocation. Account
callers are unaffected by that flag; it gates only the Agent surface.

## OAuth from an Agent-started flow

`self mcp generate_oauth_url` starts the same flow the Account surface starts, and returns a handoff URL for the user
to open. The flow's `state` is stored hashed and short lived.

The URL routes through a same-origin browser handoff (`/api/v1/mcp-servers/oauth/handoff?token=...`). That route is
**not anonymous**, which is what keeps an Agent from binding the wrong person:

| Caller | Result |
| --- | --- |
| Not signed in | 302 to `/login?next=<the handoff URL>`, then back here. No cookie is set. |
| Signed in, but not the Account that owns the Agent | 404, the same body a token that never existed produces. No cookie is set. |
| Signed in as the owning Account | The handoff is consumed, the `mcpOAuthContext` cookie is set, and the browser is redirected to the provider. |

The sign-in round trip has to carry the URL unchanged, which is why a sign-in destination may be up to
`SIGN_IN_DESTINATION_MAX_LENGTH` (4096) characters: the sealed token alone pushes a generated handoff past 1200, and a
bound tighter than the URL this deployment mints would drop the visitor on `/agents` and strand the flow. The web app
lands an unauthenticated handoff as a full document request rather than a router navigation, because the handoff is a
server route with no page to match — a client-side navigation would never send the request that redeems the token.

Redemption is single use. The flow row holds a hash of the browser secret the token carries; redeeming replaces it with
the hash of a fresh secret and returns that one for the cookie, in a single conditional update. A second use of the same
URL matches no row and is refused, so a forwarded link cannot re-bind the flow to another browser. The flow itself —
`state`, its deadline, and the PKCE verifier — is left untouched, because the callback still needs it.

`self mcp check_oauth_status` reports the authorization status, the probe state, and the tool names without their input
schemas, so a poll stays small. A plain call returns immediately; `--wait [seconds]` polls until the flow settles or the
budget runs out, using 45 seconds when no value follows the flag. A timeout is not an error: it returns the last
observation, so the caller can tell the human the URL is still valid and check again later.

## When changes apply

- An owner opt-in change advances the runtime configuration revision atomically with the Agent
  update. The next eligible Turn uses the new setting and starts a new native conversation after
  any unresolved work settles. Repeating the same value does not advance the runtime revision.
- Instructions, model, and reasoning effort are read from the live Agent configuration when each Turn is assembled, so
  a change applies from the next Turn of every existing Session. These fields are part of the effective runtime
  snapshot hash, so that Turn starts a new provider conversation instead of resuming the previous one: earlier
  conversation context is not carried over. Internal Sessions created with their own model or reasoning-effort override
  keep that override.
- MCP mounts are read by the MCP gateway on each request, so attaching, enabling, or disabling a Server changes the
  tool catalog on the next MCP request. An Agent that had no usable MCP Server gets MCP access at its next execution.
- Detaching or deleting a Server drops this Agent's authorization and mount for it, while retaining the Account
  definition. A human must delete the definition through Account management to remove or reuse its name. For Servers
  that require credentials, a human must authorize it again after a later attach. Prefer `disable` when the Server
  may be needed again.

`self update` reads the current revision first and sends it as `expectedRevision`. A concurrent change returns
`AGENT_REVISION_CONFLICT`; read again and retry. `--instructions` replaces the whole instruction text, so read the
current value with `self show` and keep what still applies.

For Local Sessions saved by an older Client, a valid newer Soul can apply directly during the
first Session preparation after upgrade. A separate format-only migration is not required.
Unresolved work settles first; the configuration change then starts a new native conversation
while preserving the OpenTag Session and its history. The Client checks both Agent and Session
revisions from the saved snapshot, so restarting does not bypass same-revision conflicts.

## Observability

The Server logs `agent_self.config_updated`, `agent_self.mcp_attached`, `agent_self.mcp_binding_updated`,
`agent_self.mcp_detached`, `agent_self.mcp_server_created`, `agent_self.mcp_server_deleted`,
`agent_self.mcp_credential_written`, and `agent_self.mcp_oauth_started` at `info` with the Agent ID, Session ID, and
changed field names or MCP Server ID. Instruction text, Bearer keys, and OAuth material are never logged.
