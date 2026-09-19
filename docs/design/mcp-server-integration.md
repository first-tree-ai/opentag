# MCP Server integration

> **Status: the management plane is delivered; runtime delivery is delivered for Claude Code on a
> local Computer.**
>
> The management plane provides MCP (Model Context Protocol) Server definitions, per-Agent bindings
> with per-Agent overrides, per-Agent authorization (anonymous / Bearer / OAuth), capability probing,
> and background token maintenance, in the Server API, the Web UI, and the CLI.
>
> Runtime delivery is [the MCP gateway](#the-mcp-gateway): one inbound Streamable HTTP endpoint on
> the OpenTag Server that an Agent's provider CLI mounts like any other remote MCP Server. **No
> upstream credential is ever delivered to a Provider** — the gateway resolves the Agent's own
> authorization row and calls upstream itself.
>
> Not yet covered: **Codex** (its app-server is spawned once per Session runtime from a frozen
> argument vector, so a per-execution bearer cannot be injected into it) and the **Cloud sandbox**
> (its Turn worker runs Pi only; neither Claude Code nor Codex runs there at all). **Pi** has no MCP
> configuration surface and is out of scope.
>
> An earlier revision of this page proposed a different path — push credentials down to the Client
> and inject the real authorization header through a local `127.0.0.1` loopback proxy. The gateway
> replaces it, and inverts the trust: the Client holds only a token that is worthless outside one
> live execution, and every upstream secret stays behind the outbound URL policy, the per-Account
> concurrency budget, and the response bounds already described below.

## What this feature is for

An Agent's usefulness is bounded by the tools it can reach. MCP is the emerging standard for
exposing those tools, so OpenTag needs to be able to register an MCP Server once per Account,
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
  authorization_server, client_registration_id,
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

"Restore inheritance" and "override with nothing" are therefore separate actions in both surfaces
(`--clear-extra-headers` versus `--empty-extra-headers`; "use the shared headers" versus "send no
extra headers"). Collapsing them would leave a user unable to drop a shared `x-workspace-id` for one
Agent without deleting it for everyone.

The other three fields need no such distinction, but they do need an **explicit** clear: an empty
string is a legitimate value for `auth_scheme`, so "clear" can never be spelled as an empty value.

Editing scope is a user choice:

| Scope | Writes to | Affects |
| --- | --- | --- |
| This Agent (the default) | `agent_mcp_servers.*_override` | Only this Agent |
| Shared definition | `mcp_servers.*` | Every Agent that mounts it, named in the dialog before the user confirms |

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

## OAuth

### Discovery

```
POST <url>  server/discover  (modern headers + _meta)
  └→ 401 + WWW-Authenticate: Bearer resource_metadata="<PRM URL>"[, scope="..."]
     Use resource_metadata when present. Otherwise fall back to well-known, in this order:
       a. <origin>/.well-known/oauth-protected-resource<endpoint path>
       b. <origin>/.well-known/oauth-protected-resource

Read the Protected Resource Metadata document (RFC 9728)
  → authorization_servers[] (>= 1), scopes_supported[], resource

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
| 1 | Pre-registered | A row exists for `(Account, issuer)` with `source='preregistered'` |
| 2 | Client ID Metadata Document | The AS advertises `client_id_metadata_document_supported` |
| 3 | Dynamic Client Registration | The AS advertises a `registration_endpoint` |
| 4 | — | Otherwise `MCP_REGISTRATION_UNSUPPORTED`, with the hint that a pre-registration is needed |

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

### The authorization round trip

- PKCE `S256`; the verifier is encrypted and the challenge travels.
- **`resource` appears on both the authorization request and the token request**, spelled with a
  lowercase scheme and host and no fragment.
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

**Scopes**, in priority order: the challenge's `scope` is authoritative; otherwise the Protected
Resource Metadata document's `scopes_supported`; otherwise no `scope` parameter at all.
`offline_access` is added only when the *authorization server's* metadata advertises it.

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

- At most 200 tools, and at most 256 KiB for the whole snapshot.
- Per tool: `name` ≤ 128 bytes, `description` ≤ 1024 bytes, `inputSchema` ≤ 8 KiB serialized.
- Each page is validated as a unit. A page that violates a per-tool bound **fails the probe**
  (`probe_state='failed'`) rather than being truncated and reported as success — storing a silently
  mangled schema would be worse than saying the answer was not usable.
- Hitting a cap or running out of budget sets `tools_truncated = true` while `probe_state` stays
  `succeeded`, because the tool list is a snapshot rather than an authoritative whole.
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
`StructuredErrorCategorySchema` set used by [the error taxonomy](./error-taxonomy.md). The two do not
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
Claude Code (spawned per run, local Computer)
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

### What the gateway speaks

Both protocol eras, not one. This deployment speaks `2026-07-28` upstream, but the clients that mount
this endpoint are the provider CLIs, and Claude Code's own in-process bridge still speaks
`2025-03-26`. A modern-only gateway would be unusable by the client it exists for.

| Method | Answer |
| --- | --- |
| `initialize` + `notifications/initialized` | The legacy handshake. An unsupported requested version is answered with one this deployment does speak, never echoed — echoing would strand the session |
| `server/discover` | The modern path: the whole supported set, so the client chooses |
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
four-per-Account concurrency limit, the redirect refusal, and the response bound all apply unchanged
to a runtime call.

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

The page lives at `/agents/{agentId}/mcp`, under the existing shell routes. It shows one Agent's
mounted Servers, and each row displays **four independent states** rather than one merged status:

| Column | Values |
| --- | --- |
| Mount | Enabled / Disabled |
| Authorization method | Bearer / OAuth / Anonymous |
| Authorization status | Authorized / Awaiting authorization / Expired / Reauthorization required / None |
| Discovery | Discovering… / Found N tools / Discovery failed / Not discovered |

They are kept separate because "disabled" and "not authorized" are different problems with different
fixes: a disabled Server keeps its credential and needs no reauthorization, while an unauthorized one
does. A merged column would send a user to reauthorize a Server that was only switched off.

Each row offers the enable/disable switch, authorize / reauthorize / revoke, view tools, re-probe,
edit, and remove.

- **Edit** opens on "this Agent only", which writes the override columns and affects nobody else.
  Choosing "shared definition" shows a warning naming the Agents it will affect — the same set the
  Server counts for `boundAgentCount`. Each field shows its current effective value and whether it is
  inherited or overridden, because a user cannot otherwise tell what the Server is actually being
  sent. `extra_headers` carries both actions: "use the shared headers" and "send no extra headers".
- **Remove** offers "from this Agent only", which leaves the definition in the Account pool, and
  "remove and delete the definition", which is disabled while another Agent still mounts it and names
  that Agent. Without the second option a definition with no mounts could never be reclaimed, since
  there is no Account-level page that lists it.
- **Authorize** chooses the method for this Agent and, for OAuth, navigates the top-level browsing
  context to the authorization server rather than fetching the URL.
- **View tools** shows the tools discovered with *this Agent's* credential, with the era and version
  that produced them, and an explicit notice when the list was truncated.

The "new Server" wizard asks for the definition first and the authorization method second, so
`default_auth_kind` is never presented as a statement about the Server.

## Verification

Unit tests (no network, no database):

| Area | What is asserted |
| --- | --- |
| Transport headers | Every required header; the version in header and `_meta`; the name header only when there is one; the Base64 sentinel boundary in both directions; a legacy call carrying none of the modern envelope |
| Response parsing | JSON, request-scoped SSE with notifications and foreign ids, `202` with no body, JSON-RPC errors that keep their code, a non-2xx JSON body failing rather than reading as an empty result |
| Era detection | A modern error body means retry, not downgrade; a non-modern `404` means downgrade; a generic `-32601` is not a modern signal; only protocol-class failures invalidate a cached era |
| URL policy | Every non-public IPv4 and IPv6 range decided by leading bits (including the 5+-group and IPv4-mapped spellings), a hostname resolving to any private address, the `.localhost` tree and trailing-dot loopback spellings, non-HTTPS, credentials, fragments, redirects refused with no request made, the loopback opt-in, and the concurrency and size bounds |
| Outbound gate | The transport, OAuth, probe, and OAuth-flow modules contain no `fetch(` call, so the gate cannot be bypassed by a later edit |
| Header construction | OAuth always uses `Authorization`; an empty scheme sends verbatim; `none` sends no authorization header; extra headers apply to all three kinds; a collision is refused case-insensitively; the reserved names are refused |
| Header validation | The RFC 9110 token set, CR/LF in a name or value, the count and size bounds, and each reserved name |
| AAD | The literal format; a different Agent, a different authorization server, and the other envelope's domain all fail to open; a kind change is openable because the context never names the kind |
| Discovery | The exact well-known order; a mismatched issuer propagates; multi-issuer ordering; the registration choice in all four cases; CIMD self-naming and same-host redirects; PKCE; `resource` on both requests; the four `iss` rows; scope priority; the refresh lead |
| Probing | Two pages merged into one snapshot on both eras; the cursor sent only on later pages; each per-tool bound failing the page; the cap and the budget both setting `tools_truncated`; SSE discovery; the era paths |

PostgreSQL integration tests (`mcp-management.test.ts`, Docker + testcontainers) drive a loopback
fixture Server that is also its own authorization server:

| Path | What it proves |
| --- | --- |
| P2 — management plane | One Server holds `kind='bearer'` for one Agent and `kind='oauth'` for another; a disable keeps the credential and re-enabling needs no reauthorization; two Agents see different Server sets; the aggregate counts and `lastProbedAt`; an Agent-level override re-probes only that Agent while a shared edit re-probes every mount |
| P3 — OAuth round trip | The flow reaches `active` with the state cleared, the probe reports the modern era and both pages' tools, a restart invalidates the old state, `invalid_grant` revokes, a refresh rotates without re-probing, and a Bearer row is left alone by the refresh pass |
| P3 — flow security | A callback presented by a browser holding no flow secret, or a different one, is refused and stores nothing (session fixation); the callback redeems the code under the registration `start` recorded, leaving exactly one registration per `(Account, issuer)` pair and the row still pointing at it |
| P4 — outbound gate | A challenge naming a link-local document, a Protected Resource Metadata document naming a private issuer, and an AS document naming a private token endpoint are each refused with `MCP_URL_BLOCKED`, and the fixture's request log shows nothing was sent |
| P5 — lifecycle | A soft-deleted Agent drops `boundAgentCount` to 0 so the definition can be deleted; an onboarding reset leaves no mount behind; detaching releases the credential; a client registration survives its Server's deletion |
| Constraints | The one-row-per-pair unique index, the anonymous row created on mount, mounting before authorizing, `MCP_SERVER_IN_USE`, the datastore-level header-name rules, the case-insensitive Server name, and the Account snapshot bound failing one Agent's write without disturbing another's |

One path cannot be verified in this release: **an Agent actually calling an MCP tool.** Runtime
delivery is not implemented, so no test can demonstrate it, and none pretends to. When it is built,
the verification is a real Computer and a real Provider with an Agent that reaches an MCP tool in a
turn.
