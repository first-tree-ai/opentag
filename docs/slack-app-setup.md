# Slack App configuration

[简体中文](./zh-CN/slack-app-setup.md)

OpenTag supports one customer-owned Slack App installation per Agent. Configuration is a single validated write, not a
temporary setup workflow. URL verification and inbound messages are runtime observations; neither creates, completes,
or activates a credential generation.

## Fixed Slack capability contract

Every generated manifest requests the complete capability set on the first connection and every later reauthorization
or replacement. `mention_only` and `all_message` use the same Slack installation.

Required bot scopes:

- `app_mentions:read`
- `channels:history`
- `chat:write`
- `files:read`
- `groups:history`
- `im:history`
- `mpim:history`

Subscribed bot events:

- `app_mention`
- `app_uninstalled`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`
- `tokens_revoked`

The manifest also enables a writable App Home Messages tab. Changing an Agent's `receiveMode` only updates OpenTag's
local admission policy. It does not change the manifest, rotate a credential generation, require reinstall or
reauthorization, retry the Request URL, or send a test message.

## Admin configuration flow

1. Open **Connect Slack App**, **Reauthorize Slack**, or **Change Slack App**. OpenTag returns a stateless guide containing
   the fixed manifest and the Agent-specific Events API Request URL. Reading or closing this guide writes nothing.
2. Create or update the customer-owned App from the complete manifest and install or reinstall it in the intended Slack
   workspace.
3. Copy the **App ID** and **Signing Secret** from **Basic Information**, and the **Bot User OAuth Token** from
   **OAuth & Permissions**.
4. Submit all three values once. OpenTag calls Slack `auth.test`, obtains the token's Team, Bot User, Bot identity,
   Enterprise when present, and actual `x-oauth-scopes`, and requires all seven scopes. If Slack returns an App ID, it
   must match the submitted App ID.
5. OpenTag locks the Agent's current binding, rechecks Team authority and the expected binding generation, and atomically
   writes the active identity, encrypted credentials, complete grants, and new generation. Validation failure or a stale
   expected generation leaves the current binding unchanged.
6. After the write succeeds, set or retry the generated Request URL in Slack if necessary. A real message is not part of
   configuration acceptance.

Slack does not guarantee `app_id` in `auth.test` for a Bot Token. The submitted App ID is therefore stored and projected
as **configured evidence**, not as Slack API-attested identity. Every request still has an independent proof boundary.
The Agent-specific Request URL looks up the active binding by Agent ID and verifies the timestamped HMAC over the raw
body **before** parsing JSON. The compatibility Events URL may bounded-preparse only App and Team identifiers to locate
the Signing Secret, then verifies the same raw-body HMAC.
After a valid signature, every real event envelope's `api_app_id` and `team_id` must match the configured App ID and
token-derived Team ID. A mismatch is rejected and never repairs configuration. Slack's official URL-verification payload
contains no App or Team fields, so the Agent-specific URL can verify only the bound Signing Secret for that challenge;
it records no identity proof.

## Data and state inventory

| Item | Disposition | Source of truth and meaning |
| --- | --- | --- |
| Binding `id`, Agent, Team, provider, status | Keep | One current non-disabled IM binding per Agent; one current Slack App/Team installation per Agent binding. |
| App, Team, Enterprise, Bot User/Bot identity | Keep | App ID is explicit configured evidence; Team and bot identity come from token inspection; Enterprise is optional. |
| Team and Bot display metadata | Keep as optional presentation data | Team name, Bot display name, and avatar may be shown to administrators, but never authorize configuration, ingress, or runtime access. |
| Bot Token and Signing Secret | Keep encrypted | Stored together in the active credential envelope; never returned by admin, diagnostics, or runtime-config APIs. The Signing Secret is never projected to runtime. |
| `credentialGeneration` and credential schema version | Keep | Monotonic same-binding credential revision. Same-identity reauthorization increments it; App/Team replacement creates a new binding identity and disables the old one. |
| `grantedCapabilities` | Keep | Actual token scopes reported by Slack. Active/readiness projections require all seven fixed scopes. |
| `activatedAt`, `disabledAt`, `createdAt`, `updatedAt` | Keep | Durable binding lifecycle timestamps. Configuration submission sets activation; inbound events do not. Public APIs project `activatedAt` as `lastValidatedAt`. |
| `observedAt` | Keep as runtime observation | Updated after a correctly signed Agent-specific URL challenge, or after a correctly signed App/Team-matching real event. Public APIs project it as `lastRuntimeObservationAt`. It is not configuration evidence and does not change generation. |
| `lastInboundAt` and normalized `ImMessage`/Session state | Keep | Message runtime history and routing state. Only admitted inbound messages update it. URL verification does not. |
| `lastConfirmedAt` | Delete from public APIs | It mixed configuration time with runtime observation. Use `lastValidatedAt` and `lastRuntimeObservationAt`. |
| `lastErrorCode` | Keep | Durable recovery cause such as `SLACK_SCOPE_REAUTH_REQUIRED` or `SLACK_TOKEN_REVOKED`; observations do not clear configuration errors. |
| `receiveMode` on the Agent | Keep | Local `mention_only`/`all_message` policy, independent of Slack authorization and credential generation. |
| `replacementImBindingId` | Keep as cutover provenance | Links a disabled binding to the replacement created during an App/Team identity change. It is not setup progress and is used by both Slack and Feishu replacement flows. |
| Connection owner, lease, and fencing fields | Keep generically | Feishu connection ownership only. Slack has no managed connection lease and these fields stay empty. |
| Generic setup attempt/context fields | Keep for Feishu | `setupAttemptId`, setup intent/state/owner/heartbeat/expiry, and encrypted setup context remain for Feishu. Slack rows are database-checked so those setup fields stay null. |
| Slack setup attempt, encrypted temporary context, challenge proof, verification error/time, polling/expiry/cancel state | Delete | No Slack configuration phase exists between token validation and activation. |
| `pendingReceiveMode` / `pending_receive_mode` | Delete | There is no Slack-dependent receive-mode target. |

Derived values are not new durable states:

- binding health is derived from status plus currently readable, schema-valid, identity-consistent, and scope-complete credential material;
- unreadable, schema-invalid, identity-inconsistent, or scope-inconsistent current credentials fail closed: they are never projected as ready, and Slack ingress lookups return unavailable instead of throwing raw credential errors;
- `reauthorizationRequired` is derived from binding status, missing fixed scopes, or invalid current credential material;
- diagnostics report the exact `credentialGeneration` (including `0`), `credentialStatus` `valid` or `invalid`, and required/granted/missing capabilities;
- a structurally invalid credential with no more specific stored failure projects `IM_BINDING_CREDENTIAL_INVALID`; an
  actual fixed-scope gap continues to project `SLACK_SCOPE_REAUTH_REQUIRED`;
- `lastValidatedAt` is the current credential validation/activation timestamp; `lastRuntimeObservationAt` is the latest signed provider runtime observation; `lastInboundAt` remains message history;
- App ID evidence is always labeled `configured`, with signed-ingress matching required.

### Durable and derived state matrix

| State | Slack meaning after migration | Allowed transition source |
| --- | --- | --- |
| `provisioning` | Not a normal Slack state. An incomplete legacy Slack row is disabled by migration; new configuration writes `active` directly. | Feishu setup only. |
| `active` | A credential generation was committed. Public state may still derive `reauthorization_required` when the current material is unreadable, structurally inconsistent, or missing a fixed scope. | Successful validated configuration or same-identity reauthorization. |
| `reauthorization_required` | The current installation must be replaced or reauthorized. Existing material is never reported healthy when the scope contract or credential inspection fails. | Scope migration, `tokens_revoked`, or an explicit recovery write. |
| `error` | Generic retained state for non-Slack setup/runtime failures; Slack configuration validation errors are returned without mutating the current row. | Non-Slack provider workflows or existing generic recovery code. |
| `disabled` | Terminal for that binding identity. Active credential and setup secrets are erased, Sessions are ended, and a later configuration creates or selects another current binding. | Admin disable, `app_uninstalled`, incomplete legacy Slack cleanup, or identity replacement cutover. |

`bindingState`, `ready`, `handoffReady`, `reauthorizationRequired`, `credentialStatus`, and missing capabilities are
projections, not additional database states. URL verification and signed inbound traffic can update only runtime
observations and message/routing records. `receiveMode` changes only Agent policy. A same-identity credential commit
increments `credentialGeneration`; an App/Team identity replacement starts generation `1` on the new binding and
records the replacement link on the disabled old binding.

## Ingress, events, and errors

The generated Agent-specific Request URL and the compatibility Slack Events URL accept only an already-active, fully
scoped binding whose current credential material is readable and valid. The Agent-specific URL verifies the raw-body
signature before JSON parsing. The compatibility URL may bounded-preparse App/Team solely for secret lookup. Both then
require every real event's App ID and Team ID before recording `observedAt` or processing it. Only the Agent-specific
URL can route Slack's identity-less URL challenge. Signing secrets never enter runtime grants, diagnostics, logs, or
traces.

- `url_verification`: on the Agent-specific URL, verify the bound Signing Secret, return the challenge, and record a
  runtime observation; the Slack payload has no App/Team identity, and the request does not activate, rotate, or repair
  anything.
- `app_mention` and message events: normalize and ingest under the verified binding generation; do not change it.
- `tokens_revoked`: move the affected current binding to `reauthorization_required` with `SLACK_TOKEN_REVOKED`.
- `app_uninstalled`: disable the binding and erase its active credential material.
- missing active binding, invalid signature, or App/Team mismatch: reject; never accept an event as setup progress.

Configuration errors are explicit and leave active data unchanged:

- `SLACK_AUTH_INVALID`: Slack rejected the Bot Token.
- `SLACK_UPSTREAM_UNAVAILABLE`: token inspection did not return usable installation facts.
- `SLACK_BINDING_IDENTITY_MISMATCH`: Slack returned an App ID different from the configured value.
- `SLACK_SCOPE_REAUTH_REQUIRED`: the token is missing one or more fixed scopes.
- `SLACK_CONFIGURATION_CONFLICT`: the binding or generation changed since the form was opened.
- `SLACK_APP_TEAM_ALREADY_BOUND`: the App/Team installation is current for another Agent.

## Migration and recovery

The migration is scoped to Slack rows:

- clear every Slack setup-attempt and encrypted setup-context field;
- disable incomplete Slack provisioning rows that never had an active credential generation, erase any credential and
  connection ownership material, and record `SLACK_CONFIGURATION_REQUIRED`;
- mark configured Slack bindings missing any of the seven scopes as `reauthorization_required` and never project them as
  healthy;
- restore a legacy scope-only reauthorization row to active when it already has the complete fixed scope set;
- drop `pending_receive_mode`;
- add a Slack-only database check that generic setup fields remain null;
- leave Feishu setup fields and behavior intact.

Reauthorization validates the proposed credential before touching the current binding. Same-identity success advances
the generation atomically. A different App/Team installation creates the replacement and disables the previous binding
only at cutover; its sessions are then stopped. Concurrent configuration is fenced by the expected binding ID and
generation plus database uniqueness constraints.

## Future distributed App adapter

The current product mode is a customer-managed Slack App per Agent. A later distributed OpenTag App would be a separate
adapter behind the same verified Integration activation boundary. That future adapter is documentation-only today: this
release does not add OAuth setup state, placeholder tables, or token-exchange persistence.

If that adapter is introduced, OAuth state must be signed and bound to a one-time nonce, browser session, Admin, Agent,
Team, and configuration intent. The installation store and token rotation belong to that adapter, not to the active
binding. Actual Slack-reported scopes still gate activation. Until then, administrators submit App ID, Bot Token, and
Signing Secret in one validated write.

One distributed App installation yields one Team/Bot identity. Supporting several OpenTag Agents in the same Slack
workspace would therefore require a separate workspace-installation aggregate and explicit Agent routing; it must not
silently reuse the current unique App/Team-to-Agent binding invariant.

Slack protocol references: [app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/),
[`auth.test`](https://docs.slack.dev/reference/methods/auth.test/),
[request signing](https://docs.slack.dev/authentication/verifying-requests-from-slack/), and
[`url_verification`](https://docs.slack.dev/reference/events/url_verification/).
