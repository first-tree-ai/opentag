# Feishu user MCP authorization proposal

Status: proposed for review; not implemented.
Baseline: `7d82bd48308e76811bf576c493597adc508ecaa2`, 2026-10-22.
Verification plan: [Feishu user MCP authorization](../../verification/feishu-user-mcp-authorization.md).
Related contract: [MCP Server integration](../../../docs/system/capabilities/mcp-server-integration.md).
Issue: [opentag#996](https://github.com/first-tree-ai/opentag/issues/996).

## What is already established

The deployment can already reach the hosted Feishu MCP endpoint with a manually supplied user
access token. The accepted development configuration is:

```text
URL:         https://mcp.feishu.cn/mcp
Auth kind:   bearer
Auth header: X-Lark-MCP-UAT
Prefix:      empty string
Extra header:
X-Lark-MCP-Allowed-Tools:
search-doc,fetch-doc,search-groups,get-messages,get-thread-messages,search-messages
```

Discovery returned those six tools without truncation, and the deployed Server reported
`probeState: succeeded` with `toolsCount: 6`. That proves credential storage, decryption, header
construction, and deployed MCP discovery. It does not prove content access, real Agent execution,
call-time tool rejection, or automatic renewal.

The official hosted-MCP OAuth route was investigated and remains blocked at both dynamic client
registration and account eligibility. The ordinary Feishu application device authorization was
verified with the pinned `lark-cli` implementation, including a real refresh that rotated both
tokens. That is the route this proposal productizes.

## Decision

Build a focused, Server-owned **managed credential source** for the owner's Feishu user grant.
Keep the existing MCP gateway, probing, and per-Agent authorization model. Use the ordinary Feishu
application device authorization flow first.

The credential is represented as a new lifecycle dimension on the existing authorization row, not
as a new wire-level authorization kind:

- `kind` continues to describe what is sent on the wire. The Feishu grant is a bearer token in a
  custom header, so `kind = 'bearer'` is the truthful wire format.
- A new `credential_source` distinguishes a manually supplied bearer key (`manual`) from a
  Server-managed Feishu user grant (`feishu_user`).
- Header construction, the gateway, and per-Agent resolution do not branch on a new kind.

This avoids a new branch in every `kind` decision across the Server, CLI, and Web App while still
making the credential's lifecycle explicit. It also keeps the manually supplied static token path
truthful: it remains `manual`, has no refresh credential, and is never described as renewable.

### Why device authorization first

The device flow was the one route actually completed end to end with a real Feishu account, and it
does not require the Feishu application to register an OpenTag HTTPS callback. The application
credentials and scopes can be validated at deployment time by starting one real flow. An ordinary
application authorization-code flow with an HTTPS callback is a compatible later addition: it would
produce the same token envelope and the same refresh contract, changing only how the grant is
obtained.

Device authorization also keeps the grant acquisition server-owned. The user approves in Feishu;
the Server polls and stores the tokens. No laptop keychain, browser extension, or local CLI is
involved after the approval.

## Provider contract

The contract below is fixed from the pinned official CLI revision
`6646386e0996b1ff5df640bccff834a20bcb203b` and the verified refresh experiment. The implementation
must treat these URLs as provider configuration, never as user input.

| Step | Request |
| --- | --- |
| Device authorization | `POST https://accounts.feishu.cn/oauth/v1/device_authorization`; form body `client_id=<app_id>&scope=<space-separated scopes>`; `Authorization: Basic base64(app_id:app_secret)` |
| Device token poll | `POST https://open.feishu.cn/open-apis/authen/v2/oauth/token`; form body `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=<code>&client_id=<app_id>&client_secret=<app_secret>` |
| Token refresh | Same v2 token URL; JSON body `{"grant_type":"refresh_token","refresh_token":"<token>","client_id":"<app_id>","client_secret":"<app_secret>"}` |
| Identity check | `GET https://open.feishu.cn/open-apis/authen/v1/user_info`; `Authorization: Bearer <access_token>` |

The asymmetry is deliberate and must not be normalized: device authorization uses Basic auth,
device polling uses form credentials, and refresh uses JSON credentials. The pinned CLI and the
verified refresh use those shapes. `/open-apis/authen/v1/oidc/access_token` is a different legacy
OIDC API and is not part of this contract.

The device authorization response carries `device_code`, `user_code`, `verification_uri`,
`verification_uri_complete`, `expires_in`, and `interval`. The v2 token endpoint is shared by
device polling and refresh, but the two grants do not share an error convention: device polling
reports OAuth-style `error` strings (`authorization_pending`, `slow_down`, `access_denied`,
`expired_token`), while refresh reports a numeric `code`. The provider client owns both maps.
The success body carries `access_token`, `refresh_token`, `expires_in` (observed approximately two
hours), `refresh_token_expires_in` (observed approximately seven days), `scope`, and `token_type`.
Refresh failures do not use the OAuth `invalid_grant` / `invalid_client` spelling.

### Token response classification

The provider client owns the code-to-outcome map. The shared refresh custody helper consumes only
the normalized verdict, so the OAuth classifier is not reused unchanged.

| Response | Verdict | Action |
| --- | --- | --- |
| `code = 0` and an `access_token` | Success | Store the rotated envelope |
| `code = 0` but no `access_token` | Unknown | Keep the token, surface renewal failure, no retry |
| `20026`, `20037`, `20064` | Terminal | Refresh token invalid, expired, or revoked; clear and require reconnect |
| `20073` | Terminal | Refresh token already used; clear and require reconnect. This is what a lost rotation looks like |
| `99991543`, `10014` | Config-error | Keep the refresh token; row `error` with `MCP_FEISHU_APP_CREDENTIALS_INVALID`; slow retry; resumes after the deployment secret is fixed |
| `20050` | Retryable-preserve | Keep the refresh token; do not retry in the same pass; the next scheduled refresh pass retries |
| `21000`, `21001` | Policy-stop | Keep the refresh token; surface a bounded security-challenge code; no automatic retry |
| Missing `code`, transport failure, timeout, 5xx, unparseable body | Unknown | Keep the refresh token; `MCP_REFRESH_OUTCOME_UNKNOWN`; no automatic retry |
| Any other numeric code | Unknown | Keep the refresh token; bounded renewal-failure code; no automatic retry |

A retryable-preserve row stays `active` and releases its refresh claim, so the next scheduled pass
can retry. It never retries inside the same pass. Policy-stop and unknown rows become `error`; the
UI treats both as renewal failure and requires the owner to act. A config-error row also becomes
`error`, but a client-authentication failure is rejected before the refresh token is spent, so a
bounded slow retry pass re-attempts it every fifteen minutes. Once the operator fixes the app
secret, the next retry returns the row to `active` without re-consent; clearing the grant would
otherwise wipe every user of a deployment-owned application in one pass.

When a successful response omits `refresh_token`, the stored refresh token is kept (RFC 6749 §6).
When it omits `refresh_token_expires_in`, the previous absolute refresh deadline is kept rather
than granting a new window. When it omits `expires_in`, the provider's verified two-hour default
(7200 seconds) applies. When it omits `scope`, the stored scopes are kept.

Polling outcomes:

| Provider response | Meaning | Action |
| --- | --- | --- |
| `authorization_pending` | Approval not finished | Keep the flow, poll after the current interval |
| `slow_down` | Polling too fast | Add five seconds to the interval, capped at 60 seconds; keep the flow |
| `access_denied` | User refused | Terminal flow status `denied`; bounded code only |
| `expired_token`, `invalid_grant` | Device code is gone | Terminal flow status `expired`; require a new connect |
| Transport failure, timeout, or unparseable body | Outcome unknown | Keep the flow; increase the interval with the same 60-second cap; retry later |
| Any other provider error | Provider rejected the poll | Terminal flow status `failed`; bounded code only |

Polling is safe to retry: re-exchanging a consumed device code returns `invalid_grant`, which is
terminal for the flow but cannot destroy an existing credential. Unlike refresh, a retried poll
does not risk spending a rotating credential. `error_description` is never stored, logged, or shown.

## Deployment configuration

The first rollout uses one deployment-owned Feishu application, not a per-Account registration:

| Variable | Meaning |
| --- | --- |
| `OPENTAG_MCP_FEISHU_APP_ID` | Application ID used as `client_id` |
| `OPENTAG_MCP_FEISHU_APP_SECRET` | Application secret; Server-only, never stored in the database |
| `OPENTAG_MCP_FEISHU_SCOPES` | Space- or comma-separated scopes to request; `offline_access` is appended when absent |

All three are required together. When they are absent, the Feishu connect action is unavailable and
the API answers a bounded "not configured" error; nothing else about MCP changes. This is how the
feature lands dark until an operator validates the application on dev.

The exact seven read scopes are an operator input, not a guessed default. They are validated with
the application that will actually be used, and the resulting grant is not described as read-only:
the verified application returned broad historical grants. The six-tool restriction is a separate
control.

A per-Account Feishu application is out of scope for the first rollout. If it is needed later, add
a provider registration keyed by `(account, provider, client_id)` with its own uniqueness rule;
do not reuse `mcp_client_registrations`, which is unique per `(account, issuer)` for standard MCP
OAuth and cannot represent multiple applications for one provider.

## Data model

### Authorization row additions

`mcp_server_authorizations` gains:

| Column | Purpose |
| --- | --- |
| `credential_source` (`manual` \| `feishu_user`, not null, default `manual`) | Who owns renewal |
| `refresh_token_expires_at` | Provider refresh deadline; required for a managed credential |
| `provider_client_id` | Feishu application ID that owns the grant; null for manual credentials |
| `provider_account_id` | Feishu `open_id` returned by the identity check; null for manual credentials |
| `provider_tenant_key` | Feishu tenant key from the identity check; null for manual credentials |
| `credential_endpoint` | The exact MCP endpoint this managed credential is bound to; null for manual credentials |
| `managed_tool_names` | The fixed tool allowlist written with the managed credential; null for manual credentials |

Checks:

- `credential_source = 'feishu_user'` requires `kind = 'bearer'`, a non-null `provider_client_id`,
  a non-null `credential_endpoint`, a non-null `refresh_token_expires_at`, and a non-empty
  `managed_tool_names` while a credential is present.
- A managed credential cannot be written without a refresh token in its envelope. The service
  checks the decrypted envelope; the database checks the refresh deadline and managed metadata.
- Provider and managed-policy columns are null unless the source is `feishu_user`.
- `refresh_claim_id` remains valid for `kind = 'oauth'` rows and becomes valid for
  `credential_source = 'feishu_user'` rows. The existing check is widened; it is not removed.
- The refresh-due index includes `credential_source = 'feishu_user'` active rows, not only
  `kind = 'oauth'`.

No account or user table is added. The grant is an Agent-scoped authorization row, as every MCP
credential already is.

### Pending device flow

A separate table keeps pending device state out of the credential row's OAuth flow columns:

```text
mcp_provider_authorization_flows
  id, mcp_server_id, agent_id, provider,
  status (pending | denied | expired | failed | not_renewable), failure_code,
  device_code_ciphertext,
  user_code, verification_uri, expires_at,
  poll_interval_seconds, next_poll_at,
  poll_claim_id, poll_claimed_at,
  created_at, updated_at
  unique(mcp_server_id, agent_id)
```

- The `device_code` is sealed with the existing authorization envelope AAD. The user code and
  verification URI are not secrets; they are bounded and never logged.
- A new `start` upserts the row, resets it to `pending`, clears `failure_code`, and invalidates the
  previous device code in the same write.
- Success deletes the flow row in the same transaction that writes the credential. Cancellation and
  explicit revocation delete it too. A denied, expired, or failed flow keeps the row with its
  terminal status and bounded `failure_code` until the next `start`, so the UI can explain what
  happened after a reload.
- The flow row is the pending signal. Starting a re-connection does not downgrade a working
  credential, matching the OAuth reauthorization behavior.

### First connect and terminal flow results

`mcp_server_authorizations_bearer_has_credential` forbids a `bearer` row in `pending` or `active`
without a ciphertext. The first Feishu connect therefore does not create a pending bearer row:

- If no authorization row exists, `start` creates `kind = 'none'`, `status = 'pending'`,
  `credential_source = 'manual'`, no credential. The flow row is what says a connection is in
  progress; `resolveActiveCredential` still reports unauthorized.
- If a row already exists, its `kind`, `status`, `credential_source`, and credential are left
  untouched while the flow runs. This includes an anonymous `none`/`active` row and a working
  manually supplied or managed credential.
- On success, the identity check (`user_info`) runs before anything is stored. A failed identity
  check is a terminal flow failure and stores no credential. The response must also carry a
  non-empty `refresh_token`; without one the grant is not renewable, so the flow ends as
  `not_renewable` and no credential is stored. A missing `refresh_token_expires_in` uses the
  verified seven-day default; a computed deadline that is not in the future is also
  `not_renewable`. On success, the row becomes `kind = 'bearer'`, `status = 'active'`,
  `credential_source = 'feishu_user'`, with the sealed credential, `credential_endpoint`, the fixed
  `managed_tool_names`, and provider metadata written together.
- On a denied, expired, failed, or not-renewable flow, the flow row keeps the terminal status. In
  addition, a first-connect row still at `none`/`pending` becomes `none`/`error` with the same
  bounded `failure_code`. A working credential or an anonymous `active` row is never downgraded by a
  failed re-connection.
- Cancelling a first-connect flow deletes the `none`/`pending` row created for it, restoring the
  "no authorization row" state. Cancelling a re-connection leaves the existing row untouched.

### What drives polling

Device codes expire in minutes, and the existing refresh worker ticks every five minutes. A
five-minute tick cannot drive this flow. There are two pollers, both using the same flow-row claim
and the same `next_poll_at` gate:

- The Web App calls an authenticated, ownership-checked poll route while the connect dialog is
  open. That request performs at most one claimed upstream poll; if `next_poll_at` is still in the
  future it returns the current flow status without a provider call.
- A dedicated short-interval worker claims due flow rows for restart recovery and for users who
  closed the tab. Its interval is five seconds and its batch is bounded, so it can poll at the
  provider's requested cadence without touching the refresh worker's schedule.

The flow row's claim is a compare-and-swap; a stale claim is reclaimable after two minutes. A
Server restart resumes from the persisted row and its `next_poll_at`.

## Lifecycle and states

| State | Row | UI |
| --- | --- | --- |
| Connecting | Flow `pending`; authorization row is `none`/`pending` on a first connect, or unchanged while a working credential stays in place | Show user code, verification link, countdown |
| Connected | `active`, `credential_source = 'feishu_user'`, credential present, probe current | "Connected with your Feishu account; renews automatically" |
| Renewal failed | `error`, `failure_code = MCP_REFRESH_OUTCOME_UNKNOWN` or a bounded provider code | "Renewal failed; reconnect required"; never "connected" |
| Configuration error | `error`, `failure_code = MCP_FEISHU_APP_CREDENTIALS_INVALID`; token kept | "Feishu app configuration is invalid; operator action required"; slow retry |
| Reauthorization required | `revoked` or `expired`, or `failure_code = MCP_AUTHORIZATION_REQUIRED` | "Reconnect Feishu" |
| Denied, expired, failed, or not-renewable flow | Flow row terminal; authorization row unchanged, or `none`/`error` on a first connect | Show the bounded reason and offer connect again |
| Refresh deadline reached | `expired`; no provider call | "Feishu authorization expired; reconnect" |
| Manual bearer | `credential_source = 'manual'`, no refresh deadline | "Static credential; does not renew" |

The authorization DTO adds `credentialSource`, `refreshTokenExpiresAt`, `providerAccountId`,
`providerTenantKey`, the read-only `managedToolNames`, and a nullable `pendingAuthorization`
carrying the flow status, user code, verification URI, expiry, and bounded failure code. It still
never carries a token, ciphertext, key ID, device code, or app secret.

## Refresh ownership and concurrency

Each rotating refresh credential has exactly one owner: the one authorization row that holds it.

- The Server is the only refresher. The CLI's credential store is never read, copied, or
  synchronized.
- A second Agent connecting the same Feishu user performs a new device authorization and receives
  its own refresh credential. Tokens are never copied between rows.
- Multi-Agent sharing of one grant is out of scope. It would need one credential row with one
  refresh owner and a fan-out of access tokens; duplicating the refresh token into independently
  renewed rows is forbidden.

The existing OAuth refresh machinery is extracted into a shared custody helper rather than
duplicated:

- claim the row with one compare-and-swap, expiring a stale claim after two minutes;
- call the provider outside the database transaction;
- write the new envelope and generation with a fence on the claim;
- release the claim on a local decryption failure without changing state;
- write the row state from a normalized verdict (`success`, `terminal`, `retryable-preserve`,
  `config-error`, `policy-stop`, `unknown`) so provider-specific code maps stay in the provider client.

The database lease is a concurrency control, not an exactly-once guarantee. A process can die after
the provider rotated the token and before the write-back. The proposal therefore keeps the existing
rule: a transport failure, timeout, 5xx, or unparseable response is an **unknown outcome**. The row
goes to `error` with `MCP_REFRESH_OUTCOME_UNKNOWN`, the old refresh token is kept, the connection is
not reported healthy, and no automatic retry spends a token that may already be consumed.

Feishu user-grant terminal codes (`20026`, `20037`, `20064`, `20073`) clear the credential and
require a new connect. `20050` is retryable-preserve: the row stays `active`, the claim is released,
and the next scheduled refresh pass retries; it is never retried inside the same pass. A
policy-challenge code (`21000`, `21001`) keeps the token, marks the row `error` with a bounded code,
and waits for the owner to complete the Feishu challenge and reconnect. An invalid-client code
(`99991543`, `10014`) keeps the token and marks the row `error` with
`MCP_FEISHU_APP_CREDENTIALS_INVALID`; the slow retry pass restores it after the deployment secret
is fixed. Any other numeric code is unknown: keep the token, mark the row `error`, and do not
auto-retry.

Before any refresh call, a `refresh_token_expires_at` at or past the current time marks the row
`expired` without contacting the provider; there is nothing to spend. On a successful refresh, the
deadline is `now + refresh_token_expires_in` when the provider returns one, and the previous
absolute deadline when it omits the field. A first connect that omits it uses the verified
seven-day default (604800 seconds). Whether the provider slides the deadline on each rotation is an
open evidence item: if it is fixed from the original grant, the Connected UI must show the reconnect
date rather than implying indefinite renewal.

Device polling uses the same claim idea on the flow row. Two Server instances cannot exchange one
device code concurrently; a stale poll claim is reclaimable after two minutes. A restart resumes
from the persisted flow row.

Refresh repeats the same endpoint check against `credential_endpoint`; a mismatch records
`MCP_AUTHORIZATION_REQUIRED` and does not spend the rotating refresh token. The resolve-time check
in the binding section already prevents any probe or call from sending the credential to a
different endpoint, so refresh is a third line of defense rather than the only one. If the
configured application ID no longer equals `provider_client_id`, do the same rather than send the
grant to a different application.

## Authorization policy

The managed grant is **Agent-scoped**, consistent with every existing MCP credential. Any turn of
that Agent may use it, including a turn started by another person, a group conversation, or a
schedule. Connecting therefore shares the owner's Feishu-visible data with every conversation that
Agent handles, not only with the owner's own requests.

This must be stated plainly in the connect confirmation. Only an Account member who can manage the
Agent may connect or disconnect it. A stricter per-invoker policy is not part of this proposal: it
would require a new authorization dimension and should be designed separately. Until then, an owner
who does not accept the Agent-wide scope should not connect the grant.

## Managed endpoint and tool-policy binding

The managed grant is coupled to two immutable facts written with the credential: the exact MCP
endpoint it was issued for, and the six tool names it may use. Neither is read from mutable
configuration at send time.

`resolveActiveCredential` is the one resolution point for probing and the gateway. For a
`feishu_user` row it must:

- require the effective URL to equal `credential_endpoint` exactly
  (`https://mcp.feishu.cn/mcp`), and fail closed with `MCP_AUTHORIZATION_REQUIRED` before
  decrypting the credential or building any header when it does not;
- require the row's `managed_tool_names` to be non-empty.

`buildHeadersFor` re-checks the same endpoint binding for callers that already hold a resolved row,
and for a managed row it removes every case variant of the authorization and allowed-tools header
names from the effective extra headers (extra headers are stored lowercase), then sets exactly one
lowercase `x-lark-mcp-uat` with an empty prefix and one lowercase `x-lark-mcp-allowed-tools` with
`managed_tool_names.join(",")`. A shared-definition edit or an Agent override therefore cannot
remove, rename, duplicate, or widen the managed credential's headers.

The gateway filters the advertised tool list to `managed_tool_names` and rejects a `tools/call`
for any other name before dialing upstream. The probe snapshot still records what the provider
advertises, so an operator can see the effect of the header, but the model-facing and callable
surface is the row's list.

Configuration writes are the first gate: changing the shared URL or setting an Agent `url_override`
is rejected with a bounded conflict while any `feishu_user` row that holds a credential is bound to
the old endpoint, including an `error` row whose slow retry could later return it to `active`; the
user must disconnect first. The resolve-time check is the backstop for a write that races, a
database change, or a path that forgets the write-time guard.

The six names are a provider constant written at connect time and are not editable from the Server
settings. A re-connect writes a fresh list with the new credential. This is a credential-coupled
least-privilege policy, not a nullable generic field on a mutable definition.

## Security boundary

- The app secret exists only in Server configuration. It is never written to the database, a DTO,
  a log line, or an error message.
- Device codes are sealed. User codes and verification URIs are bounded, are not credentials, and
  are still excluded from logs.
- The Feishu credential is sent only when the effective MCP endpoint equals the row's
  `credential_endpoint`; see [Managed endpoint and tool-policy binding](#managed-endpoint-and-tool-policy-binding).
  Extending the accepted endpoint is an explicit code change.
- All provider calls use the existing outbound fetcher and URL policy, with fixed provider origins.
  No provider URL comes from a request body or a peer document.
- Token values use the existing 16 KiB encrypted envelope bound; the observed 6,717-character token
  fits.
- Provider errors become bounded codes. Free-form provider text is never echoed.
- The existing gateway delivery is unchanged: Local and Cloud runtimes receive only the
  execution-scoped gateway token, never the upstream credential.

## Non-goals

- Hosted-MCP OAuth onboarding, PKCE, DCR, CIMD, and the `resource` parameter are untouched.
- No Feishu document/IM adapter in the Server. The six tools remain the hosted MCP service's.
- No per-Account Feishu application, no multi-Agent credential sharing, no CLI device-flow command.
- No claim that the grant is read-only. The UI says what the grant is and which tools OpenTag
  allows.
- No live content reads in this design. They require separately approved representative data.

## Implementation gate

Steps 1-8 do not start until the following evidence is recorded for the application OpenTag will
own: FUA-A1 (application identity), FUA-A2 (device-flow eligibility), FUA-A3 (required scopes and
`offline_access`), FUA-A5 (hosted-MCP six-tool discovery), and FUA-A6 (one real refresh rotation).
A2, A3, A5, and A6 can be produced with the pinned CLI or a controlled token, not the unbuilt
feature. The CLI application that was verified is not the product application, so its success is
not evidence for this gate. FUA-A4 (user and tenant eligibility) is required before the dev
rollout, not before implementation.

## Implementation sequence

1. Migration and schema: `credential_source`, provider metadata, `credential_endpoint`,
   `managed_tool_names`, flow table, widened claim check, refresh-due index.
2. Extract OAuth refresh custody into a shared helper with unchanged behavior and tests.
3. Feishu provider client: device authorization, poll, refresh, identity check, fixed endpoints,
   numeric code-to-verdict map, fake-fetcher unit tests.
4. Feishu managed-credential service: start, poll, credential write, refresh, revoke, endpoint and
   application binding checks.
5. Workers and polling: managed refresh dispatch, slow config-error retry, a dedicated five-second
   device-flow poll worker, the authenticated on-demand poll route, expiry and restart recovery.
6. Shared DTOs and server routes: start/poll/status, lifecycle fields, availability.
7. Gateway and binding: endpoint check in `resolveActiveCredential` and `buildHeadersFor`, the
   forced auth header and allowed-tools header, managed-list filtering and call rejection, and the
   configuration-write rejection for an incompatible URL change.
8. Web App: connect dialog, pending/connected/renewal-failed/reauthorization-required states,
   manual-bearer truthfulness, allowlist visibility.

Steps 1-3 are the smallest testable seam. Steps 4-8 make the feature usable.

## Validation

The [verification plan](../../verification/feishu-user-mcp-authorization.md) covers:

- app-level validation the operator must complete before implementation and again before turning
  the feature on;
- provider-client contract tests against fixtures, with no public network;
- PostgreSQL integration tests for migration, claims, restart, rotation, revocation, and unknown
  outcomes;
- Web App state tests;
- gateway allowlist tests, including a forbidden `tools/call` that must fail before upstream;
- the dev rollout on gan, with pre-refresh and post-refresh six-tool discovery reported separately
  from content access.

Discovery-only results are not accepted as content-access validation.

## Decisions requested

1. Use device authorization first, with an HTTPS authorization-code flow as a compatible later
   addition.
2. Use one deployment-owned Feishu application for the first rollout, configured only on dev.
3. Accept the Agent-scoped grant policy and its explicit disclosure in the connect UI.
4. Include the credential-coupled call-time tool allowlist in the first implementation rather than
   relying only on the provider header.
5. Approve the schema shape above, including the flow table and the credential-source, endpoint,
   and managed-tool binding columns.
6. Treat FUA-A1-A3, A5, and A6 as the pre-implementation gate, not merely pre-enablement checks.
