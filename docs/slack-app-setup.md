# OpenTag Slack Public Distribution

[简体中文](./zh-CN/slack-app-setup.md)

OpenTag supports at most one current Slack App/Team/Bot installation for an App/Team pair. One Slack workspace installs
the publicly distributed **@OpenTag** Bot for one OpenTag Agent through first-party OAuth. The installation is owned by
that Agent, and V1 inbound delivery uses its configured **default** Agent route or fails closed.

An authenticated Agent management flow starts OAuth; the callback creates or updates that Agent's Slack installation
and sets the Agent's default route. Internal subagents stay invisible in Slack. There is no customer-owned Slack App,
manual token, or Change App path.

A current Slack App/Team installation is never silently shared or transferred to another Agent. A different Agent
claiming the same App/Team returns `SLACK_APP_TEAM_ALREADY_BOUND` without side effects. The owning Agent may
reauthorize the same installation. Transfer is an explicit remove/uninstall followed by a fresh installation: the old
row keeps its historical Agent owner and becomes disabled, while the new Agent receives a new current row. URL
verification and inbound messages are runtime observations; neither creates, completes, or activates a credential
generation. Production Events API remains signed HTTP and includes `app_uninstalled` and `tokens_revoked`. Socket Mode
is not used.

## Fixed Slack capability contract

The first-party OpenTag Slack App requests the complete capability set on the first connection and every later
reauthorization. `mention_only` and `all_message` use the same Slack installation.

Required bot scopes:

- `app_mentions:read`
- `channels:history`
- `channels:join`
- `channels:read`
- `chat:write`
- `files:read`
- `files:write`
- `groups:history`
- `groups:read`
- `im:history`
- `im:write`
- `mpim:history`
- `reactions:read`
- `reactions:write`
- `team:read`
- `users:read`

Subscribed bot events:

- `app_mention`
- `app_uninstalled`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`
- `tokens_revoked`

The manifest also enables a writable App Home Messages tab. Changing an Agent's `receiveMode` only updates OpenTag's
local admission policy. It does not change the manifest, rotate an installation credential generation, require reinstall
or reauthorization, retry the Request URL, or send a test message. `assistant:write` is not part of the V1 capability
contract; it may be considered later as an optional extra and must not be added to the current installation.

A credential-free local live acceptance checklist for a separately registered test Team/App is in
[slack-live-acceptance.md](./slack-live-acceptance.md).

## Agent configuration flow

1. Open **Add OpenTag to Slack** or **Reauthorize Slack**. OpenTag starts first-party OAuth. Reading the page writes
   nothing.
2. Approve the OpenTag Slack App in the intended Slack workspace.
3. The public callback exchanges the Slack code, inspects Bot identity, Team, Enterprise when present, and the actual
   `x-oauth-scopes`, and requires all sixteen fixed bot scopes. If Slack returns an App ID, it must match the first-party OpenTag
   App.
4. OpenTag locks the Agent's current route, rechecks Team authority and the expected route generation, and atomically
   enforces the submitted intent against the Slack installation. **Create** installs the Slack installation and
   sets this Agent as the default route. **Reauthorize** must preserve the current App, Team, and Bot User even when
   `auth.test` omits `app_id`. There is no Slack Change App or replace intent; disconnect the current route if the Agent
   should leave Slack. OpenTag then atomically writes the installation identity, encrypted credentials, complete grants,
   and new generation. Validation failure, identity drift, or a stale expected generation leaves the current installation
   unchanged.
5. After the write succeeds, Slack's shared Events Request URL is already configured on the first-party App. A real
   message is not part of configuration acceptance.

Slack does not guarantee `app_id` in `auth.test` for a Bot Token. The App ID stored from OAuth is therefore projected as
**configured evidence**, not as Slack API-attested identity. Every request still has an independent proof boundary.
The Agent-specific Request URL looks up the Agent's Slack route only to locate the Slack installation, then verifies
the timestamped HMAC over the raw body **before** parsing JSON. The compatibility Events URL may bounded-preparse only
App and Team identifiers to locate the installation Signing Secret, then verifies the same raw-body HMAC.
After a valid signature, every real event envelope's `api_app_id` and `team_id` must match the installation App ID and
token-derived Team ID. Ordinary message events must also contain the token-derived Bot User as a bot authorization for
that Team. This closes the HMAC-authenticated App to the token-derived Bot identity for the exact installation generation.
Until that closure succeeds, configuration remains durably committed but readiness and runtime credential grants fail
closed. A mismatch is rejected and never repairs configuration. Slack's app-level
[`tokens_revoked`](https://docs.slack.dev/reference/events/tokens_revoked/) and
[`app_uninstalled`](https://docs.slack.dev/reference/events/app_uninstalled/) envelopes do not provide matching bot
authorization context, so they are handled after HMAC plus exact App/Team verification and before identity closure.
Slack's official URL-verification payload contains no App, Team, or bot authorization fields, so the Agent-specific URL
can verify only the bound Signing Secret for that challenge; it records no identity closure.

## Data and state inventory

| Item | Disposition | Source of truth and meaning |
| --- | --- | --- |
| Binding `id`, Agent, Team, provider, status | Keep as Agent route | One current non-disabled IM binding per Agent. Slack rows are routes to that Agent's installation (`slackInstallationId`, `slackRouteKind`) and never store Bot Token or Signing Secret. |
| Slack Team installation | Keep | One current App/Team/Bot identity, owning Agent, encrypted credentials, grants, generation, and identity-closure/lifecycle per App/Team pair. |
| App, Team, Enterprise, Bot User/Bot identity | Keep | App ID is explicit configured evidence; Team and bot identity come from token inspection; Enterprise is optional. |
| Team and Bot display metadata | Keep as optional presentation data | Team name, Bot display name, and avatar may be shown in management views, but never authorize configuration, ingress, or runtime access. |
| Bot Token and Signing Secret | Keep encrypted on the installation | Stored together in the installation credential envelope; never copied onto Agent routes and never returned by management, diagnostics, or runtime-config APIs. The Signing Secret is never projected to runtime. |
| `credentialGeneration` and credential schema version | Keep on the installation | Installation-authoritative monotonic credential revision. Routes sync a sanitized snapshot for Session fencing and diagnostics. Same-identity reauthorization increments the installation generation. Slack has no replace-App cutover. |
| `grantedCapabilities` | Keep on the installation | Actual token scopes reported by Slack. Routes sync a sanitized snapshot. Active/readiness projections require all sixteen fixed scopes. |
| `activatedAt`, `disabledAt`, `createdAt`, `updatedAt` | Keep | Durable installation lifecycle timestamps, with sanitized copies on Slack routes. Configuration submission sets activation; inbound events do not. Public APIs project `activatedAt` as `lastValidatedAt`. |
| `observedAt` | Keep as runtime observation | Installation-authoritative. Updated after a correctly signed Agent-specific URL challenge, or after a correctly signed real event whose App, Team, and bot authorization match. Routes sync the sanitized timestamp. Public APIs project it as `lastRuntimeObservationAt`. It is not configuration evidence and does not change generation. |
| `observedConnectedAt` | Keep as generation identity closure | Installation-authoritative. For Slack, records when a signed real event's `authorizations` first closed the configured App/Team to the token-derived Bot User for the current installation generation. Later matching events preserve this first timestamp and refresh only `observedAt`. Configuration resets it; URL verification never sets it. Feishu retains its existing connection-observation meaning. |
| `lastInboundAt` and normalized `ImMessage`/Session state | Keep | Message runtime history and routing state. Only admitted inbound messages update it. URL verification does not. |
| `lastConfirmedAt` | Delete from public APIs | It mixed configuration time with runtime observation. Use `lastValidatedAt` and `lastRuntimeObservationAt`. |
| `lastErrorCode` | Keep | Durable recovery cause such as `SLACK_SCOPE_REAUTH_REQUIRED` or `SLACK_TOKEN_REVOKED`; observations do not clear configuration errors. |
| `receiveMode` on the Agent | Keep | Local `mention_only`/`all_message` policy, independent of Slack authorization and credential generation. |
| `replacementImBindingId` | Keep as cutover provenance | Links a disabled binding to the replacement created during a Feishu Bot identity change. It is not setup progress. Slack no longer has a replace-App cutover. |
| Connection owner, lease, and fencing fields | Keep generically | Feishu connection ownership only. Slack has no managed connection lease and these fields stay empty. |
| Generic setup attempt/context fields | Keep for Feishu | `setupAttemptId`, setup intent/state/owner/heartbeat/expiry, and encrypted setup context remain for Feishu. Slack rows are database-checked so those setup fields stay null. |
| Slack setup attempt, encrypted temporary context, challenge proof, verification error/time, polling/expiry/cancel state | Delete | No Slack configuration phase exists between token validation and activation. |
| `pendingReceiveMode` / `pending_receive_mode` | Delete | There is no Slack-dependent receive-mode target. |

Derived values are not new durable states:

- binding health is derived from status plus currently readable, schema-valid, identity-consistent, and scope-complete credential material;
- unreadable, schema-invalid, identity-inconsistent, or scope-inconsistent current credentials fail closed: they are never projected as ready, and Slack ingress lookups return unavailable instead of throwing raw credential errors;
- `reauthorizationRequired` is derived from binding status, missing fixed scopes, or invalid current credential material;
- Slack `identityClosure` is `pending` or `verified` from the current generation's `observedConnectedAt`; pending closure
  keeps `ready` and `handoffReady` false and prevents runtime Bot Token grants without making the committed credential invalid;
- diagnostics report the exact `credentialGeneration` (including `0`), `credentialStatus` `valid` or `invalid`, and required/granted/missing capabilities;
- a structurally invalid credential with no more specific stored failure projects `IM_BINDING_CREDENTIAL_INVALID`; an
  actual fixed-scope gap continues to project `SLACK_SCOPE_REAUTH_REQUIRED`;
- `lastValidatedAt` is the current credential validation/activation timestamp; `lastRuntimeObservationAt` is the latest signed provider runtime observation; `lastInboundAt` remains message history;
- App ID evidence is always labeled `configured`, with signed-ingress matching required.

### Durable and derived state matrix

| State | Slack meaning after migration | Allowed transition source |
| --- | --- | --- |
| `provisioning` | Not a normal Slack state. An incomplete legacy Slack row is disabled by migration; new configuration writes `active` directly. | Feishu setup only. |
| `active` | A credential generation was committed. Slack readiness remains false until a matching signed event closes App/Team/Bot identity for that generation. Public state may still derive `reauthorization_required` when the current material is unreadable, structurally inconsistent, or missing a fixed scope. | Successful validated configuration or same-identity reauthorization. |
| `reauthorization_required` | The current installation must be reauthorized. Existing material is never reported healthy when the scope contract or credential inspection fails. | Scope migration, `tokens_revoked`, or an explicit recovery write. |
| `error` | Generic retained state for non-Slack setup/runtime failures; Slack configuration validation errors are returned without mutating the current row. | Non-Slack provider workflows or existing generic recovery code. |
| `disabled` | Terminal for that installation identity, or for one Agent route. Disabling the installation erases its active credentials, disables every route, and ends those Sessions. Disabling one route does not uninstall the Slack installation. | Explicit disable, `app_uninstalled`, or incomplete Slack cleanup. |

`bindingState`, `ready`, `handoffReady`, `reauthorizationRequired`, `credentialStatus`, and missing capabilities are
projections, not additional binding states. URL verification updates only runtime observation. A matching signed real
event may additionally set the current installation generation's identity-closure timestamp before message/routing work.
`receiveMode` changes only Agent policy. A same-identity credential commit increments the installation
`credentialGeneration` and syncs sanitized snapshots onto routes.

## Ingress, events, and errors

The generated Agent-specific Request URL and the compatibility Slack Events URL first locate the Slack installation
by Agent route or by App+Team, then accept only an already-active, fully scoped installation whose current credential
material is readable and valid. The Agent-specific URL verifies the raw-body signature before JSON parsing. The
compatibility URL may bounded-preparse App/Team solely for secret lookup. Both then require every real event's App ID
and Team ID before recording installation observation or processing it. Lifecycle events and generation fencing apply to
the installation. Ordinary messages are delivered only after an explicit unique default Agent route resolves; missing,
ambiguous, cross-workspace, or deleted default Agents are acknowledged without delivery. Only the Agent-specific URL can
route Slack's identity-less URL challenge. Signing secrets never enter runtime grants, diagnostics, logs, or traces.

- `url_verification`: on the Agent-specific URL, verify the bound Signing Secret, return the challenge, and record a
  runtime observation; the Slack payload has no App/Team identity, and the request does not activate, rotate, or repair
  anything.
- ordinary real `event_callback` messages: require a matching bot entry in `authorizations`, then record identity closure
  and runtime observation on the installation under the exact parsed credential generation; a stale generation is
  acknowledged without side effects.
- `app_mention` and message events: after the unique default route resolves, normalize and ingest under that installation
  generation; do not change it.
- `tokens_revoked`: after signature and exact App/Team verification, use the documented revoked Bot User list without
  requiring `authorizations`; move only that exact installation generation to `reauthorization_required` with
  `SLACK_TOKEN_REVOKED`.
- `app_uninstalled`: after signature and exact App/Team verification, accept the app-level uninstall signal without
  requiring a bot authorization; disable only that exact installation generation and erase its active credential material.
- lifecycle events do not establish identity closure or refresh runtime observation. Missing active installation, invalid
  signature, App/Team mismatch, or an authorization mismatch on an ordinary event is rejected with no observation or
  other side effect; no event is accepted as setup progress.

Configuration errors are explicit and leave active data unchanged:

- `SLACK_AUTH_INVALID`: Slack rejected the Bot Token.
- `SLACK_AUTH_IDENTITY_INCOMPLETE`: Slack accepted the submitted token but did not return an installed Bot identity (for
  example, a User Token); this is a deterministic 400 credential input error.
- `SLACK_UPSTREAM_UNAVAILABLE`: token inspection did not return usable installation facts.
- `SLACK_BINDING_IDENTITY_MISMATCH`: Slack returned an App ID different from the configured value.
- `SLACK_SCOPE_REAUTH_REQUIRED`: the token is missing one or more fixed scopes.
- `SLACK_CONFIGURATION_CONFLICT`: the route, installation, or generation changed since authorization started.
- `SLACK_OAUTH_FAILED`: the first-party Slack OAuth state is invalid, expired, replayed, or was cancelled.
- `SLACK_APP_TEAM_ALREADY_BOUND`: the App/Team installation is current for another OpenTag Agent.

## Migration and recovery

Earlier Slack-only cleanup remains in place: clear setup-attempt fields, clear historical Slack `observedConnectedAt`,
disable incomplete provisioning rows, mark scope-incomplete configured rows `reauthorization_required`, restore a
scope-complete legacy reauthorization row to active, drop `pending_receive_mode`, and keep Feishu setup fields intact.

The Agent-installation cutover then:

- moves Bot Token and Signing Secret from a current Slack route onto one Agent-owned installation and never copies those
  secrets onto additional Agent rows;
- prefers a structurally complete `active` candidate for the owning Agent; only if none exists does it take a
  structurally complete `reauthorization_required` row, then orders by `created_at` and `id`;
- makes that chosen row the default route and fail-closes any duplicate current Slack App/Team installation;
- leaves single-Agent Slack data lossless.

Reauthorization validates the proposed credential and locked current App/Team/Bot identity before touching the current
installation. An App ID mismatch therefore cannot become an implicit replacement when `auth.test` omits `app_id`.
Same-identity success advances the installation generation atomically and syncs sanitized snapshots onto routes. Slack
has no Change App or replace intent; disconnect ends the Agent route's Sessions without uninstalling the Slack
installation. Concurrent configuration is fenced by the expected route ID and generation plus database uniqueness
constraints. Runtime observations, identity closure, provider revocation, and provider disable are independently fenced
to the event's exact installation credential generation.

## First-party distributed OpenTag Slack App

When the server is configured with the first-party Slack App credentials, Agent management starts OAuth. The visible
Slack Bot is the single OpenTag App; OpenTag internal subagents are not installed as additional Slack Bots.

Required server environment variables, all or none:

- `OPENTAG_SLACK_CLIENT_ID`
- `OPENTAG_SLACK_CLIENT_SECRET`
- `OPENTAG_SLACK_SIGNING_SECRET`
- `OPENTAG_SLACK_REDIRECT_URL` — this server's public origin, or the exact callback URL
  `{OPENTAG_PUBLIC_URL}/api/v1/im-bindings/slack/oauth/callback`

Hosted environments require HTTPS. A partial set fails closed at process start. The callback origin must match
`OPENTAG_PUBLIC_URL`. Client secret, signing secret, OAuth codes, and tokens are never returned by management APIs or
written to logs. The signed OAuth state appears only inside the short-lived Slack authorization URL returned by the
start endpoint and is stripped from server request logs on callback.

Authenticated start `POST /api/v1/agents/:agentId/im-binding/slack/oauth/start` remains the management entry that selects
the default Agent route. It issues a signed state that includes a one-time nonce bound to the browser session cookie,
Account, Agent, intended action (`create` / `reauthorize`), and the expected binding generation. The public callback
exchanges the Slack code, inspects Bot identity and the actual `x-oauth-scopes`, and writes the Agent-owned installation
plus that Agent's explicit default route only after all sixteen fixed bot scopes and identity checks pass.
Same-installation reauthorization increments credential generation. Slack replace is not a valid OAuth intent. Replay,
expiry, session mismatch, and a different Agent claiming the same current App/Team installation fail without mutating
the current installation.

The version-controlled Public Distribution manifest is
[slack-public-distribution-manifest.yaml](./slack-public-distribution-manifest.yaml). Copy it into the Slack app
manifest editor and replace only the `https://YOUR_OPENTAG_ORIGIN` origin. Do not add scopes, App IDs, or secrets. Logo
assets are added later by the repository root and are not part of this template.

Operators must configure the OpenTag Slack App with:

- Bot display name **OpenTag**
- Redirect URL equal to `OPENTAG_SLACK_REDIRECT_URL`
- Events Request URL `{OPENTAG_PUBLIC_URL}/api/v1/im-bindings/slack/events` (signed HTTP, not Socket Mode)
- The same sixteen bot scopes and subscribed bot events as the checked-in Public Distribution manifest, including
  `app_uninstalled` and `tokens_revoked`

Identity-less Slack URL verification for that shared Request URL uses the first-party signing secret and records no
installation observation. After install, real events look up the active App/Team installation and verify HMAC with the
stored signing secret. Token rotation is not enabled; rotating tokens outside the active installation credential envelope
would require a later adapter-owned store.

One distributed App installation yields one Team/Bot identity owned by one Agent. V1 inbound delivery uses only that
Agent's unique default route and never broadcasts. Outbound access projects the Bot Token only to the owning Agent.
Signing secrets stay encrypted on the installation and are never projected to runtime.

Slack protocol references: [app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/),
[`auth.test`](https://docs.slack.dev/reference/methods/auth.test/),
[OAuth V2](https://docs.slack.dev/authentication/installing-with-oauth/),
[request signing](https://docs.slack.dev/authentication/verifying-requests-from-slack/), and
[`url_verification`](https://docs.slack.dev/reference/events/url_verification/).
