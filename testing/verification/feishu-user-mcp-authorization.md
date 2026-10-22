# Feishu user MCP authorization: verification and acceptance

Test and acceptance material for [Feishu user MCP authorization](../../docs/system/capabilities/mcp-server-integration.md).
Design: [Feishu user MCP authorization proposal](../design/feishu-user-mcp-authorization/README.md).

Status: planned. No scenario below is claimed as passed until its evidence is recorded here or in
the implementing pull request.

## Evidence tiers

| Tier | Meaning |
| --- | --- |
| Unit | No public network, no PostgreSQL; provider responses are fixtures |
| Integration | PostgreSQL through testcontainers; provider is a loopback fixture |
| Live discovery | The deployed Server reaches the real Feishu hosted MCP endpoint |
| Live content | Approved representative document or IM data is actually read |
| Live Agent | A real Agent turn uses the managed grant through the gateway |

Discovery and content access are separate claims. A successful six-tool listing is not evidence
that a document or message can be read.

## Pre-implementation gate: application validation

These are gates, not merely pre-enablement checks. Steps 1-8 in the design do not start until
FUA-A1, A2, A3, A5, and A6 are recorded for the application OpenTag will own. A2, A3, A5, and A6
may be produced with the pinned CLI or a controlled token, not the unbuilt feature. The CLI
application used in the original investigation is not the product application, so its success is
not evidence here. FUA-A4 is required before the dev rollout.

| ID | Check | Evidence required |
| --- | --- | --- |
| FUA-A1 | The chosen Feishu application is the one OpenTag will own; its app ID and secret are recorded in the deployment secret store | App ID and the deployment revision, never the secret |
| FUA-A2 | Device authorization is enabled for that application | One real device authorization reaches the consent screen |
| FUA-A3 | The application has the seven IM/document read scopes plus `offline_access` | Granted `scope` from the token response, reviewed for the exact set |
| FUA-A4 | The selected user and tenant are eligible under the organization's policy | Consent succeeds and the identity check returns the expected `open_id` and tenant key |
| FUA-A5 | The token works at the hosted MCP endpoint with the six-tool allowed-tools header | `probeState = succeeded`, `toolsCount = 6`, `toolsTruncated = false` |
| FUA-A6 | Refresh works for this application and rotates both tokens | Before/after token hashes differ; a post-refresh probe still lists six tools; record `refresh_token_expires_in` before and after to determine whether the deadline slides |

FUA-A3 is an operator input (`OPENTAG_MCP_FEISHU_SCOPES`), not a guessed default. The grant is not
described as read-only: the verified application returned broad historical grants.

## Provider client (unit)

| ID | Scenario | Expected |
| --- | --- | --- |
| FUA-U1 | Device authorization request | Fixed `accounts.feishu.cn` URL, form body, Basic auth, `offline_access` appended once |
| FUA-U2 | Missing configuration | No request is made; a bounded "not configured" error |
| FUA-U3 | `authorization_pending` | Flow kept; next poll at the current interval |
| FUA-U4 | `slow_down` | Interval increases by five seconds, capped at 60 seconds; flow kept |
| FUA-U5 | `access_denied` | Flow status `denied`; bounded code; no provider text stored |
| FUA-U6 | `expired_token` / `invalid_grant` | Flow status `expired`; reconnect required |
| FUA-U7 | Transport, timeout, or unparseable poll response | Flow kept; interval increases with the 60-second cap; retry later |
| FUA-U8 | Unexpected provider error | Flow status `failed`; bounded code; no secret in the message |
| FUA-U9 | Successful poll | Tokens, scopes, access expiry, refresh expiry parsed; identity check issued with the access token |
| FUA-U10 | Refresh request shape | `https://open.feishu.cn/open-apis/authen/v2/oauth/token`; JSON body with `grant_type`, `refresh_token`, `client_id`, `client_secret` |
| FUA-U11 | Refresh response | Rotated access and refresh tokens, `expires_in`, `refresh_token_expires_in` |
| FUA-U12 | Oversized or malformed token fields | Refused by the envelope schema; nothing stored |
| FUA-U13 | Outbound policy | A redirect or non-public resolution is refused with no request sent |
| FUA-U14 | `20026`, `20037`, `20064`, `20073` | Terminal verdict; credential cleared; reconnect required |
| FUA-U15 | `99991543`, `10014` | Config-error verdict; token kept; row `error` with `MCP_FEISHU_APP_CREDENTIALS_INVALID`; slow retry; no clear |
| FUA-U16 | `20050` | Retryable-preserve verdict; token kept; no retry inside the same pass |
| FUA-U17 | `21000`, `21001` | Policy-stop verdict; token kept; bounded security-challenge code; no auto-retry |
| FUA-U18 | Missing `code`, missing `access_token`, or another numeric code | Unknown verdict; token kept; no auto-retry |
| FUA-U19 | Omitted response fields | Missing `refresh_token` keeps the stored one; missing `refresh_token_expires_in` keeps the previous deadline; missing `expires_in` uses 7200 seconds; missing `scope` keeps stored scopes |
| FUA-U20 | Identity check failure | Terminal flow failure; no credential stored; bounded code only |
| FUA-U21 | Device success without `refresh_token` | Flow status `not_renewable`; no credential stored; no "renews automatically" claim |
| FUA-U22 | Device success without `refresh_token_expires_in` | Seven-day default applied; flow succeeds only when the computed deadline is in the future |

## Persistence and lifecycle (integration)

| ID | Scenario | Expected |
| --- | --- | --- |
| FUA-I1 | Migration | Existing rows read `credential_source = 'manual'`; no credential or probe data changes |
| FUA-I2 | Start device flow | One flow row per `(Server, Agent)`; device code sealed; status `pending`; starting again replaces the code and clears a terminal status |
| FUA-I3 | Concurrent poll claims | Exactly one instance calls upstream with a live claim; the other waits |
| FUA-I4 | Restart between start and approval | A new process resumes from the flow row and completes the connect |
| FUA-I5 | Concurrent refresh | One provider call; the losing worker does not spend the token |
| FUA-I6 | Refresh write-back fence | A revocation or re-connect during the provider call wins; the stale success does not resurrect a credential |
| FUA-I7 | Unknown refresh outcome | Row `error`, `MCP_REFRESH_OUTCOME_UNKNOWN`, old refresh token kept, no automatic retry |
| FUA-I8 | Terminal refresh outcome | `20026`, `20037`, `20064`, or `20073` clears the credential and requires reconnect; an invalid-client code keeps the token and follows FUA-I25 |
| FUA-I9 | Refresh deadline | An access token refreshes before expiry; a refresh token past its deadline requires reconnect without an upstream call |
| FUA-I10 | Changed endpoint | `MCP_AUTHORIZATION_REQUIRED`; no refresh call is made |
| FUA-I11 | Changed application ID | `MCP_AUTHORIZATION_REQUIRED`; the grant is not sent to another application |
| FUA-I12 | Manual bearer isolation | Manual rows never enter the managed refresh scan; existing Bearer behavior is unchanged |
| FUA-I13 | Standard OAuth isolation | OAuth refresh, claims, fencing, and revocation keep their existing behavior after custody extraction |
| FUA-I14 | Soft-deleted Agent | No poll or refresh runs for it; its flow is not resumed |
| FUA-I15 | Denied flow with a working credential | The working credential stays active; the flow row records the denial; the row is not downgraded |
| FUA-I16 | Cancel / revoke | Flow and credential are cleared; a late poll or refresh cannot restore them |
| FUA-I17 | First connect shape | The row is `none`/`pending` with no credential until success; `resolveActiveCredential` stays unauthorized; success writes `bearer`/`active`/`feishu_user` |
| FUA-I18 | Terminal flow persistence | A denied or expired flow survives a reload with its bounded reason; the next start clears it; a first-connect `none`/`pending` row becomes `none`/`error` |
| FUA-I19 | Atomic success | The credential write and flow-row deletion commit together; no success leaves a stale pending flow |
| FUA-I20 | Polling drivers | The on-demand route polls once when `next_poll_at` is due and does not call upstream before it; the dedicated worker recovers a flow after restart |
| FUA-I21 | `20050` lifecycle | The row stays `active`, the claim is released, and the next scheduled pass retries; no retry in the same pass |
| FUA-I22 | Refresh deadline evidence | The stored deadline follows a returned `refresh_token_expires_in` and keeps the previous value when omitted; the slide-versus-fixed result is recorded |
| FUA-I23 | Cancel first connect | The `none`/`pending` row created for the flow is deleted; cancelling a re-connection leaves the existing row untouched |
| FUA-I24 | First write without renewal material | A missing refresh token or an invalid computed deadline cannot produce an `active` managed row; the service refuses and the flow is `not_renewable` |
| FUA-I25 | Config-error recovery | Invalid-client codes keep the token, mark `error` with the bounded config code, retry slowly, and return to `active` after the secret is fixed |
| FUA-I26 | Shared URL change after connect | The configuration write is rejected while any credential-holding `feishu_user` row is bound, including an `error` row; a forced database change makes probe and `tools/call` fail closed with no upstream request and no credential header |
| FUA-I27 | Agent URL override after connect | Setting the override is rejected while any credential-holding `feishu_user` row is bound, including an `error` row; a forced override makes probe and `tools/call` fail closed with no upstream request and no credential header |
| FUA-I28 | Managed tool-policy invariant | Editing the shared definition or an Agent override cannot clear or widen `managed_tool_names` or the forced provider header; the advertised and callable set stays the six names |

## Gateway and tool restriction (unit or integration)

| ID | Scenario | Expected |
| --- | --- | --- |
| FUA-G1 | Managed tool list | The managed row advertises exactly `managed_tool_names`; a non-managed row keeps its existing behavior |
| FUA-G2 | Forbidden `tools/call` | Rejected before any upstream request; the fixture request log is empty for that call |
| FUA-G3 | Unmanaged rows | No managed policy is applied; existing unrestricted behavior is unchanged |
| FUA-G4 | Forced provider header | `X-Lark-MCP-Allowed-Tools` is exactly the six names even when a lowercase shared or Agent override removes or widens it; the fixture asserts one header value, not a combined value |
| FUA-G5 | Endpoint binding | A managed row whose effective URL differs from `credential_endpoint` produces `MCP_AUTHORIZATION_REQUIRED` before any credential header or upstream request |
| FUA-G6 | Managed token header | The managed token is sent as `X-Lark-MCP-UAT` with an empty prefix; no token appears in a DTO |

## Web App (unit)

| ID | Scenario | Expected |
| --- | --- | --- |
| FUA-W1 | Start connect | User code, verification link, and expiry are shown; the dialog survives a reload |
| FUA-W2 | Pending poll | The dialog reports pending without a spinner that implies failure |
| FUA-W3 | Connected | Shows the Feishu-managed lifecycle, not the manual "Bearer" label |
| FUA-W4 | Renewal failure | Shows "renewal failed; reconnect", never "connected" |
| FUA-W5 | Reauthorization required | Offers reconnect and explains why |
| FUA-W6 | Manual bearer | Explicitly says the credential is static and does not renew |
| FUA-W7 | Accessible connect/disconnect | Ownership is required; a non-owner cannot connect or disconnect |
| FUA-W8 | Fixed refresh deadline | If the deadline does not slide, the Connected state shows the reconnect date instead of implying indefinite renewal |
| FUA-W9 | Not-renewable flow | Shows the bounded not-renewable reason and a connect-again action, never "connected" or "renews automatically" |
| FUA-W10 | Configuration error | Shows that the deployment's Feishu app configuration is invalid and needs an operator; it does not tell every user to re-authorize |

## Dev rollout (live)

| ID | Step | Evidence |
| --- | --- | --- |
| FUA-L1 | Configure the three variables on dev only; leave production unset | Deployment revision and variable names, not values |
| FUA-L2 | Connect gan with the validated application | Flow completes; identity check succeeds; row `active` |
| FUA-L3 | Pre-refresh discovery | Six tools, not truncated |
| FUA-L4 | Force or wait for an access-token refresh | Rotation observed; row remains `active`; no manual token paste; record `refresh_token_expires_in` before and after |
| FUA-L5 | Post-refresh discovery | Six tools, not truncated |
| FUA-L6 | Server restart | The credential survives; the next refresh succeeds |
| FUA-L7 | Unknown-outcome simulation | UI shows renewal failure; no silent retry |
| FUA-L8 | Revoke in Feishu or force terminal expiry | UI shows reconnect required; no false healthy state |
| FUA-L9 | Real document read and real IM read with approved data | Content returned; recorded as content acceptance, not discovery |
| FUA-L10 | Real Agent turn through the gateway | The Agent calls an allowed tool; a forbidden tool is refused |
| FUA-L11 | Local and Cloud runtime | Both use the gateway; neither receives the upstream token |

## Out of scope for this verification

- A production rollout. The first rollout remains gan on dev.
- Any write call to Feishu. Forbidden-write rejection uses fixtures.
- Unapproved document, message, or organization data.
- Multi-Agent sharing of one Feishu grant.
- Hosted-MCP OAuth onboarding.
