---
title: "MCP Server integration"
description: "Per-Agent MCP Server bindings and authorization, the MCP gateway, OAuth, probing, catalog, and error codes."
---

# MCP Server integration

> **Status: the management plane and local Claude Code/Codex runtime paths are delivered. This
> change adds local Pi and Cloud Pi runtime paths; deployment acceptance remains separate.**
>
> The management plane provides MCP (Model Context Protocol) Server definitions, per-Agent bindings
> with per-Agent overrides, per-Agent authorization (anonymous / Bearer / OAuth), capability probing,
> and background token maintenance, in the Server API, the Web UI, and the CLI.
>
> Runtime delivery is [the MCP gateway](#the-mcp-gateway): one inbound Streamable HTTP endpoint on
> the openTag Server that an Agent's provider CLI mounts like any other remote MCP Server. **No
> upstream credential is ever delivered to a Provider** — the gateway resolves the Agent's own
> authorization row and calls upstream itself.
>
> The Cloud sandbox runs Pi only. It uses the same execution-scoped MCP gateway token and Server
> authorization as a local Computer, through its existing Runtime Credential Relay. Claude Code
> and Codex do not run inside the Cloud sandbox.
>
> An earlier revision of this page proposed a different path — push credentials down to the Client
> and inject the real authorization header through a local `127.0.0.1` loopback proxy. The gateway
> replaces it, and inverts the trust: the Client holds only a token that is worthless outside one
> live execution, and every upstream secret stays behind the outbound URL policy, the per-Account
> concurrency budget, and the response bounds already described below.

## What this feature is for

An Agent's usefulness is bounded by the tools it can reach. MCP is the emerging standard for
exposing those tools, so openTag needs to be able to register an MCP Server once per Account,
mount it selectively per Agent, and hold a distinct credential for each of those mounts.

The design goal that shapes everything below: **authorization is strictly per Agent.** One Server
may be authorized with a Bearer key for one Agent and OAuth for another, and there is no
Account-level credential that either could fall back to. That is a deliberate product decision, not
an implementation detail — it is what makes "this Agent has access to production Linear, that one
only to the sandbox" expressible.

## Scope

| In scope | Out of scope |
| --- | --- |
| Server registry, Agent mounts, per-Agent overrides | Delivering credentials to a Provider |
| Anonymous, Bearer, and OAuth authorization | A Client-side loopback proxy |
| Capability probing and snapshot storage | stdio transport (a hosted service cannot run a user's local subprocess) |
| Background token refresh | The 2024-11-05 HTTP+SSE dual-endpoint transport |
| Web UI, CLI, Server API | Cloning an Agent with its mounts |

### Pi and Cloud runtime delivery

Pi has no native MCP configuration surface. openTag pins `pi-mcp-adapter` 2.36.0 and explicitly
loads one openTag wrapper extension while Pi's implicit extension discovery remains disabled. The
wrapper supplies an isolated programmatic configuration containing only `opentag-mcp`; Pi's global
and project MCP files are never merged. The gateway bearer travels in the Pi process environment,
not its arguments or persisted Session binding. The adapter uses the gateway's supported legacy
MCP handshake and exposes only the bounded `mcp` proxy tool. Direct tools, per-server namespace
proxies, resources, Tasks and scripting are disabled. A missing Agent mount or rejected service grant
leaves the Turn without MCP tools.

For Cloud, the trusted Runner requests the existing `mcp` execution service after verified custody,
acquires a bearer over the existing credential control tunnel, and passes the Server URL and bearer
to the disposable Sandbox worker through its stdin document. The Sandbox uses its existing public
egress to call the Server's `/api/v1/mcp` endpoint. The Server checks the live execution, Agent
scope, Sandbox generation, current control connection and custody on every call. Closing the
execution revokes the bearer. Cloud's current topology requires one Server process while Runner
control state is process-local; this path adds no separate WebSocket proxy or multi-Server promise.
No Account MCP schema, upstream credential flow, or management UI changes are needed.

## The protocol this speaks

The current MCP revision is **2026-07-28**, which is a *stateless, per-request* model. It is not the
`initialize`-handshake model that earlier drafts described, and getting this wrong produces a client
that appears to work against a permissive Server and fails against a conforming one.

| Earlier assumption | 2026-07-28 |
| --- | --- |
| `initialize` establishes a session | No handshake at all; each request carries its own protocol version and client capabilities |
| `notifications/initialized` | Does not exist |
| `Mcp-Session-Id` session header | Removed in this revision, along with the GET SSE stream, `DELETE`, and `Last-Event-ID` |
| `transport: http \| sse` | One Streamable HTTP endpoint; each message is a POST whose reply is JSON **or** a request-scoped SSE stream |
| Probe with `initialize` | Probe with **`server/discover`**, which returns the supported version set, capabilities, identity, and instructions in one round trip |

References (each section anchor is the sentence the rule comes from):

- [MCP versioning and backward compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#backward-compatibility) — the `400`/`404`/`405` body-first downgrade rule.
- [MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) — required headers, `_meta`, the two response shapes, and the `Mcp-Method`/`Mcp-Name` header sentinel.
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) — the discovery chain, client registration, PKCE, and the `resource` parameter.
- [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728#section-3) — Protected Resource Metadata.
- [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414#section-3.1) — Authorization Server Metadata and the well-known path-insertion forms.
- [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207#section-2.4) — the `iss` parameter.

### The per-request contract

Every POST carries these headers:

| Header | Value | Requirement |
| --- | --- | --- |
| `Accept` | `application/json, text/event-stream` | Both must be listed |
| `MCP-Protocol-Version` | e.g. `2026-07-28` | Required, and must **exactly** match the body's `_meta` version or the Server answers `400 HeaderMismatch` |
| `Mcp-Method` | the JSON-RPC `method` | Required on every request |
| `Mcp-Name` | `params.name` / `params.uri` | Required for `tools/call`, `resources/read`, `prompts/get` |

A `Mcp-Method`, `Mcp-Name`, or `Mcp-Param-*` value containing non-ASCII — and any ASCII value that
merely *looks like* the Base64 sentinel — must be encoded as `=?base64?<base64>?=`. Both halves
matter: without the second, a value that happens to start with the sentinel would be decoded as if it
were an encoding.

Every request body carries `_meta` with `io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities` (required) and `io.modelcontextprotocol/clientInfo`
(should). A response is a single JSON object or a request-scoped SSE stream; a notification is
`202` with no body; an unknown method is `404` with `-32601`.

**A 2xx status alone is not an answer.** A successful response is a JSON-RPC response or a bare
result object; a request-scoped SSE stream must carry the response for the request that opened it. An
unreadable successful body — an HTML error page from a proxy, an empty body, a truncated object, a
JSON value that is not an object, or an envelope with no `result` — and a stream that ends without
that answer are protocol failures reported as `MCP_UPSTREAM_ERROR`, never as an empty result. The
probe would otherwise record a Server that answered nothing as a healthy one with zero tools, and a
gateway `tools/call` would answer with an envelope that carries no `result`. A `202` or `204` answers
a notification only: `tools/call`, `tools/list`, and `initialize` each require a result, so an
acknowledgement of one is `MCP_UPSTREAM_ERROR` as well. A present but unreadable `error` member —
`null`, a scalar, an array, or a wrong-typed `code` or `message` — is also `MCP_UPSTREAM_ERROR`, with
the real HTTP status and a fixed message, never a raw type error. Valid answers still pass: an
explicit `"result": null`, a `202`/`204` notification acknowledgement, and a JSON-RPC error whose
`code` the caller branches on.

Because there is no session, **a Server must not rely on prior requests**. This is also why the probe
snapshot is per authorization row rather than per Server: two credentials are two independent clients.

### Downgrade to an older Server

On `400`, `404`, or `405` the **body is inspected first**:

- A recognizable modern JSON-RPC error means the peer *is* modern. Retry with a version from the
  error's `supported` list. **Never downgrade** — a modern Server that rejects our version would
  reject an `initialize` handshake too.
- Anything else means the peer predates this client, so `initialize` is the only way forward.

The MCP-registered codes `-32020`, `-32021`, and `-32022` are the modern signals. A generic
`-32601` is deliberately *not* one: an older Server also answers `-32601` for a method it does not
know, so treating it as a modern signal would retry forever instead of falling back once.

The handshake's `notifications/initialized` speaks the revision that `initialize` negotiated,
exactly as the request after it does. `2025-06-18` and `2025-11-25` expect `MCP-Protocol-Version` on
every request after the handshake, so the notification carries the negotiated value. `2025-03-26`
predates that header, so its notification omits it. Omission is not a neutral default: the
specification reads a missing header as `2025-03-26`, so a strict `2025-06-18` or `2025-11-25`
Server refuses a notification that a permissive Server accepted.

The same `-32601` decides the era **at any status**, not only on `400`, `404`, or `405`. Zoom's MCP
Server rejects `server/discover` with `-32601` at HTTP `200` while listing the method as valid; a
status-only gate read that as a modern peer and failed the probe with `MCP_UPSTREAM_ERROR` before
`initialize` was ever tried. This applies to the probe's `server/discover` only. The gateway never
replays on `-32601`, because a `tools/call` can raise it from inside the tool.

A legacy handshake is three requests: `initialize`, `notifications/initialized`, then whatever the
caller actually wanted. The notification is sent **unconditionally**: it is the message that closes
the handshake, not a message scoped to a session. A Server may answer `initialize` without issuing
`Mcp-Session-Id`, and such a peer still waits for `notifications/initialized` before it accepts
anything else, so sending it only when a session came back left a session-less Server talking to a
client that had never introduced itself. `Mcp-Session-Id` is attached to the notification only when
the handshake issued one. A failure of either handshake request fails the operation before anything
is dispatched: a gateway `tools/call` is never sent, and a probe records `probe_state = failed` with
no `tools/list`. The notification carries no `id` and returns no result, so its HTTP status is checked
on its own: a non-2xx answer is the transport's bounded failure — `The MCP Server returned HTTP
<status>`, or the shared `MCP_AUTH_REJECTION_SUMMARY` for `401` and `403`. That summary is built from
the status alone; the notification's response body is never interpreted or exposed, so an upstream
message cannot reach a probe error, a log line, or a model. The outbound fetcher reads and bounds the
body before it returns, so a redirect or an oversized body fails inside the fetcher first, as its own
bounded error, rather than as one of these status summaries.

The probe API answers `200` whether or not the probe succeeded and never returns the upstream
status. A failed probe and a legacy fallback each write one `info` line carrying `upstreamStatus`,
`rpcCode`, and `errorCode` — never the upstream message — so the status the Server really sent is
readable in the service log. Every probe log line identifies the Server by `endpoint`, the URL origin only,
because an endpoint path or query can carry a credential that the logger's key-name redaction does not catch.

A dual-endpoint HTTP+SSE Server (2024-11-05) is reported as `MCP_TRANSPORT_UNSUPPORTED` rather than
being half-supported.

**The era is a property of the origin**, and because an Agent-level `url` override makes the origin
differ per Agent, the cached era lives on the **authorization row**, not the definition.

## Data model

Four tables, migration `0045`.

```
mcp_servers                     a shared definition; holds no secret of any kind
  id, account_id, name, description, url,
  default_auth_kind, auth_header, auth_scheme, extra_headers,
  revision, created_at, updated_at
  unique(account_id, lower(name))

agent_mcp_servers               Agent <-> Server mount, plus that Agent's overrides
  agent_id, mcp_server_id, enabled,
  url_override, auth_header_override, auth_scheme_override, extra_headers_override,
  created_at, updated_at
  PK(agent_id, mcp_server_id)

mcp_server_authorizations       exactly one row per (Server, Agent)
  id, mcp_server_id, agent_id, kind, status,
  ciphertext, key_id, scopes, access_token_expires_at,
  authorization_server, oauth_resource, flow_oauth_resource, client_registration_id,
  state, state_expires_at, pkce_ciphertext, login_session_hash,
  probe_state, probed_at, probe_error,
  protocol_era, protocol_version, server_info, capabilities, instructions,
  tools, tools_count, tools_truncated,
  refresh_generation, refresh_claim_id, refresh_claimed_at, last_refreshed_at,
  failure_code, revision, created_at, updated_at
  unique(mcp_server_id, agent_id)
  unique(state) where state is not null

mcp_client_registrations        the Account's OAuth client at one issuer
  id, account_id, authorization_server, source, client_id, ciphertext, key_id,
  created_at, updated_at
  unique(account_id, authorization_server)
```

A few decisions worth stating explicitly:

- **`default_auth_kind` is a prefill, never a fact.** It is read when a new authorization is created
  and when deciding whether to auto-create a `none` row on mount. It does not constrain what any
  Agent writes, and no copy anywhere describes it as "the Server requires OAuth" — only as "the
  default for a new authorization".
- **There is no `mcp_servers.enabled`.** There is no Account-level MCP surface, so there is no
  global switch to keep in step. Usability is exactly: a mount row exists, it is `enabled`, and the
  definition belongs to the Agent's Account.
- **The authorization row carries no `account_id`.** Following the IM-binding precedent, the scoping
  column is `agent_id`; ownership is proven through `agents.created_by_user_id` and
  `mcp_servers.account_id`. `mcp_client_registrations` is the one table that stays Account-scoped,
  because a registration is the Account's client at an issuer rather than any Agent's.
- **`kind='none'` is a real row**, not an absence. Every `(Server, Agent)` pair has exactly one row,
  so resolution is one step and every credential has a place to keep its own snapshot.
- **The tool snapshot lives on the authorization row**, because the tool list genuinely differs per
  credential. The Server-level `lastProbedAt` is a `max(probed_at)` over those rows; there is no
  `mcp_servers.last_probed_at` column.
- **`tools_truncated` means "truncated *or* pagination did not finish."** The snapshot is never
  claimed to be the complete tool set.
- **`mcp_client_registrations` is append-only.** Deleting a registration when its last referencing
  Server disappears would need a cross-table reference count that is both expensive and easy to get
  wrong, to save a few dozen bytes; row count is Accounts x issuers ever used.

### Deleting things

| Operation | Rule |
| --- | --- |
| Delete a definition, with any live mount | **Refused** with `MCP_SERVER_IN_USE` and `boundAgentCount`; detach first |
| Delete a definition, with no live mount | Cascades its authorization rows; `mcp_client_registrations` is untouched |
| Delete an Agent | The Agent is **soft-deleted**, so its mounts and authorizations are cleaned up explicitly |
| Delete a Server from one Agent | Detach drops that Agent's mount and its authorization row |

**Agent deletion is a status change, not a row delete.** `agent-service.ts` sets `status='deleted'`,
so the `on delete cascade` on the binding and authorization tables is dead code on every real path.
Two consequences follow, and both are handled:

1. Every "is anybody using this" judgement joins `agents` and excludes deleted ones. That judgement
   exists exactly once, in `countLiveBindings`, which the delete guard, both aggregate counts, and
   the UI's "still in use by" list all share — so they cannot disagree and strand a definition nobody
   can delete.
2. `OnboardingResetService` removes the Account's MCP mounts and authorizations explicitly, after
   deleting its Agents, and its verification asserts that no mount survives. Server definitions are
   kept, matching how the reset already keeps GitHub connections.

Detaching is also what drops a credential: a Server an Agent no longer mounts keeps no usable secret
for it.

Bearer and anonymous saves validate and write in one short transaction, taking Agent → Server
definition → binding → authorization locks. Agent ownership/status and definition ownership are
rechecked before the locked mount authorizes the write. The Agent and definition use
`FOR SHARE` so saves on independent mounts and existing child-row FK key shares remain compatible; the mount uses
the same binding lock as cleanup. If detach wins, save finds no mount and returns
`MCP_BINDING_NOT_FOUND`; if save wins, detach removes that authorization afterward. A mount cannot
be deleted and recreated between the save's binding read and its commit. Disabling retains the
credential. No provider request or browser authorization wait runs inside this save transaction.

Probe settlement matches both the existing authorization row ID and its revision. A recreated
authorization can start at the same revision, so revision alone does not identify the row probed.
Late probe success, failure or transport errors leave a replacement authorization unchanged.
OAuth callback state/row fences and refresh claim fences retain their existing behavior.

## Authorization resolution

For one Agent and one Server, the chain has exactly one step:

1. An `active` authorization row → use it, with that row's `kind`.
2. Otherwise → unauthorized.

There is **no Account-level fallback**. The Server-level views show how many Agents are authorized
and how many are not; they never show a shared credential, because there is none.

Mounting does not require authorizing first. A Server that needs a credential can be mounted and
authorized afterwards, in which case the row's state reads as awaiting authorization. A Server whose
`default_auth_kind` is `none` gets its anonymous authorization row created on mount, so it is usable
immediately.

### Authorization kinds

| Kind | What is sent |
| --- | --- |
| `none` | No authorization header. Extra headers still apply |
| `bearer` | `<auth_header>: <auth_scheme> <key>`, where an **empty scheme sends the key verbatim** (`X-API-Key: <key>`) |
| `oauth` | `Authorization: Bearer <access token>` — fixed, because the specification requires the token in that header and forbids it in the query string |

`extra_headers` are additional static headers sent for all three kinds, since they are configuration
rather than credentials.

Bearer credential input accepts 1–16,384 characters, including long provider-issued access tokens.
This bound applies to the encrypted credential input; extra header values retain their separate
4,096-byte limit. A manually supplied access token uses the Bearer lifecycle and is not refreshed
automatically.

Header construction lives in exactly one place, `mcp-auth-headers.ts`, and its input is always the
**effective** configuration — the shared definition with the Agent's overrides applied. Probing and
any future runtime call take that same path, so a rule cannot be enforced in one and forgotten in
the other.

### Agent-level overrides

Each Agent may override four fields independently. `NULL` means inherit; any present value replaces.

| Effective field | Source |
| --- | --- |
| `url` | `COALESCE(binding.url_override, server.url)` |
| `auth_header` | `COALESCE(binding.auth_header_override, server.auth_header)` |
| `auth_scheme` | `COALESCE(binding.auth_scheme_override, server.auth_scheme)` |
| `extra_headers` | `COALESCE(binding.extra_headers_override, server.extra_headers)` |

`extra_headers` has **three** states, and two distinct actions to reach them:

| State | Stored | Meaning |
| --- | --- | --- |
| Inherit | `extra_headers_override IS NULL` | Use the shared set |
| Override with nothing | `extra_headers_override = '{}'` | This Agent sends **no** extra headers |
| Override with a set | `extra_headers_override = '{...}'` | Use this Agent's set |

"Restore inheritance" and "override with nothing" remain separate API and CLI actions
(`--clear-extra-headers` versus `--empty-extra-headers`). The GUI directly edits the effective header
list; deleting all rows writes an explicit empty map for this Agent. It does not expose inheritance
selectors or restore controls.

The other three fields need no such distinction, but they do need an **explicit** clear: an empty
string is a legitimate value for `auth_scheme`, so "clear" can never be spelled as an empty value.

The API and CLI retain both editing scopes; GUI Settings writes only Agent overrides:

| Scope | Writes to | Affects |
| --- | --- | --- |
| This Agent | `agent_mcp_servers.*_override` | Only this Agent |
| Shared definition | `mcp_servers.*` | Agents inheriting the changed fields |

Changing an Agent's overrides re-probes only that Agent. Changing the shared definition marks every
mount's probe pending, and a background pass re-probes each one; the previous snapshot stays readable
until a new result lands.

### Credential handling

Both secrets — an authorization row's access/refresh pair, and a registration's `client_secret` —
are sealed with `ApplicationCipher.encryptBound`. The AAD context is pinned as
`domain|field|field`, each field passed through `encodeURIComponent` and `null` rendered as the empty
string:

| Envelope | AAD |
| --- | --- |
| Authorization credential | `mcp-authorization\|<serverId>\|<agentId>\|<authorizationServer>` |
| Registration secret | `mcp-client-registration\|<accountId>\|<authorizationServer>` |
| PKCE verifier | The authorization envelope's context |

Two omissions are deliberate:

- **No `kind`.** Changing an authorization's kind is an UPSERT into the same row, so a `kind` in the
  AAD would make the new credential unopenable by the write that just replaced the old one.
- **No `auth_header` / `extra_headers`.** Renaming the authorization header is a configuration edit,
  not a credential change, and must not invalidate a stored key.

The alternative, `JSON.stringify([...])`, has no contract beyond the array order: a later field
reordering would silently make every stored ciphertext unopenable. A unit test asserts the literal
format, so that reordering fails loudly in CI instead of in production.

No API response ever carries a credential — not even masked. A caller learns only `hasCredential`.

## Outbound URL policy

Every URL this feature dials goes through one gate, `assertOutboundUrl`, in the same file as the only
outbound `fetch`. That is not just the configured MCP endpoint: the discovery chain takes several
URLs straight from the peer's responses, and each one is an SSRF vector.

| Source | Peer-controlled field |
| --- | --- |
| 401 challenge | `WWW-Authenticate: Bearer resource_metadata="..."` |
| Protected Resource Metadata | `authorization_servers[]`, `resource` |
| Authorization Server metadata | `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `jwks_uri` |
| Client metadata document | the `client_id` URL itself |
| Redirects | any step's `3xx Location` |

The rules are applied uniformly to all of them:

- Only `https`, except that plain `http` to `127.0.0.1` / `::1` / `localhost` is allowed when **both**
  the environment is not hosted (`OPENTAG_ENV=dev`) **and** `OPENTAG_MCP_ALLOW_LOOPBACK=true`. A
  hosted environment refuses loopback unconditionally and ignores the setting: there, `127.0.0.1` is
  the *server's own* loopback, so allowing it would hand every Account a scanner for the management
  port, metrics, health, and everything else on the host.
- No fragment, no userinfo.
- A parsed address in `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`,
  `fe80::/10`, `0/8`, `100.64/10`, `192.0.0/24`, `198.18/15`, or a multicast/reserved range is
  refused with `MCP_URL_BLOCKED`.
- **Redirects are never followed** (`redirect: "manual"`). A `3xx` is a refusal, and its `Location`
  is neither read nor dialled — otherwise a redirect would be a way to reach a destination the gate
  would have refused.
- At most four concurrent outbound requests per Account, a 10-second deadline, and a 1 MiB response
  bound. Discovery hops count against the same budget, so the chain cannot be used to sidestep it.
  **These are the management-plane numbers.** A runtime tool call uses a second fetcher instance with
  its own deadline (120 s) and its own per-Account counter (8) — see [the gateway](#the-mcp-gateway)
  for why sharing them was wrong.
- The deadline is one budget per call. It starts before the hostname is resolved and covers the
  request that follows, so a resolver that never answers ends the call instead of outliving every
  bound; the call settles at the deadline and releases its Account slot there. A name lookup cannot
  be aborted, so its result is only ever used after a further check: a lookup that answers too late
  never turns into the request it was resolved for.
- A cancelled call is not dialed. A signal that is already aborted when the call starts, or that
  fires while the name is being resolved, ends the call before anything leaves the process; one that
  fires after the request was sent closes it.

`mcp-transport.ts`, `mcp-oauth.ts`, `mcp-probe.ts`, and `mcp-oauth-flow-service.ts` must not call
`fetch` themselves; they take `fetchOutbound` from the policy module. A regression test scans those
four files for a direct `fetch(` call, so the property is enforced by CI rather than by review.

**Every hostname is resolved before dialing, and every A and AAAA record must be public.** The URL
check can only judge what a name spells, and a name spells nothing about where it points:
`localtest.me` is public DNS answering `127.0.0.1`, `metadata.google.internal` is a split-horizon
name, and `foo.localhost` is reserved for loopback. All records are checked rather than the first, so
the verdict does not depend on resolver order. A name that does not resolve is reported as
unreachable rather than blocked, because the caller's URL is fine and the peer is missing.

Not attempted: **DNS rebinding**, where a name resolves publicly during this lookup and privately at
connect time. Closing it needs the connection pinned to the validated address, which Node's `fetch`
cannot express without an undici `Agent` with a custom `connect.lookup`; that is the upgrade path if
a deployment faces a hostile resolver rather than a hostile Server.

A response the gate refuses is **closed, not read**. That covers a `3xx`, a body whose declared
`Content-Length` exceeds the bound, and one that exceeds it while it arrives: cancelling the body
closes the socket, so the peer stops writing. Draining it instead would keep the connection open for
as long as the peer chose to send, for an answer this deployment had already rejected. An expired
deadline closes the body the same way.

## OAuth

### Discovery

```
POST <url>  server/discover  (modern headers + _meta)
  └→ 401 + WWW-Authenticate: Bearer resource_metadata="<PRM URL>"[, scope="..."]
     Use resource_metadata when present. Otherwise fall back to well-known, in this order:
       a. <origin>/.well-known/oauth-protected-resource<endpoint path>
       b. <origin>/.well-known/oauth-protected-resource

Read the Protected Resource Metadata document (RFC 9728)
  → authorization_servers[] (>= 1), scopes_supported[], resource (the identity check below)

Try each authorization server, in the document's order, using the well-known forms in this order:
  with a path:  /.well-known/oauth-authorization-server/<path>
                /.well-known/openid-configuration/<path>
                /<path>/.well-known/openid-configuration
  without one:  /.well-known/oauth-authorization-server
                /.well-known/openid-configuration
```

The **issuer check** is a plain string comparison: the document's `issuer` must equal the issuer the
well-known URL was built from. No case folding, no default-port elision, no trailing-slash or
percent-encoding normalization. A mismatch is an authorization-server mix-up, it is refused outright,
and it does **not** fall through to the next well-known form.

One spelling difference is accommodated, and only on the Google Workspace path: when the Server's
effective origin is one of the eight Google MCP endpoints and an advertised identifier is
`https://accounts.google.com/`, the flow requests the slash-free spelling — the one Google's
metadata document declares, and the one `authorizationServerMetadataUrls` already maps to the same
well-known document — and records that spelling on the row. Every other advertised identifier is
requested exactly as published and compared exactly, so a provider whose legitimate issuer ends in a
slash keeps its identity and still matches its own metadata document (RFC 8414 §3.3); case, ports,
paths, and encoding remain significant.

The **resource check** is an identity check with one bounded compatibility path (RFC 9728 §3.3).
The default is strict: a document that names no `resource` uses the endpoint, and an advertised value
that normalizes to the endpoint is accepted as published. When the document was retrieved from a
well-known protected-resource URL on the endpoint's own origin, the advertised value may instead be
the identity that URL encodes — the bare form identifies the origin, the path-inserted form
identifies origin + path — provided that identity is an ancestor-or-equal of the endpoint path at a
path-segment boundary, ignoring the endpoint's query. That is what lets Airtable and Amplitude
advertise their origin for an endpoint at `/mcp`, and Atlassian advertise `/v2/mcp` while its
endpoint adds `?tools=all`. Everything else is refused: another origin, a same-origin sibling path,
a value that is not an absolute HTTP(S) URL, userinfo, or a fragment. The accepted spelling is kept
verbatim and travels as the `resource` parameter on the authorization request, the code exchange,
and every refresh. This paragraph-1 mapping for challenge-named well-known URLs is a deliberate,
bounded exception to §3.3's second paragraph; strict equality remains the rule everywhere else.

### Choosing an authorization server

A Protected Resource Metadata document may list several authorization servers, and credentials are
not portable between them, so "first one wins" is not good enough. Candidates are tried in order and
the first that can complete discovery, client resolution, and authorization-URL construction is
recorded on the authorization row. An issuer that fails is reported and the next one is tried; only
when all of them fail does the attempt error, naming the issuers it tried.

Once an issuer is recorded it is reused for both refresh and reauthorization. Only a terminal failure
sends the flow back through discovery to pick another.

Users never choose an issuer — it is not a user-facing concept. The detail view shows which one is
currently selected.

### Client registration

| Order | Mechanism | Condition |
| --- | --- | --- |
| 1 | Deployment Google client | The Server's effective origin is a Google Workspace MCP origin and discovery resolves Google's authorization server |
| 2 | Pre-registered | A row exists for `(Account, issuer)` with `source='preregistered'` |
| 3 | Client ID Metadata Document | The AS advertises `client_id_metadata_document_supported` |
| 4 | Dynamic Client Registration | The AS advertises a `registration_endpoint` |
| 5 | — | Otherwise `MCP_REGISTRATION_UNSUPPORTED`, with the hint that a pre-registration is needed |

The client metadata document is published at `GET /oauth/client-metadata.json`, unauthenticated,
because it must be readable by the authorization server. Its `client_id` is this deployment's own URL
derived from the configured public origin — never from the request, so a spoofed `Host` header cannot
change what it claims to be.

Dynamic registration declares `application_type: "web"` (this is a remote web application with a
server-side callback, not a native client), the exact callback
`<public origin>/api/v1/mcp-servers/oauth/callback`, `grant_types: ["authorization_code",
"refresh_token"]`, `response_types: ["code"]`, and `token_endpoint_auth_method: "client_secret_basic"`.

A registration is **not** reused across a changed issuer: the specification forbids it, and the
authorization is revoked with a clear "authorize again" signal. A client metadata document credential
*is* portable, so it is reused.

#### The deployment Google client

Google's remote MCP servers offer neither a registration endpoint nor a client metadata document, so
a deployment that wants its Agents to use Gmail, Google Drive, Docs, Sheets, Slides, Calendar, Chat,
or People configures its own OAuth client with `OPENTAG_MCP_GOOGLE_CLIENT_ID` and
`OPENTAG_MCP_GOOGLE_CLIENT_SECRET` — both together or neither; a half-configured pair fails startup.
Operator setup:

- Create an OAuth client of type **Web application** in Google Cloud and register
  `<OPENTAG_PUBLIC_URL>/api/v1/mcp-servers/oauth/callback` as an authorized redirect URI.
- On the OAuth consent screen's data access, add every scope the eight catalog entries request
  (`auth.oauth.scopes` in `packages/mcp-presets/mcp-catalog.yaml`). The entries carry Google's
  recommended per-product subset, which deliberately avoids restricted scopes such as
  `https://mail.google.com/`.
- Google issues a refresh token only for `access_type=offline`, with `prompt=consent` on
  re-authorization; this deployment adds both to that client's authorization request, and Google does
  not advertise `offline_access`.
- An OAuth app left in testing mode expires refresh tokens after seven days; publish the app for
  production use.

The client is resolved from configuration, never stored, and it is offered only when both the
Server's effective origin is one of the eight Google endpoints and the issuer canonicalizes to
Google's — a Server that merely names Google as its authorization server cannot borrow it. Unsetting
the variables takes effect immediately and leaves nothing to clean up.

#### The deployment Canva client

Canva serves two MCP endpoints, and they are not interchangeable:

| Endpoint | Authorization server | Client |
| --- | --- | --- |
| `https://mcp.canva.com/mcp` | `https://mcp.canva.com` | Waitlist client: a client metadata document or dynamic registration, no secret |
| `https://api.canva.com/connect/v1/mcp` | `https://www.canva.com` | Developer Portal client: a client ID, a client secret, and redirect URLs the integration manages |

The catalog ships the waitlist endpoint, which works without configuration through the automatic
resolution above. A deployment that wants Canva to use its own Developer Portal client configures
`OPENTAG_MCP_CANVA_CLIENT_ID` and `OPENTAG_MCP_CANVA_CLIENT_SECRET` — both together or neither; a
half-configured pair fails startup. Operator setup:

- In the Canva Developer Portal, create an app, turn on **Canva MCP** under the integration
  methods, copy the client ID, and generate a client secret.
- Add `<OPENTAG_PUBLIC_URL>/api/v1/mcp-servers/oauth/callback` as a redirect URL. For the hosted
  deployment this is `https://app.opentag.build/api/v1/mcp-servers/oauth/callback`.
- The flow requests the scopes that the endpoint's protected resource metadata advertises in
  `scopes_supported`, and authenticates at Canva's token endpoint with `client_secret_basic`.

The client follows the same rules as the Google client: it is resolved from configuration and never
stored, and it is offered only when the Server's effective origin is exactly `https://api.canva.com`
and the discovered issuer is exactly `https://www.canva.com`. The waitlist endpoint never receives
it, so authorizations on that endpoint keep their client whether or not the pair is configured.

The catalog follows the configuration. `GET /api/v1/mcp-catalog/endpoints` returns the catalog
entries whose endpoint the deployment replaces — `{ "catalogId": "canva", "url":
"https://api.canva.com/connect/v1/mcp" }` when the pair is configured, and nothing otherwise — and
never returns client material. The Web App reads it before Discover offers a card, so the Canva card
creates its Server on the Developer Portal endpoint only when the deployment has the client for it.
The Web App accepts only the replacement that `MCP_CATALOG_DEPLOYMENT_ENDPOINTS` names for that
entry, and it recognizes both Canva endpoints as Canva for icons, titles, and the OAuth default. If
the read fails, the catalog stays as shipped.

A served entry keeps its shipped endpoint as an identity. Existing mounts recognize every endpoint
of the entry and continue working through their own client. A new Web installation uses the
preferred endpoint and creates an independent definition, with name-conflict handling if an older
installation already holds the catalog name.

#### The deployment HubSpot, Asana, and Zoom clients

These providers offer neither dynamic registration nor a client metadata document, so a deployment
that wants its Agents to use them registers its own OAuth app with each provider and configures
`OPENTAG_MCP_<BRAND>_CLIENT_ID` and `OPENTAG_MCP_<BRAND>_CLIENT_SECRET` — both together or neither; a
half-configured pair fails startup. Without a pair, the card keeps the automatic resolution above and
fails with `OAUTH_FAILED` because no client can be registered.

The providers are declared once in `MCP_STATIC_OAUTH_PROVIDERS` (`packages/shared/src/mcp.ts`), which
also derives the variable names; the Canva client above is a row of the same table.

| Brand | Variables | Origin | Issuer | Token endpoint authentication |
| --- | --- | --- | --- | --- |
| HubSpot | `OPENTAG_MCP_HUBSPOT_CLIENT_*` | `https://mcp.hubspot.com` | `https://mcp.hubspot.com` | `client_secret_post` |
| Asana | `OPENTAG_MCP_ASANA_CLIENT_*` | `https://mcp.asana.com` | `https://app.asana.com` | `client_secret_basic` |
| Zoom | `OPENTAG_MCP_ZOOM_CLIENT_*` | `https://mcp.zoom.us` | `https://zoom.us` | `client_secret_basic` |

Operator setup, for every brand: register `<OPENTAG_PUBLIC_URL>/api/v1/mcp-servers/oauth/callback` as
the redirect URL. Create a HubSpot **MCP Auth App** (Development > MCP Auth Apps), an Asana app of
type **MCP app**, and a Zoom **General app** with user-level OAuth. HubSpot assigns scopes at
installation and advertises none in its metadata. Zoom's challenge carries no `scope`, so the flow
requests every `scopes_supported` entry its protected resource metadata advertises; a Zoom app grants
only the scopes listed on its **Scopes** page, so add the full advertised list there.

Each client follows the same rules as the Google and Canva clients: it is resolved from configuration
and never stored, and it is offered only when the Server's effective origin is one of the provider's
origins and the discovered issuer is exactly the provider's. The token endpoint authentication method
is part of the provider row, because each authorization server rejects the other one. Changing the
client ID invalidates refresh tokens that the previous client obtained; `invalid_client` is terminal,
so those Agents must authorize again.

### The authorization round trip

- PKCE `S256`; the verifier is encrypted and the challenge travels.
- **`resource` is established at discovery and travels verbatim.** The accepted value is the
  advertised one, or the endpoint when the document named none. `start` records it as
  `flow_oauth_resource`; the callback stores it with the credential as `oauth_resource` and clears
  the flow's copy, so the authorization request, the code exchange, and every refresh send exactly
  the same string. Rows created before the columns existed derive it from the effective endpoint,
  so existing authorizations keep working.
- `state` is single use, valid for 10 minutes, and stored **hashed**: the raw value only ever exists
  in the URL the browser carries, so a leaked row cannot be turned into a redeemable callback.
- **The flow is bound to the browser that started it.** `start` issues a single-use secret as an
  `HttpOnly` cookie scoped to the callback path and records its hash on the row; the callback must
  present the matching secret. The state alone is not enough, because the state travels in a URL that
  can be handed to anyone — without this binding, developer A could start a flow, forward the URL, and
  have developer B's approval land a credential on A's Agent.
- Re-starting a flow overwrites `state`, its deadline, the PKCE verifier, and the binding in one
  write, so the previous callback URL is immediately unusable. The callback then validates the
  browser binding, then existence, then expiry, then pending status, and clears the flow as soon as
  the code is redeemed.
- **The client is the one `start` registered.** The flow records `client_registration_id`, and the
  callback and every later refresh look that registration up rather than resolving a client again.
  Registering afresh at callback time produces a second client (DCR) and then presents the first
  client's code under it, which a strict authorization server refuses with `invalid_client`.

**`iss` validation (RFC 9207)**, exactly per the specification's table:

| AS metadata `authorization_response_iss_parameter_supported` | Response `iss` | Action |
| --- | --- | --- |
| `true` | present | Compare with the recorded issuer as a plain string |
| `true` | absent | **Refuse** |
| `false` / absent | present | Compare with the recorded issuer as a plain string |
| `false` / absent | absent | Continue |

On a mismatch, the response's `error`, `error_description`, and `error_uri` are neither shown nor
adopted — a mismatched response is evidence of an attack, not a hint about what went wrong.

**Scopes**, in priority order: scopes an explicit request names (the CLI's `--scopes`, or a catalog
entry's `auth.oauth.scopes`); otherwise the challenge's `scope`; otherwise the Protected Resource Metadata
document's `scopes_supported`; otherwise no `scope` parameter at all. The protected resource's own
list is the fallback the specification names, and it is load-bearing for Google, whose authorization
endpoint rejects a request carrying no `scope`. `offline_access` is added only when the
*authorization server's* metadata advertises it.

The callback lands on a fixed local surface,
`/agents/{agentId}/mcp?mcp_oauth=success&server={serverId}` or the same with
`mcp_oauth=error&mcp_oauth_error=<bounded code>`. The authorization server's
`error_description` is never echoed.

The callback does **not** probe: that would hold the browser for the duration of an upstream round
trip. The row is stored as `active` and a probe is fired without being awaited, with `probeState`
telling the UI that a result is still coming.

### Refresh

Refresh happens only for rows whose `kind='oauth'` and whose expiry is near, and it never
re-discovers: it uses the endpoint the row already recorded, so a peer cannot move this client's
token endpoint mid-flight.

The credential's recorded `oauth_resource` is its audience for its whole life. Before contacting the
authorization server, refresh re-checks that the recorded resource still relates to the effective
endpoint (strict equality, or the same-origin ancestor-or-equal rule above). A mismatch — an
effective endpoint whose origin moved, say — marks the row `error` with
`failure_code = MCP_AUTHORIZATION_REQUIRED` and keeps the credential for a deliberate
reauthorization instead of minting a token for an audience it no longer talks to. The
management-plane URL change already revokes origin-bound credentials outright; this is the invariant
behind that behavior, not a replacement for it.

The deadline is pulled forward by `min(5 minutes, half the lifetime)`, so a refresh never races the
request that uses the token. A lifetime shorter than ten minutes therefore gets half of it. A missing
`expires_in` is treated as a five-minute lifetime.

Two mechanisms keep concurrent workers from spending one refresh token twice: a single-flight claim
taken with a compare-and-swap (and expiring after two minutes, so a crashed worker cannot wedge a
row), and a generation fence on the write-back.

| Observation | Verdict | Action |
| --- | --- | --- |
| Token endpoint 2xx | Success | New envelope, `refresh_generation += 1`, claim cleared, **no re-probe** |
| `invalid_grant` | **Terminal** | `revoked`; the user must authorize again |
| `invalid_client` | **Terminal** | `revoked`; the user must re-register the client |
| Transport failure, timeout, 5xx, unparseable | **Outcome unknown** | `error` with `failure_code = MCP_REFRESH_OUTCOME_UNKNOWN`, keep the refresh token, require reauthorization, **never** auto-retry |
| Recorded resource no longer matches the effective endpoint | No call made | `error` with `failure_code = MCP_AUTHORIZATION_REQUIRED`, credential kept for a deliberate reauthorization |
| Local envelope decryption failure | Nothing was sent | Release the claim, leave the state, retry next pass |
| MCP Server returns 401/403 | Not evidence the credential is dead | Never clear the refresh token |

A row that has no refresh token at all simply lapses to `expired` at its deadline; there is nothing
to spend and retrying forever would achieve nothing.

The scan joins `agents` and excludes deleted ones, so a soft-deleted Agent's credential is not
renewed.

## Probing

Triggers: creating a definition, mounting, changing the effective `url`, storing a Bearer key,
completing OAuth, the "discover tools again" action, and the retry after a failure.

```
1. POST <url>  server/discover
   → { supportedVersions[], capabilities, _meta['io.modelcontextprotocol/serverInfo'], instructions? }
2. Choose a version from supportedVersions, preferring 2026-07-28. If none is supported, apply the
   downgrade rule and record the era.
3. When capabilities declares tools → POST <url>  tools/list, paging on nextCursor
```

The probe runs with an Agent's authorization headers, because the credential is per Agent. It writes
**only to that authorization row**: `probe_state`, `probed_at`, `server_info`, `capabilities`,
`instructions`, `tools`, `tools_count`, `tools_truncated`, `probe_error`, `protocol_era`, and
`protocol_version`. It never writes `mcp_servers`, which is what keeps a user's `expectedRevision`
valid while probes run concurrently.

A failed probe records the failure and leaves the snapshot columns alone, so the UI shows "discovery
failed" beside the last good tool list rather than going blank.

### Two names, one description

A definition has exactly one name, `name`: the lowercase handle the CLI addresses and the UI titles
rows with. There is no separate display name, because the two would have to disagree about which is
what a user calls the Server, and the CLI needs the stable handle in every case.

The definition's `description` is what a probe discovered — the Server's own
`serverInfo.description`, kept verbatim in `server_info` and extracted on read — **not** something a
user types at creation time. Creation writes NULL, because nothing can be probed before the
definition exists. `description` on the definition row is only ever a user's override of that
probed value, and when it is set the UI shows it instead of the discovered one. The two are never
merged: a reader can always tell an operator's words from a peer's.

### Pagination and bounds

`tools/list` is paginated. A one-POST implementation reads as correct against a one-page Server and
silently drops tools against a real one, so the client loops on `nextCursor` until it is absent, a
bound is hit, or the probe budget is spent.

Each page is held to the specification's `ListToolsResult`: the result must be an object with a
`tools` array, and `nextCursor`, when present, must be a non-empty string. A page that breaks that —
a non-object result, a missing or non-array `tools`, a cursor of another type or empty — **fails the
probe** with `MCP_PROBE_FAILED`, on the modern and legacy paths alike, and the last good snapshot is
left in place. It used to parse as an empty final page, which overwrote the last good snapshot with
a successful empty or incomplete one. `nextCursor: null` is read as absent: the specification does
not allow it, but many serializers emit it for an unset optional field, and it carries no token
that could name a further page, so end-of-list is its only meaning.

- At most 200 tools, and at most 256 KiB for the whole snapshot.
- Per tool: `name` ≤ 128 bytes, `description` ≤ 64 KiB on both the probe's writer bound and the
  snapshot's reader bound, `inputSchema` ≤ 64 KiB serialized, all in UTF-8 bytes. The bounds
  live in `@opentag/shared` (`MCP_TOOL_NAME_MAX_BYTES`, `MCP_TOOL_DESCRIPTION_MAX_BYTES`,
  `MCP_TOOL_SNAPSHOT_DESCRIPTION_MAX_BYTES`, `MCP_TOOL_INPUT_SCHEMA_MAX_BYTES`) and
  `MCPToolSnapshotSchema` enforces them on read — the input schema by the byte length of its JSON
  serialization, refused rather than thrown on when it cannot be serialized — so the gateway's parse
  of a stored snapshot cannot admit an oversized tool from a row written under an older bound or
  damaged out of band. They are sized for real hosted Servers: Linear and Notion ship tool
  descriptions of several KiB and input schemas past 8 KiB, and Google's Docs MCP ships an
  `update_doc` description of ~35 KiB.
- The description's writer and reader bounds are separate, and the reader's must never be the
  narrower one. A stored snapshot is durable state, and a rollback restores the older Server image
  while the rows it wrote stay behind ([deploying](../../operations/deploying.md)); if both bounds moved together,
  the first re-probe after a release could write a description the previous reader rejects, and
  because the gateway parses the whole per-Server array at once it would drop every tool for that
  Server, not just the oversized one. The raise to 64 KiB followed that sequence — the wider reader
  shipped first, the writer followed — so the two are equal today, and any later raise must widen
  the reader first again. Keep the reader bound ≥ the writer bound.
- A tool that violates a per-tool bound — or has no name, or is not an object — is **skipped**, never
  stored trimmed. The probe logs one `warn` line per skipped tool (Account, URL, tool name, the
  bound it violated, the observed size), keeps every other tool on the page, keeps paginating, and
  sets `tools_truncated = true`. It used to fail the whole probe (`probe_state='failed'`), which left
  an Agent with no tools from a Server whose every other tool was fine. Only an answer that is not a
  usable page at all — a JSON-RPC error, a non-2xx status, a transport failure — still fails the
  probe. A page whose every tool is skipped succeeds with an empty, truncated snapshot.
- Hitting a cap, running out of budget, or skipping a tool sets `tools_truncated = true` while
  `probe_state` stays `succeeded`, because the tool list is a snapshot rather than an authoritative
  whole. The flag does not say which of the three happened; the log does.
- A hard Account-level bound: the sum of all `mcp_server_authorizations.tools` for one Account is
  capped at 64 MiB. A probe that would exceed it fails with `MCP_PROBE_FAILED` rather than being
  stored silently.

`ttlMs` / `cacheScope` from the response are recorded but unused: probing is event-triggered, so
there is no time-based expiry to honor. `probed_at` is enough.

### Era invalidation

The cached era is written on a successful probe and dropped when the assumption behind it fails:

- A cached `legacy` failed its `initialize` negotiation.
- A cached `modern` received `UnsupportedProtocolVersionError`.
- The effective `url` changed, since the origin may have. This is applied at write time, not left to
the next probe: the era is a property of the origin, so a changed endpoint invalidates the cache for
every mount whose effective URL moved — all of them for a shared-definition change, and only the
overriding Agent for a `url_override` change. Renaming the authorization header does **not**
invalidate it, because that changes no origin.
- A user asked for a re-probe.

A token refresh, a timeout, a 5xx, or a 401 does **not** invalidate it: none of them is evidence that
the origin changed its protocol, and dropping a correct cache on every transient error would make the
cache worthless.

## Error codes

`packages/shared/src/mcp.ts` publishes `MCP_ERROR_CODES` alongside the `MCP_*` codes added to
`ErrorCodeSchema`, and `MCP_ERROR_CODE_METADATA` is the single mapping from code to `category` and
`statusCode`. `McpServiceError` reads that table, so an HTTP status can never be invented at a call
site.

| Code | `category` | `statusCode` |
| --- | --- | --- |
| `MCP_SERVER_NOT_FOUND` | `deterministic` | 404 |
| `MCP_BINDING_NOT_FOUND` | `deterministic` | 404 |
| `MCP_AUTHORIZATION_NOT_FOUND` | `deterministic` | 404 |
| `MCP_SERVER_FORBIDDEN` | `credential` | 403 |
| `MCP_SERVER_NAME_CONFLICT` | `deterministic` | 409 |
| `MCP_BINDING_CONFLICT` | `deterministic` | 409 |
| `MCP_SERVER_REVISION_CONFLICT` | `deterministic` | 409 |
| `MCP_SERVER_IN_USE` | `deterministic` | 409 |
| `MCP_SERVER_URL_INVALID` | `validation` | 400 |
| `MCP_URL_BLOCKED` | `validation` | 400 |
| `MCP_AUTH_HEADER_INVALID` | `validation` | 400 |
| `MCP_CREDENTIAL_INPUT_INVALID` | `validation` | 400 |
| `MCP_AUTHORIZATION_KIND_INVALID` | `validation` | 400 |
| `MCP_AUTHORIZATION_REQUIRED` | `credential` | 401 |
| `MCP_AUTHORIZATION_SCOPE_REQUIRED` | `credential` | 403 |
| `MCP_OAUTH_FLOW_INVALID` | `credential` | 400 |
| `MCP_OAUTH_FLOW_EXPIRED` | `credential` | 410 |
| `MCP_OAUTH_DENIED` | `credential` | 502 |
| `MCP_OAUTH_FAILED` | `credential` | 502 |
| `MCP_REGISTRATION_UNSUPPORTED` | `deterministic` | 422 |
| `MCP_REGISTRATION_FAILED` | `deterministic` | 502 |
| `MCP_TRANSPORT_UNSUPPORTED` | `deterministic` | 422 |
| `MCP_PROTOCOL_UNSUPPORTED` | `validation` | 400 |
| `MCP_UPSTREAM_UNAVAILABLE` | `transient` | 503 |
| `MCP_UPSTREAM_ERROR` | `transient` | 502 |
| `MCP_PROBE_FAILED` | `transient` | 502 |
| `MCP_REFRESH_OUTCOME_UNKNOWN` | `transient` | 502 |

Both enums come from the existing vocabulary: `category` is one of `ErrorCategorySchema`'s
`credential` / `deterministic` / `validation` / `transient` / `rate_limit`, which is **not** the
`StructuredErrorCategorySchema` set used by [the error taxonomy](../../operations/error-taxonomy.md). The two do not
share values and are not interchangeable.

`MCP_AUTHORIZATION_REQUIRED`, `MCP_AUTHORIZATION_SCOPE_REQUIRED`, and `MCP_REFRESH_OUTCOME_UNKNOWN`
are **internal verdicts**: they appear in a row's `failure_code` / `probe_error` and in UI copy, never
as the primary code of a management-plane HTTP response.

Background work — a failed probe or refresh — also emits a `StructuredError` under the same `MCP_*`
string, since both vocabularies are uppercase underscore. Its `retryability` follows from the
category (`unavailable` / `transient` → `backoff`, `credential` → `after_auth`, otherwise `never`)
and its `phase` is `provider` for probe and refresh work.

## The MCP gateway

The management plane says which Servers an Agent may reach and with whose credential. The gateway is
how it actually reaches them.

```
Claude Code (spawned per run, local Computer)       Codex (one App Server per Session; the thread
   │                                                   │  is reloaded with each run's bearer)
   │  MCP Streamable HTTP, Authorization: Bearer <execution token>
   ▼
POST /api/v1/mcp                                    the inbound MCP server
   │  1. the bearer resolves to one executionId (hash-only in-memory store)
   │  2. the execution fence re-checks everything, and yields accountId + agentId
   ▼
resolveActiveCredential → buildHeadersFor → McpTransport → McpOutboundFetcher
   ▼
the Agent's bound MCP Servers
```

**The bearer proves which execution is calling, and nothing else.** The token record holds an
execution id and no identity, so Account and Agent are read from the live execution record on every
request. A token cannot assert whose tools it wants, and a stale token cannot name an Agent whose
execution has since been replaced.

**It is execution-scoped by construction.** A 256-bit random value prefixed `otmg_`, retained only as
its SHA-256 digest, one live token per execution, revoked from the single point every execution ends
at — explicit close, connection replacement, owner loss, and the stale sweep alike. That is what
makes writing a bearer into a provider config file acceptable: a token a prompt-injected Agent reads
out of `mcp.json` buys no access after the turn.

The token is fetched through its own `runtime:mcp:gateway` frame rather than returned with the
execution-open result, because that result has never carried a secret and both existing secrets in
the protocol — capability tokens and proxy tickets — are fetched the same way. The Client composes
the endpoint URL against the Server origin it already pinned; only the fixed path crosses the wire.

### Codex: rebinding the thread per run

Codex spawns its App Server once per Session runtime from a frozen argument vector, while the bearer
is minted per execution, so the bearer cannot be written into that argument vector. Codex applies a
thread's `config` overrides only when it loads the thread, so before each run that carries a gateway
the Codex runtime reloads the thread with that run's `mcp_servers`:

- **A persisted thread** is unloaded (`thread/unsubscribe`) and resumed (`thread/resume`) with the
  gateway as its only MCP server. Codex connects and lists the catalogue during the resume.
- **A thread that has never started a turn** has no rollout to resume and no history to lose, so it is
  replaced by a new `thread/start` with the same parameters and hosted tools, and the Session binding
  moves to the new thread through `binding_changed`. The previous thread stays loaded until the
  replacement exists.
- **The bearer only ever travels over the App Server's stdio** and is held in its memory. It never
  appears in the argument vector, the environment, or a config file, so what a model command can
  reach is at most the live execution's own bearer, which the Server revokes when the execution ends.
  The launch arguments keep `mcp_servers={}`, and the override replaces the whole table, so the
  user's own Codex servers stay excluded.
- **One deadline** (15 s) covers the whole rebind, attach and restore alike, and a run cancelled
  before its turn starts ends without waiting for one. The attach may use two thirds of the deadline;
  the rest is reserved for the restore. An attach that is not confirmed restores the thread with no
  MCP server — losing the gateway costs the turn its MCP tools, never the turn, and never leaves the
  run's bearer attached to a catalogue it did not confirm. A later run without a gateway rebinds once
  so revoked tools disappear. Only a thread Codex cannot reload at all within the deadline fails that
  run, since no thread is left to start the turn on; the next run rebinds it.
- **Conversation history survives the rebind.** `excludeTurns` only keeps the turn list out of the
  `thread/resume` response; Codex reloads the thread's full model context from its rollout.
- Gateway tools are pre-approved as a server (`default_tools_approval_mode = "approve"`), matching the
  Claude Code allow rule; Codex otherwise rejects every MCP call under the `never` approval policy.

Codex always defers MCP tools behind its built-in `tool_search`, so the model sees the
`opentag-mcp` server and discovers individual tools on demand rather than in its initial tool list.

### What the gateway speaks

The inbound gateway supports `2025-11-25`, `2025-06-18`, and `2025-03-26`. Its upstream client
separately supports the modern `2026-07-28` revision. Claude Code's in-process bridge still speaks
`2025-03-26`, and Pi explicitly uses the legacy handshake. Codex receives the gateway URL and bearer
when rebinding its thread; openTag does not pin a modern protocol revision in that configuration.

The gateway does not implement modern per-request version metadata, mirrored HTTP header validation,
or `resultType` responses, so it must not advertise that revision. Discovery lists only the three
legacy revisions, allowing an automatically negotiating client to fall back to `initialize` before
listing or calling tools.

| Method | Answer |
| --- | --- |
| `initialize` + `notifications/initialized` | The legacy handshake. A supported requested revision is echoed; an unsupported or modern revision selects the newest supported legacy revision |
| `server/discover` | Only the three supported legacy revisions; modern support is not advertised |
| `ping` | `{}` |
| `tools/list` | The aggregated catalogue, served whole; no cursor, because there is never a further page |
| `tools/call` | Routed upstream |

Replies are always a single JSON object; the request-scoped SSE form is permitted but nothing here is
incremental. `resources/*`, `prompts/*`, elicitation, and sampling are not implemented, and the
advertised capabilities say so.

### The catalogue

Tools are aggregated **transparently**: the model sees `linear__create_issue`, not a `call_mcp_tool`
meta tool, because a model calls a tool whose schema it can read far more reliably than one it must
discover through another call first.

- A mount contributes only when it is `enabled`, its authorization is `active`, and its probe
  `succeeded`. A disabled mount is silent (disabling is deliberate); the other two are reported in
  `instructions`, because "my tool vanished" is otherwise indistinguishable between a revoked
  credential and a Server that stopped answering.
- Names are `<serverName>__<toolName>`. Past 128 bytes the tool half is shortened and a digest of the
  whole pair is appended, so two long names sharing a prefix stay distinct.
- Composition is a pure function, so the gateway stores no name map: it resolves a call by
  recomputing composed names over that Agent's own snapshots. Splitting on the separator would be
  wrong twice — an upstream name may contain it, and a shortened name does not contain its tool half
  — and recomputation also makes the resolution set exactly what this Agent may call.
- A name two mounts both produce is published by neither, and the collision is stated. A missing tool
  with a reason beats a tool that silently calls the wrong Server.
- The catalogue is served from the stored probe snapshots rather than fanned out live. `tools/list`
  runs at the start of every turn; a live fan-out would add a round trip per Server to each one and
  contend for the same four outbound slots a real tool call needs.

### Failures

An upstream failure — unreachable, unauthorized, or a tool that errored — comes back as a `tools/call`
result carrying `isError`, not as a JSON-RPC error. A model reads and recovers from the first; the
second ends its turn. Only gateway-level failures (a bad token, a dead execution, malformed JSON-RPC)
are transport errors.

### What the gateway does not add

No new database table, and therefore no migration: the token store is in memory. No user-visible API
key and no management surface — the credential is issued automatically per execution and never shown.
Every outbound request goes through the same `McpOutboundFetcher` a probe uses, so the SSRF gate, the
redirect refusal, and response bound all apply unchanged to a runtime call — those are properties of
the fetcher class.

What a runtime call does **not** share is the probe's *budget*. It uses its own fetcher instance,
which means its own deadline and its own per-Account concurrency counter. A probe is a bounded read
on the Server's own schedule; a tool call runs as long as the tool does — a search, a database
query, code execution, a browser action — and ten seconds turned all of those into a generic failure
the model could not act on. Separating the counters also stops a background probe or a token refresh
from exhausting the slots a live turn needs, which matters because Claude Code issues tool calls in
parallel.

**A failed tool call is never replayed.** The probe retries freely because `server/discover` and
`tools/list` are reads; a `tools/call` is not, and replaying one can file the same issue twice while
the gateway reports only the second. A retry happens only for JSON-RPC `-32022
UnsupportedProtocolVersion`, which a Server emits while rejecting the envelope and which therefore
proves nothing ran. Every other failure — a 5xx, a JSON-RPC error carrying the tool's own complaint,
a `-32601` that may have come from inside the tool, a `400`/`404` whose body is not a recognized
modern error — propagates. A wrong cached era costs one failed call, and re-probing is what corrects
it; the runtime path never re-detects an era on its own.

## HTTP API

Server definitions and the aggregate view are Account-scoped; every mount, override, authorization,
and probe is addressed under the Agent that owns it. That is not cosmetic: authorization is strictly
per Agent, so a Server-scoped authorization route would have no way to say whose credential it was
writing.

```
GET    /api/v1/mcp-servers
POST   /api/v1/mcp-servers
GET    /api/v1/mcp-servers/:mcpServerId                  detail, including the agents[] matrix
PATCH  /api/v1/mcp-servers/:mcpServerId                  shared definition, with expectedRevision
DELETE /api/v1/mcp-servers/:mcpServerId                  refused while any Agent mounts it

GET    /api/v1/agents/:agentId/mcp-servers
GET    /api/v1/agents/:agentId/mcp-servers/available     Servers this Agent has not mounted
POST   /api/v1/agents/:agentId/mcp-servers               mount
PATCH  /api/v1/agents/:agentId/mcp-servers/:mcpServerId  enable/disable and this Agent's overrides
DELETE /api/v1/agents/:agentId/mcp-servers/:mcpServerId  unmount (drops this Agent's credential)
PUT    /api/v1/agents/:agentId/mcp-servers/:mcpServerId/authorization        Bearer key, or `none`
DELETE /api/v1/agents/:agentId/mcp-servers/:mcpServerId/authorization        revoke
POST   /api/v1/agents/:agentId/mcp-servers/:mcpServerId/authorization/oauth  start OAuth
POST   /api/v1/agents/:agentId/mcp-servers/:mcpServerId/probe                re-probe

GET    /api/v1/mcp-servers/oauth/callback                unauthenticated; the state hash plus the flow cookie authenticate it
GET    /oauth/client-metadata.json                       unauthenticated; this deployment's CIMD document
```

The authorization DELETE accepts an optional `{ expectedOAuthState }` body to cancel one OAuth
attempt. A matching flow with an existing credential keeps that credential, its status, audience,
and snapshot; only the flow fields are cleared. Without a credential, cancellation revokes the
provisional authorization. A mismatched or completed attempt returns `MCP_OAUTH_FLOW_INVALID`.
The request without a body remains an explicit credential revocation. Cancelling a replacement flow
with an active credential also schedules a tool probe, so the UI does not wait for the background scan.

`GET /api/v1/mcp-servers` returns, per row: `boundAgentCount`, `authorizedAgentCount`,
`lastProbedAt`, `defaultAuthKind`, `authHeader`, `authScheme`. Both counts exclude deleted Agents.
`authorizedAgentCount` counts only `status='active'` rows, because the number answers "how many
Agents can use this right now" and a revoked or expired row is not authorization. `lastProbedAt` is
the maximum `probed_at` over every row, since it records when a probe happened rather than whether
the credential still works.

`GET /api/v1/mcp-servers/:mcpServerId` adds `agents[]`, each with `agentId`, `enabled`,
`authorization.kind`, `authorization.status`, `probeState`, `toolsCount`, `probeError`,
`accessTokenExpiresAt`, and that Server's `protocolEra` / `protocolVersion`.

`PATCH /api/v1/agents/:agentId/mcp-servers/:mcpServerId` uses the same three-state contract on every
field: omitted leaves it alone, a value writes an override, and the matching `clearX` flag restores
inheritance. `extraHeaders` has one extra action, `emptyExtraHeaders`, which writes `{}`.

## CLI

```
mcp add --name --url [--default-auth oauth|bearer|none]
        [--auth-header <name>] [--auth-scheme <scheme>] [--extra-header <name=value> …] [--json]
mcp list
mcp show <server> [--agent <id>] [--json]
mcp update <server> […] [--clear-extra-headers | --empty-extra-headers] [--expected-revision N]
mcp remove <server>
mcp use <server> --agent <id> [--kind bearer|none] (--bearer-key-stdin | --bearer-key <value> | prompt)
mcp authorize <server> --agent <id> [--kind oauth|none] [--scopes a,b] [--no-wait]
mcp revoke <server> --agent <id>
mcp probe <server> --agent <id>

agent mcp list <agent>
agent mcp attach <agent> <server> [--disabled]
agent mcp detach <agent> <server>
agent mcp enable <agent> <server>
agent mcp disable <agent> <server>
agent mcp config <agent> <server> [--url <url>] [--auth-header <name>] [--auth-scheme <scheme>]
                                  [--extra-header <name=value> …] [--clear-url] [--clear-auth-header]
                                  [--clear-auth-scheme] [--clear-extra-headers | --empty-extra-headers]
```

`mcp update` has **no** `--enable` / `--disable`: the definition has no switch, because enabling
happens per Agent.

`--bearer-key` is retained for scripted use but its help text calls it **UNSAFE**, because a command
line argument is readable by every other process on the machine and lands in the shell's history
file. `--bearer-key-stdin` is the documented path, and a non-interactive terminal with neither flag
reads a hidden prompt.

`mcp authorize` prints the URL — to **stderr**, the moment it is issued, so `--json` still emits one
JSON document on stdout — and then, by default, polls every 2 seconds until the row is authorized and
probed, timing out at the flow's own 10-minute lifetime so it never waits on a state the Server has
already discarded. `--no-wait` returns as soon as the URL is issued. The printed URL is what makes
the default usable: the wait can last ten minutes, and nothing else the user sees ends it.

An OAuth authorization completes out of band, so the row's `probe_state` is what ends the poll. The
callback fires the probe without awaiting it, so a flow started from the browser converges too.

## Web UI

The product navigation and page title use **Connectors** (Chinese: **连接器**). A connector
provides tools to an Agent; messaging channels let a user communicate with the Agent. The current
connectors use MCP. Protocol labels, endpoint instructions, configuration import formats, CLI
commands, API paths, schema names, and the `/agents/{agentId}/mcp` page URL retain their MCP names.

The page shows one Agent's installed connectors. The entire left side of each row opens Details,
including the icon, name, description, and surrounding space. It uses the same hover and keyboard
focus feedback as Skills, without an arrow beside the name. A compact trash icon button is always
visible on the right and operates independently.
It uses the same compact ghost-button recipe as the Skill list: a 16px neutral gray trash icon,
the shared neutral hover background, danger-colored hover/focus feedback, and the shared keyboard
focus outline. It has a localized
**Remove from this Agent** tooltip.
Its accessible name includes the connector name; the existing confirmation dialog guards removal.
Cancel is initially focused and returns focus to the removal trigger. After removal, focus moves to
the next available removal control, the preceding one if needed, or the named Connectors page when
none remains. Busy or removed controls are skipped.
There is no enable switch or redundant
Details menu. Adding a connector mounts it enabled; completing any required authorization and
successful tool discovery makes it usable without another enable action.

A normal row shows the connector description. When attention is needed, a short known reason replaces
the description and one contextual text action appears before the trash icon: **Authorize**,
**Reauthorize**, **Update credentials**, or **Retry**. OAuth and tool retries run directly; credential
entry opens the existing management dialog. Each recovery button's accessible name includes the
connector name. Recovery actions are disabled while another browser connection attempt is active,
so an unavailable action cannot silently drop a click. An unauthenticated connector shows **Authorization
required**. The identity remains the single entry for full settings. Successful tool snapshots have
no aggregate Connected badge, success dot, or tool count.
A completed snapshot remains quiet while its background replacement is pending; first-time loading,
explicit Retry, and confirmed failures still show feedback. An existing disabled mount shows
**Disabled** in the description position and a compact **Resume** text button beside Remove. Resume
uses the existing binding update with `enabled: true`, preserves configuration and authorization, and
returns keyboard focus to the identity after its button disappears. Failures remain inline and
retryable; successful resumption exposes the actual authorization or probe feedback rather than
assuming usability. Web does not offer another disable action. The database field, Server API, and
CLI enable/disable commands remain supported, so disabled mounts created outside Web stay visible.
During an actual authorization or initial connection check, the description position shows
**Waiting for authorization…** or **Checking connection…**. The right side contains only the disabled
trash button for the browser-owned attempt; recovery actions return after failure. A saved pending
background probe still shows checking feedback but leaves Remove available, so a delayed worker
cannot lock the user out of removing the connector. Blocked authorization is explained in the row,
with the existing Open window and Cancel controls inside management. A pending authorization record
without a live browser session does not imply an ongoing flow. On narrow content widths, rows
with a recovery action place that action and the trash icon together below the identity, aligned
to the right. This preserves readable names and reasons in both languages; rows with only the
trash icon retain the two-column layout.

Removing requires confirmation and removes this Agent's installation and credential; an unused
definition is also removed, while a definition still used elsewhere is kept. This does not promise
revocation of the provider's own authorization grant.

Preset Details places **Authentication** above the visible, copyable **Connector address**. A
single supported authentication method is plain text; multiple configured methods use the shared
Select. OAuth offers **Authorize** or **Reauthorize**. A saved API key or token is masked and offers
**Update**; editing exposes local **Save** and **Cancel** actions. A method selection remains a draft
until submission. There is no tool browser, credential-clearing action, advanced configuration, delete
action, or global save footer in preset Details. Custom Details retains editable connection settings
and collapsed Advanced settings.

Authentication feedback sits directly below its controls. **Retry** and **Open window** follow the
reason and wrap together on narrow screens. Controls keep their positions while authorization,
key editing, saving, and recovery feedback change. Primary form actions use the shared default
control size; supporting text actions use the compact size, with the shared mobile touch targets.
The method selector and key field share an input column, with actions aligned to the right in a
reserved column. On narrow screens both fields fill the dialog and actions move below them.
Closing Add custom, Details, or Discover does not cancel an ongoing OAuth attempt. All views expose the same
attempt, prevent duplicate authorization for that connector, and provide explicit cancellation.
Custom setup shares the page-owned OAuth session and reports connection work until the original
request settles, including when its form has closed. Adding/configuration failures remain distinct
from authorization failures; tool-read failures retain the existing credentials and offer Retry.
Input stays in the custom form after a failed addition and its submit action becomes Retry.
A successful recovery clears earlier local failure feedback. OAuth completion refreshes the saved
Agent data immediately; a failed tool probe keeps the credential and offers **Retry**.
If Retry needs OAuth, it uses the same connector session as Details so blocked-window recovery,
cancellation, and closing/reopening the dialog remain available. A failed key or anonymous-method
save remains a local form error; it does not turn into a tool-probe failure on the list.

### Adding a Connector

The Connectors page keeps its existing layout and actions. **Discover** opens the service directory;
**Add custom** opens a compact **Add custom connector** dialog. The Chinese entry labels are
**发现** and **自定义**, and the custom dialog title is **添加自定义连接器**. The custom dialog contains:
An input with localized URL guidance and **Connect**, with dismissal through the header close button
or Escape. **Connector URL** remains its screen-reader label; opening focuses the input. There is
no source switch, name field, authentication picker, or header editor in this entry flow. Discover,
manual configuration, and configuration import remain implementation capabilities rather than entry
points in this dialog.

Web installations are independent per Agent. Add custom offers only a URL; it neither lists the
Account's definitions nor selects one by URL. Discover creates a new definition from the served
catalog defaults when this Agent has no installation. Existing installations of this Agent remain
available for connection, retry, and management, including URL overrides and every known endpoint
of a deployment-replaced catalog entry.

Names are generated automatically from an exact preset or the URL's host. Creation tries the base
name first; only `MCP_SERVER_NAME_CONFLICT` reads the Account's names and retries with a bounded,
case-insensitive numeric suffix. A matching URL never selects another definition. Both add entry
points share this operation. Confirmed definitions are retained within the current journey for
attachment and authorization retries. Account definitions do not gate the ordinary Add button or
first-use dialog. Reads of overridden definitions and OAuth return state are limited to this Agent's
installations and the explicitly returned ID.

Complete HTTP(S) endpoint URLs are required; only outer whitespace is trimmed, and configuration
snippets, commands, multiple addresses, userinfo, and fragments are refused. Entering an already
installed endpoint locates the current Agent's connection instead of creating another one. The
backend registry and shared configuration semantics remain available through the API and CLI;
this Web change does not migrate historical shared mounts or change OAuth client registration reuse.

Connect uses the existing create, attach, authorization, OAuth, and probe APIs.
Exact preset matches provide new-installation authentication defaults; Bearer defaults reveal an API-key field
only after Connect, and OAuth defaults start provider sign-in directly. An unknown endpoint starts
with an anonymous probe; an explicit authentication rejection permits an OAuth attempt through the
existing discovery flow. The transport retains the shared `MCP_AUTH_REJECTION_SUMMARY` in probe errors,
prefixed by `MCP_UPSTREAM_ERROR`; Add matches that contract to distinguish HTTP 401/403 rejections
from other failures. It never infers an API key from a rejection. Tool failures and empty tool
sets keep the dialog open with concise feedback. Retries retain confirmed definitions and bindings,
while switching addresses discards that attempt. OAuth stores only Agent/Server identifiers and the
return view; cancellation restores this same dialog against its existing binding. Credentials remain
strictly per Agent.

The dialog is 440px wide and bounded by the viewport with 16px margins. URL-only entry uses 216px;
API-key entry uses 304px on desktop and 320px at widths up to 600px. The opening top anchor stays
fixed when key collection expands downward. Feedback is reserved below the URL or key, and loading
and errors retain the current step's geometry. The body scrolls within the viewport while the
footer remains visible. Steps animate over 160ms with reduced-motion support.

The list, Settings, Authentication, Tools, removal copy, and accessible names use one display-title
function. A known catalog endpoint with its preset name or a numeric installation suffix displays
the localized catalog title. Custom names remain verbatim. No display-name field is stored; IDs,
raw names, and gateway tool namespaces retain their existing semantics. Removing or cancelling a
new installation still detaches its mount; an unmounted definition remains in the backend registry
but is not offered as a Web installation source.

### Importing a Server from another client's configuration

The retained configuration-import readers accept a configuration instead of a URL. This capability
has no entry point in the current Add server dialog. The readers support the
shapes other clients write: OpenCode's `mcp` map with `"type": "remote"`, the `mcpServers` map of the
Claude-family clients, VS Code's `servers` map with `"type": "http"` or `"sse"`, the TOML
`[mcp_servers.<name>]` tables other clients use, the YAML spelling of any of those, and the
`claude mcp add <name> --transport http <url>` / `codex mcp add <name> --url <url>` command lines.
JSON carrying `//` comments and trailing commas is accepted, because the configs this targets
routinely carry both.

Parsing happens in the browser, never on the Server: a paste may carry a live credential, and the
text itself is not sent anywhere. Only the values the user confirms travel, through the same
create → attach → authorize sequence used by the connection flow.

- **Only remote Servers are importable.** `stdio`, `local`, `command`, and `npx` entries are listed
  by name and reported as a category openTag does not support. An entry that declares a `command` is
  local even when its arguments contain an HTTPS URL (`npx -y mcp-remote https://…`): reading that as
  remote would create a definition the gateway could never reach.
- **A paste that holds several Servers lists all of them** and imports exactly one per confirmation.
  A listed Server this Agent already mounts is shown as added, with a link to it instead of an import.
- **Names are normalized** to this product's rules — lowercase, hyphens, the 64-character bound — and
  de-duplicated against the Account, and remain editable before confirmation.
- **A credential goes to this Agent alone.** An `Authorization: <scheme> <token>` header, or a
  credential-shaped header, prefills this Agent's bearer authorization; it is never written to the
  shared definition and never echoed into an error or a log. "Credential-shaped" is the repository's
  own credential-name vocabulary — `authorization`, `cookie`, `token`, `secret`, `credential`,
  `password`, `passwd`, `api-key`/`apikey`, and the bearer/access/refresh/private key names, in any
  separator convention and with an optional vendor prefix — so a name the product already redacts in a
  log cannot become shared configuration just because a paste spelled it `X-Client-Secret` or
  `X-PrivateKey`. HTTP header names are case-insensitive, so classification matches the separatorless
  spelling too and does not depend on whether the paste preserved camel case. The `Authorization`
  header is taken when the paste declares one; otherwise the first credential-shaped header is, and
  every other one is refused by name. `observability/sensitive-names.test.ts` reads the shared array
  out of `packages/shared/src/structured-errors.ts`, so a term added there fails the test until it is
  mirrored or listed as structural-only. The predicate differs from the redactor deliberately in both
  directions, and the invariant both preserve is that a name the redactor treats as a credential is
  never shared:

  - **Narrower** for the structural names (`payload`, `body`, `prompt`, …): the redactor hides them,
    this importer shares them as ordinary configuration, because they are sensitive to log but are not
    credentials and refusing a header named for one would drop configuration a Server may need.
  - **Wider** for the separatorless lowercase spellings a paste may produce (lowercase `x-privatekey`),
    which the redactor's key matching does not fold; refusing those is the conservative outcome.
- **Every other header becomes an extra header** of the definition, read from `headers` or from
  Codex's `http_headers`, in either dialect's object, array, inline-table, or nested-table spelling.
  The shared schema's count and size bounds are enforced against the accumulated set rather than one
  header at a time, so a header that would cross them is refused by name here instead of leaving a
  disabled submit two steps later. `env_http_headers` names an environment variable rather than a
  value, so those names are refused and never imported: they do not become a shared header with an
  empty value, a literal header of the same name is not sent either, and a name declared that way is
  not eligible to become the Agent credential, because the declaration carries no value to save.
- **A rejected URL keeps no credential.** A URL carrying userinfo is refused, and the copy that is
  shown and returned has the userinfo removed, rather than putting it in a row or in the result the
  caller holds.
- **The listed Servers describe the text that produced them.** Editing the field clears the list and
  invalidates any read still running, so the previous Server — and the previous credential — cannot be
  confirmed against text the user has since changed.

## The marketplace catalog

An Agent with no Server mounted has an empty tool surface and no way in unless its user already knows
an endpoint. The marketplace catalog closes that gap: a curated set of remote Streamable HTTP Servers
that an Agent can add from the independent **Discover** directory. The same catalog is served to
third-party MCP clients by the [public MCP catalog endpoint](public-mcp-catalog.md).
The page keeps one **Add custom** action in its header alongside the independent directory action.
Add custom opens the custom connector form for empty and populated Agents alike; it has no
Discover, manual-configuration, or import source switch. Initial focus stays on the dialog title,
leaving the address field idle until the user selects it. Dismissing the form returns focus to Add custom.
The standalone directory owns its add state.
The empty state matches Skills: a centered 32px connection icon, the heading **No connectors yet**,
and concise guidance directly on the page background. Connector choices stay in Discover; there are
no recommendation cards, example tasks, or duplicate browse actions on the management page.
Asana's V2 MCP server requires a pre-registered OAuth application; Linear and Airtable support dynamic registration.
See [Asana's integration requirements](https://developers.asana.com/docs/integrating-with-asanas-mcp-server),
[Linear's MCP setup](https://linear.app/docs/mcp), and
[Airtable's authentication guide](https://airtable.com/developers/agents/mcp/getting-started).
Google Workspace cards are labeled **Limited access** and show preview-access and OAuth
setup requirements before adding the service. All available cards use **Add**. Once mounted, a card
shows a single non-interactive **✓ Added** status in the action position, regardless of authorization or probe status. Authentication methods and
connection health belong to service setup and the Agent's management list, not catalog
cards. The directory is not a popularity ranking.

Directory cards place the service name and description on the left, with **Add** or **Added** on the
right rather than in a separate footer row. Limited-access labels sit beside the service name.
On narrow screens, descriptions span the card width.

Adding creates this Agent's independent definition and mounts it to this Agent. The directory closes as
soon as the mount is confirmed, and the management list highlights the service without waiting for
authorization or tools. OAuth services immediately navigate to the provider without another confirmation.
Bearer services open the shared authentication dialog with the known method fixed and no connection
settings; saving credentials closes it. Closing authentication leaves the mount on the list with
**Not connected** and **Connect**. Anonymous mounts already authorized by the server trigger an
immediate tool probe on the page; they do not wait for the periodic background worker or rewrite
their authorization.

Pending tool probes poll every second for their first 30 seconds, then return to the ordinary
30-second live cadence. The budget follows each mount in its query cache and uses elapsed time,
so failed reads cannot leave a page polling every second indefinitely. Newly pending mounts
receive their own fast-poll window; settled or disabled mounts stop using it.

Create and attach errors remain in the directory, preserving its search and category. Confirmed
definitions are retained for retries. After mounting, connection startup errors and probe retries
belong to the existing list; credential errors remain in the shared authentication form. There is no
separate setup, connection-progress, or connection-result view. OAuth uses the existing return context
handling, including authentication errors returned by the provider. Adding and authorizing a
connector have no separate success or failure notification. Connection status remains on the card;
failures remain on the corresponding card or connection form with a retry action. An OAuth error
without a corresponding card remains an inline page error. There is no success panel or
messaging-channel guidance above the connector list.

The catalog aligns rows to the top of its bounded scroll area. Minimum list height leaves space
below the cards instead of stretching a lone row. The directory omits the redundant Agent
authorization footer.

Category navigation starts with **All**, then follows the catalog's fixed order:
Docs & Knowledge, Communication, Projects, Developer Tools, Web Search, Data & Analytics,
and Design. Categories with fewer than two offered entries are omitted from navigation;
their entries remain available in All and search. Other catalog categories follow these groups.
Desktop filters stay on one line and move a trailing suffix into **More** according to the
available container width. More retains the same order and marks the selected item. Selecting
an overflow category replaces the trigger's label with that category's name without reordering
or moving the direct choices. The trigger reserves label space, and the visible prefix is
recalculated after resizing or font loading. Choosing a menu item closes More. Becoming busy
also closes it; finishing the action never reopens the menu without user input. Search spans the
full directory and clears the category highlight; choosing a category clears search. Mobile uses
the shared Kumo Select with the same order and selection. Buttons and the More trigger use the shared neutral-grey filter
selection recipe, preserving the application's typography, control size, and focus behavior.

The current management layout is preserved: service identity opens settings, the list shows connection
status and Connect/Reconnect, and tools and advanced connection settings are reached from settings.
The identity subtitle uses the matched catalog entry's localized purpose description. Custom connectors
use their user-supplied description, with the effective URL as the fallback when the description is blank.
Subtitles stay on one line with truncation and a full-text tooltip; the complete URL remains in settings.
An empty tool result is inspected in the existing tool browser. Authentication preserves the binding's
effective settings and extra-header inheritance; catalog scopes are supplied only for its exact endpoint.
Existing installations retain their chosen authentication kind. Catalog defaults apply to newly
created definitions; other Agents' configuration and headers are never used to prefill them.

The catalog is committed repository data in the `@opentag/mcp-presets` workspace, not a service:

| Source | Holds |
| --- | --- |
| `packages/mcp-presets/mcp-categories.yaml` | the category set: id, a localized label, and the navigation order |
| `packages/mcp-presets/mcp-catalog.yaml` | the entries, one registry-style record each: `id` (`mcp/<slug>`), localized `name`, `summary`, and `when_to_use`, `capabilities`, `status`, `auth` (`methods`, `default_kind`, and `oauth.scopes` — the scopes the provider's consent screen is configured for), `risk`, `remotes` endpoints with their header configuration and/or self-hosted `packages` (with `prerequisites` and `platforms`), `catalog` placement (category, order, icon), and `homepage` |
| `packages/mcp-presets/schema/mcp-catalog-entry.schema.json` | the JSON Schema (draft 2020-12) every entry is validated against; the generator injects the supported locales |
| `packages/mcp-presets/icons/` | the monochrome card marks referenced by the entries |

`scripts/generate-mcp-catalog.mjs` compiles the sources into
`packages/mcp-presets/src/mcp-catalog.gen.ts`, embedding each icon as a data URL so the compiled
module carries no asset imports. It mirrors `generate-web-theme.mjs`: run `pnpm catalog:generate` to
write it, and `pnpm check` runs the same script with `--check` to reject drift. It runs under `tsx`
because it reads the shared runtime schemas from source — `pnpm check` runs before `pnpm build`, so
`packages/shared/dist` does not exist yet. The Web App reads the catalog through the package's public
export; no catalog source lives under `apps/web`.

The procedure an operator follows to add an entry — the facts to collect from the provider, the slug
and category rules, the icon, and the gates to run — is a first-party Skill at
`skills/mcp-catalog-entry`. It is a contributor bundle rather than a shipped preset: an operator
uploads it explicitly, and the Presets catalog never offers it.

The current Add server flow uses an exact catalog endpoint match to supply authentication defaults
and a suggested name. Each Web installation creates its own definition; the Account registry is consulted only to resolve
a creation-name conflict.
`auth.default_kind` remains a prefill for the new authorization, never a statement about the Server.

An entry's `auth.oauth.scopes`, when present, travel as the OAuth start request's explicit scopes, so the
provider's consent screen is asked for exactly the scopes the catalog author recorded. An entry that
declares none leaves scope selection to the flow's own discovery rules. The Add server flow consults
scopes only for an exact endpoint match. Google's entries
carry Google's recommended per-product subsets, which deliberately exclude restricted scopes such as
`https://mail.google.com/`.

An entry may also configure `auth.bearer` with `url`, `auth_header`, and `auth_scheme` when
`auth.methods` includes `bearer`. The generator validates these settings against the shared create
and outbound URL contracts and emits the flat `keyAuth` field for the Details authentication switch.
An empty scheme sends the key without a prefix. The catalog contains connection settings only;
users enter their credentials in Details.

A provider may be listed only when credentials-free discovery of its published endpoint succeeds
under the identity rules above. Three entries exist because of that path: **Atlassian**,
**Airtable**, and **Amplitude** publish a resource identity that is not their transport URL, and
their endpoints are recorded exactly as published — Atlassian keeps `?tools=all`, the parameter its
documentation recommends for a complete, paginated tool list. Amplitude's entry also records a
known limitation: its authorization server advertises `client_secret_post` and `none`, not the
`client_secret_basic` the dynamic-registration path presents, so its authorization stays unverified
until token-endpoint authentication-method support exists (issue #814 tracks the follow-up).

Discover lists only `active` entries. A `deprecated` or `archived` entry is compiled but hidden, and
a `removed` entry is not emitted. Discover search also matches an entry's `keywords`, `aliases`,
`tags`, `capabilities`, and `when_to_use` text. The compiled module keeps the flat card fields the
Web App reads (`id` as the slug, `title`, `description`, `url`, `defaultAuthKind`, `oauthScopes`,
`category`, `website`, `iconUrl`, `order`) as values derived from the registry fields, and adds
`registryId`, `whenToUse`, `capabilities`, `status`, `risk`, and `auth`.

The generator refuses, at build time, at minimum:

- an entry that does not validate against the entry schema: an unknown key, a non-HTTPS remote, an
  unknown package registry type, an unknown `status`, a missing locale, or neither `packages` nor
  `remotes`;
- a package whose named argument has no name, whose secret carries a value or default, whose
  credential-looking variable is not marked secret, or whose value looks like a credential;
- an `auth.default_kind` that is not in `auth.methods`, or an `oauth` method without an `auth.oauth`
  block (and the reverse);
- a `risk.side_effects` weaker than the strongest tool side effect, or a duplicate tool name;
- an entry URL the outbound policy would refuse;
- a create payload the Server would reject — the entry is validated by `CreateMCPServerRequestSchema`
  itself, so its name, auth header and scheme, and extra headers follow the same rules the Server
  enforces;
- an entry that names a category the category source does not declare;
- a declared category that no entry references, so the tab bar never shows a tab that leads nowhere;
- a duplicate entry or category id;
- an `auth.oauth.scopes` list that is empty, carries a blank or oversized scope, or exceeds the
  start request's bounds;
- a localized field that omits any supported locale, taken from the i18n project settings;
- an entry whose referenced icon file does not exist;
- a compiled module that does not match its sources.

Only a Server with a remote Streamable HTTP endpoint is **installable**. An entry may also record
self-hosted `packages` (stdio and similar) as catalog data: the deployment has sandboxes, but the
Server create contract and runtime do not run packages yet, so such an entry is emitted with
`installable: false`, carries no flat connection fields, is withheld from Discover and URL matching,
and is exposed read-only in the public catalog (with package values and defaults omitted). An SSE
remote is data only as well. This document's Server-create contract is unchanged.

**Staleness is not asserted by `pnpm check`.** Whether a listed endpoint still answers, and whether its
authorization method is still what the catalog says, cannot be decided without the public network, and
unit tests must not depend on it. That review belongs to the integration/live-smoke path or a manual
pass; the catalog author confirms each entry's method.

The pure outbound URL rules the catalog is validated against live in
`packages/shared/src/mcp-outbound-url.ts`, so this build-time check and the Server's gate cannot
drift: `packages/server/src/services/mcp/mcp-url-policy.ts` maps the shared verdict onto
`McpServiceError`, and the condition that a hostname *resolves* to a private address remains a
request-time decision in the Server's fetcher.

### Copy ownership in the catalog

The catalog's copy is data-driven: category labels and card text are localized inline in the catalog
sources, and the generator requires every locale, so a card never falls back silently. That is a
deliberate exception to the rule that user-facing copy goes through Paraglide. The Discover surface's
own chrome — the source label, the search field, the method labels, and the installed states — stays
in `messages/mcp/{en,zh}.json`. `web-ui-contract.md` records the same exception from the web side, so
the catalog's copy is not "fixed" into the message catalog as an apparent omission.

Card descriptions use an action and its object, in one short sentence. Prefer one or two core
actions over feature lists, jargon, promotional claims, or changing app counts. Aim for no more
than 45 characters in English and 20 in Chinese, including punctuation; these are editorial
budgets, not rendering limits. Allow natural wrapping on narrow screens without truncating the
meaning. Review both locales in Discover. Descriptions summarize documented MCP
capabilities within the preset's configured scopes; they do not promise every feature of the
provider's product or establish successful openTag authorization.

The description review on 2026-10-10 used the following provider documentation. These references
record provenance for maintainers without adding links or explanatory copy to the cards.

| Entries | Official capability reference |
| --- | --- |
| Notion | [Notion MCP](https://www.notion.com/help/notion-mcp) |
| Exa | [Exa MCP tools](https://exa.ai/docs/get-started/exa-mcp) |
| Linear | [Linear MCP server](https://linear.app/docs/mcp) |
| Sentry | [Sentry MCP server](https://mcp.sentry.dev/) |
| Atlassian | [Atlassian Rovo MCP server](https://support.atlassian.com/atlassian-ai-gateway/docs/use-atlassian-rovo-mcp-server/) |
| Gmail | [Gmail MCP server](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server) |
| Google Drive | [Drive MCP server](https://developers.google.com/workspace/drive/api/guides/configure-mcp-server) |
| Google Docs | [Docs MCP server](https://developers.google.com/workspace/docs/api/guides/configure-mcp-server) |
| Google Sheets | [Sheets MCP server](https://developers.google.com/workspace/sheets/api/guides/configure-mcp-server) |
| Google Slides | [Slides MCP server](https://developers.google.com/workspace/slides/api/guides/configure-mcp-server) |
| Google Calendar | [Calendar MCP server](https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server); the preset requests read and free/busy scopes, so copy describes viewing events and availability |
| Google Chat | [Chat MCP server](https://developers.google.com/workspace/chat/api/guides/configure-mcp-server) |
| People | [Workspace MCP tool reference](https://developers.google.com/workspace/guides/configure-mcp-servers) |
| Microsoft 365 | [Release Communications MCP server](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/mrc-mcp?view=o365-worldwide); this endpoint exposes roadmap and Azure update information |
| Asana | [Asana MCP tools](https://developers.asana.com/docs/mcp-tools-reference) |
| monday.com | [Platform MCP tools](https://developer.monday.com/api-reference/docs/platform-mcp-tools) |
| HubSpot | [Remote HubSpot MCP server](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server) |
| Figma | [Figma MCP tools](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) |
| Canva | [Canva MCP tools](https://www.canva.dev/docs/apps/mcp/tools/) |
| Tavily | [Tavily MCP server](https://docs.tavily.com/documentation/mcp) |
| Firecrawl | [Firecrawl MCP server](https://docs.firecrawl.dev/mcp-server) |
| Zapier | [Zapier MCP](https://docs.zapier.com/mcp/home) |
| Airtable | [Airtable MCP server](https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server) |
| Supabase | [Supabase MCP tools](https://supabase.com/docs/guides/ai-tools/mcp) |
| Amplitude | [Amplitude MCP server](https://amplitude.com/docs/amplitude-ai/amplitude-mcp) |
| Stripe | [Stripe MCP tools](https://docs.stripe.com/mcp) |
