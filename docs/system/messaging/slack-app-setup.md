---
title: "Slack App connections"
description: "Slack App/Team/Bot ownership per Agent, installation types, capabilities, and operating instructions."
---

# Slack App connections

openTag supports one current Slack App/Team/Bot installation per Agent and one owning Agent per App/Team pair.
New Web connections create a separate Slack App for each Agent in the same workspace. Existing distributed **@openTag** bindings keep their OAuth recovery.
Both installation types reuse the existing Agent-owned installation, encrypted credentials and default route. Creating an Agent
never requires a messaging app; choose **Set up later** and connect it from Messaging settings when needed.

A current Slack App/Team installation is never silently shared or transferred to another Agent. A different Agent
claiming the same App/Team returns `SLACK_APP_TEAM_ALREADY_BOUND` without side effects. The owning Agent may
reauthorize the same installation. Transfer is an explicit remove/uninstall followed by a fresh installation: the old
row keeps its historical Agent owner and becomes disabled, while the new Agent receives a new current row. URL
verification and inbound messages are runtime observations; neither creates, completes, or activates a credential
generation. Production Events API remains signed HTTP and includes `app_uninstalled` and `tokens_revoked`. Socket Mode
is not used.

## Automatically create and connect your own App

In Agent creation or Messaging settings, choose **Connect Slack**. Agent setup presents the command/code form inline; Messaging settings keep the shared dialog. Both use an online Local Computer with a current Client. Cloud Agents open manual setup directly. Switching methods preserves the current ticket without issuing another one; leaving the manual form clears its credentials.

On a supported Local Computer:

The new App and Bot use the Agent's `name`, rather than its separate `displayName`, with existing Slack name validation
and length limits. No random suffix is added, and this entry does not rename existing Apps.

1. Paste the generated `/slackauthticket …` command into any channel or DM message composer in the target Slack workspace and send it. Review the official CLI's
   management permissions, and confirm. Slack may be on another device; there is no localhost browser callback.
2. Copy the challenge code from the confirmation modal in Slack, paste it into openTag and select **Connect**.
3. openTag creates and installs the fixed App manifest, saves the Bot Token and Signing Secret through existing
   encrypted storage, and configures Events API and Interactivity. Send the Bot a DM and confirm its reply to verify actual delivery.

The UI distinguishes saved authorization, verified App identity and Agent readiness.
An identity-only result does not display connected. The setup response does not prove
that an outbound reply arrived; the message/reply check remains a user verification.
The command instructions follow the [Slack CLI authorization guide](https://docs.slack.dev/tools/slack-cli/guides/authorizing-the-slack-cli/).

Invalid or expired challenge codes share the Server's `authorization_failed` result;
the UI describes those as possible causes and offers a fresh ticket through explicit
Reauthorize. Slow requests remain single-flight. A network/gateway failure is an
uncertain result, with explicit Retry preserving the current operation. `computer_unavailable`
can also mean the existing runtime request timed out; it is not presented as proof
that credentials were rejected. Manual setup remains available.

The Computer prepares the official Slack CLI through existing Provider CLI installation when necessary. Web uses the
current Account session and checks Agent ownership; it receives neither Slack credentials nor an Account Token for the
Computer. The CLI management grant remains in its native private config and uses native refresh. Only authorize a ticket
from your own selected Computer. This grant covers App management for the workspace, not just this one App.

If workspace policy requires approval, the official CLI submits the install request automatically. openTag shows
a pending request only after Slack confirms it exists, with its App and workspace identifiers
and a link to that workspace's app management. Select **Requests to install** there; Workspace Owners and designated App
Managers can review requests, while Workspace Admin alone does not grant this permission. Organization policies may
require an organization app manager. After approval, **Continue** installs and binds the same App. Pending or
denied requests do not start another install, cancel the request, or create another App. If Slack confirms the current
account can install without another person's approval, a historical request does not block installation.

Approval-aware setup negotiates the existing optional `runtime.slackAutoSetup` capability at version 2. Deploy the
matching Server/Web and update the Client; a version-1 peer keeps the Computer connected and uses manual Slack setup.

Other installation failures do not imply approval is required. openTag shows a safe Slack error code when available;
check the native CLI debug log under `<openTag home>/slack-management/config/logs/` for details. A failed network request
can leave deploy stdout empty. Continuing re-links the same private project with `--force` before retrying installation,
so an existing local link does not block recovery with `app_found`. No raw CLI error text or credentials are sent to Web.

Failed callback configuration also resumes through **Continue**, without another installation or credential
rotation. An
uncertain creation is stopped: inspect Slack's existing Apps and use manual binding rather than create another copy.
Documented pre-creation rejections (such as invalid manifests, App limits, or rate limits) allow a retry; partial or unknown
errors remain fenced. Expiring or revoked management authorization can require a new ticket. A busy response means the
Computer is still working: wait and continue with the same App. There is no background job or progress-polling service.
Private per-Agent CLI project files retain the App ID for recovery. Captured installation credentials and CLI stderr/login
output are removed when each operation finishes, including failures. The private creation Signing Secret is needed for
same-App recovery until Server saves the encrypted binding; the existing callback request acknowledges that save and
removes the creation secret after checking the saved App ID and Team, before configuring callbacks. Official OAuth Apps
cannot enter this management flow. Other existing Apps without a matching local creation record use manual configuration;
the Client does not authorize or modify their callbacks. If an automatically connected App is later disconnected, its
local creation credentials have already been removed: reconnect it through the manual entry, rather than repeat a deploy
or create another App. No extra acknowledgement request is needed. The CLI resolves its capture-hook entry beside the
current bundle, supporting npm and portable layouts without package self-resolution. A missing or unusable entry only
disables automatic Slack setup, and does not prevent daemon startup. Other Client embeddings without that entry use manual setup before creating
an App. There is no new table or database field. Cloud Agents open **Manual setup** directly; offline Computers and older Clients can also use it, which
keeps the existing two-field binding and credential update flow. Public OAuth remains available.

## Local Agent approvals

Enable Interactivity with request URL `{OPENTAG_PUBLIC_URL}/api/v1/im-bindings/slack/interactions`.
The distribution manifest includes this setting. Local Agents send approval buttons in a private
message to the task sender, who can approve or deny the pending action.
See [Agent permissions](../runtime/agent-permissions.md) for setup and allowed-command settings.

## Bot avatars

Installation and reconnection read the installed Bot User profile through `users.info` using
the existing `users:read` scope. openTag caches the shared Slack bot avatar on the installation
and propagates it to associated bindings. It does not customize avatars per Agent or per message.
Profile-fetch failure is nonfatal; cached metadata is retained only for the same provider identity.
Existing installations acquire an avatar on reconnection. Later Slack-side changes remain cached
until the next reconnection, and missing or failed images fall back to initials in openTag.

## Native working indicator

openTag uses [`assistant.threads.setStatus`](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/)
with `status: "is working"` and clears it with `status: ""`. Slack supplies the App name and native animation.
The existing bot scope `chat:write` is sufficient following Slack's
[scope update](https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/); the fixed manifest does not change.
This does not enable Agent sessions or request `assistant:write`.

The indicator represents active execution for the installed bot in a specific Slack thread:

| Execution state | Indicator |
| --- | --- |
| Webhook received, queued, delivery accepted, credentials preparing | Hidden |
| Local provider `run_started`, or Cloud worker invocation after verification | `openTag is working` |
| Running model/tool work, including concurrent turns for the same bot/thread | Visible while at least one live turn remains |
| Waiting for user, completion, failure, cancellation, timeout, reporting | Cleared when no other live turn remains |
| Observer delivery, Feishu, Web, Session-to-Session message | Hidden |

The target is `providerRef.channelId` and `providerRef.threadTs ?? providerRef.messageTs`, matching the inbound
reply thread. Slack shows the installed App identity, not an internal subagent identity. A root DM may open a thread.
The current providers finish their turn when asking the user for input; no waiting state is inferred from prose.

Execution heartbeats arrive every 30 seconds and lease liveness for at most 90 seconds, bounded by the delivery
execution deadline. An explicit deadline is used without adding the default duration cap; duration budgets begin
at the first execution observation and are never extended by heartbeats. Only a new sequence extends the lease.
The server refreshes Slack at 45-second intervals;
a confirmed same-thread provider reply schedules an immediate refresh because Slack automatically clears on replies.
An execution that disconnects without a terminal signal expires; the next worker pass clears it (up to 45 additional
seconds under normal availability). A terminal Turn Report commits cleanup in the custody transaction.
A later live heartbeat wakes a cleared target. Each installation/thread has one stable target across credential
rotations. Claiming refreshes its credential fence from the current installation, so sibling turns stay aggregated
and terminal cleanup can use renewed credentials without replaying liveness. Activity and terminal cleanup share
a transaction mutex before locking targets or turns. Successfully cleared targets are retired once delivery retention
removes all referencing turns.

The persisted outbox survives Server restarts, aggregates concurrent turns, and serializes each target across workers.
A provider request, including response-body consumption, has a 3-second deadline, no hidden transport retry,
and at most four transient failures per target activation. Shared-circuit waits do not consume that retry budget.
HTTP 200 with `ok: false` is failure; installation-specific errors do not open the shared transport circuit.
HTTP 5xx responses count toward that circuit, allowing shared outage protection and recovery.
HTTP 429 persists `Retry-After` for every thread of the installation, including new targets and restarted workers;
completion cannot bypass this cooldown. Rate-limit waits do not consume the transient retry budget.
Authorization errors disable that target. Immediately before a provider call, ownership requires the installation
to remain active at the claim's credential generation. Settlement locks and rechecks that installation before
writing target state or cooldowns, so responses from a prior generation cannot affect the new generation.
A request already admitted before rotation may still finish at Slack; its stale response is discarded locally.
If explicit clearing cannot reach Slack, Slack's native inactivity timeout remains the final fallback.
Status failures never change the Turn result.

Local clients negotiate optional `runtime.turnActivity: 1`. Cloud Runners request `turnActivityVersion: 1` in auth and
require the same welcome echo. Deploy the Server and migration before a new Runner image: the existing strict Cloud
auth schema on an old Server rejects unknown fields. Older peers that do not negotiate activity keep existing behavior.

Local automated coverage includes real PostgreSQL migrations/outbox behavior and mocked Slack HTTP; it is not live
Slack visual acceptance. See [Slack live acceptance](https://github.com/first-tree-ai/opentag/blob/main/testing/slack-live-acceptance.md) before claiming a deployed result.

## Fixed Slack capability contract

The first-party openTag Slack App requests the complete capability set on the first connection and every later
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
- `im:read`
- `im:write`
- `mpim:history`
- `mpim:read`
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

The manifest also enables a writable App Home Messages tab. Changing an Agent's `receiveMode` only updates openTag's
local admission policy. It does not change the manifest, rotate an installation credential generation, require reinstall
or reauthorization, retry the Request URL, or send a test message. `assistant:write` is not part of the V1 capability
contract; it may be considered later as an optional extra and must not be added to the current installation.

The Agent may discover, read, and write another conversation when it is relevant to its current task even if the user did
not name that conversation. It may join a public channel once when the task requires access, but must not roam through,
bulk-join, or inspect task-unrelated conversations. Joining intentionally enrolls future messages from that channel in
normal openTag ingress: every admitted inbound message is persisted first, then `mention_only` or `all_message` controls
delivery. Private channels and MPIMs still require an invitation. The Agent may discover existing DMs and MPIMs, but
`conversations.open` is limited to exactly one user ID for a one-to-one DM; V1 does not promise creation of a new MPIM.

A credential-free local live acceptance checklist for a separately registered test Team/App is in
[slack-live-acceptance.md](https://github.com/first-tree-ai/opentag/blob/main/testing/slack-live-acceptance.md).

Web shows one primary action for the current state. Installation failures retry the same App; only an authorization failure offers reauthorization. Confirmed pending requests offer **View approval** and secondary **Continue**. A denied request or uncertain creation never offers a new-App retry. App/Team IDs and safe error codes are in **Diagnostics**.

A saved callback is **Unverified** until a real signed event closes identity. Slack connection and Agent runtime preparation remain separate: a verified Slack binding can show **Preparing the Agent…**. Reopening setup uses a neutral message-verification prompt instead of inferring manual configuration from missing page-local state.

## Agent configuration flow

Connect a Computer before configuring Slack. The creation guide and Messaging settings share **Connect Slack**, including on servers without first-party Slack OAuth.

### Manual setup

1. Choose **Connect Slack**, then **Manual setup** and **Create App**. Select the intended workspace. The creation link
   prefills one complete Manifest: eighteen bot scopes, seven bot events, this Agent's Events Request URL, writable
   Messages tab and the existing Interactivity endpoint for local approvals. Create the App and install it in that workspace.
   The Bot uses the Agent name within [Slack's naming rules](https://docs.slack.dev/reference/app-manifest/): lowercase
   letters, digits, `.`, `_` and `-`, up to 80 characters. The form shows the exact prefilled `@name`; other characters
   become `-`, and names without usable characters or the reserved `slackbot` name fall back to `opentag-<short Agent ID>`.
   Existing Apps are not renamed. If creation stalls, check **Your Apps** before retrying. If the App already exists,
   finish **OAuth & Permissions → Install to workspace**. If Slack asks you to wait, retry later without creating a copy.
2. Copy **Bot User OAuth Token** from **OAuth & Permissions** and **Signing Secret** from **Basic Information → App
   Credentials** into openTag. These are the only two inputs; no App ID or policy selection is needed.
3. Choose **Save** once. openTag checks `auth.test`, actual `x-oauth-scopes` and `bots.info` to identify
   the App, Team, Bot User and Bot. It then atomically saves the existing encrypted installation and default route under
   the expected binding/generation. No configuration-method field, Bot policy field, table or migration is added.
4. In Slack's **Event Subscriptions**, choose **Retry** if the Request URL is not verified. Once **Verified** appears,
   choose **Save Changes**, then **Open chat** in openTag and send a direct message. Already verified and
   saved settings need no repeat verification. A URL challenge only verifies the Signing Secret. A matching signed event closes identity; runtime
   handoff must also succeed before the page reports ready. Saving credentials or opening Slack alone never reports ready.

The full Manifest is for a new App. For an existing App, add the displayed URL/events without overwriting its other
settings; reinstall if scopes changed. Credential updates accept only changed fields, preserve blank fields and require
at least one change. **Update credentials** is directly available in the App dialog; expand **Update Signing Secret**
only when needed. After saving, send a Bot DM. An unchanged, saved Events URL needs no repeat verification or Save Changes;
connection help remains available if the Bot does not reply. Updates preserve App, Team, Bot User and Bot ID, binding
identity, history and Agent `receiveMode`.
A stale generation or different identity is rejected. Failed validation retains the form for correction; an uncertain
save reads current state before any retry and never automatically posts twice. Closing, success or changing Agent clears
credential inputs. Neither management response returns saved credentials.

The App/Team pair cannot be claimed by another Agent. Create another App in the same Team instead. Message triggers
remain the Agent's existing `mention_only` / `all_message` property, including other Bots' messages. Ambient Turns may
remain silent; existing self-message filtering and event deduplication are unchanged.

### Distributed openTag App

The current Web offers the first-party OAuth recovery entry when the Server has OAuth configured and the existing
binding's derived recovery preference selects OAuth. That preference compares the saved Signing Secret with the current
official configuration and stores no provenance. Manual credential recovery preserves App, Team, Bot User and Bot ID;
it remains available if official configuration rotates.

The existing OAuth start/callback API also retains compatibility with older clients. Its `create` and `reauthorize`
intents preserve session/Account authority, nonce, expected binding/generation and installation checks; there is no
`replace` intent. A compatible OAuth `reauthorize` callback with a different App/Team/Bot identity atomically disables the
old installation and route, ends their active Sessions, creates the replacement installation and route at generation 1,
and links the disabled records to their replacements. Same-identity reauthorization keeps the route and advances its
installation generation. This compatibility behavior does not add a replace-App action to the current Web.

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

### Atomic provider lifecycle updates

URL observations, identity closure, token revocation and provider uninstall acquire the current Slack route before
updating its installation. The route guard uses `FOR NO KEY UPDATE`, which remains compatible with Session foreign-key
checks. Shared teardown orders its writes as binding, installation, then Session termination. Installation/route
status, generation and observation changes still commit atomically, and stale generations retain their original
no-change result. Provider revocation and uninstall continue to work for suspended Agents.

These transactions cover database work only. OAuth redirects, external credential inspection, ticket/challenge user
actions and pending workspace approval do not retain their database locks. A later continuation revalidates current
authority and binding/generation before committing configuration.

## Data and state inventory

| Item | Disposition | Source of truth and meaning |
| --- | --- | --- |
| Binding `id`, Agent, Team, provider, status | Keep as Agent route | One current non-disabled IM binding per Agent. Slack rows are routes to that Agent's installation (`slackInstallationId`, `slackRouteKind`) and never store Bot Token or Signing Secret. |
| Slack Team installation | Keep | One current App/Team/Bot identity, owning Agent, encrypted credentials, grants, generation, and identity-closure/lifecycle per App/Team pair. |
| App, Team, Enterprise, Bot User/Bot identity | Keep | App ID is explicit configured evidence; Team and bot identity come from token inspection; Enterprise is optional. |
| Team and Bot display metadata | Keep as optional presentation data | Team name, Bot display name, and avatar may be shown in management views, but never authorize configuration, ingress, or runtime access. |
| Bot Token and Signing Secret | Keep encrypted on the installation | Stored together in the installation credential envelope; never copied onto Agent routes and never returned by management, diagnostics, or runtime-config APIs. The Signing Secret is never projected to runtime. |
| `credentialGeneration` and credential schema version | Keep on the installation | Installation-authoritative monotonic credential revision. Routes sync a sanitized snapshot for Session fencing and diagnostics. Same-identity reauthorization increments the installation generation. Compatible OAuth reauthorization with a different identity retains disabled history and creates replacement records at generation 1. |
| `grantedCapabilities` | Keep on the installation | Actual token scopes reported by Slack. Routes sync a sanitized snapshot. Active/readiness projections require all eighteen fixed scopes. |
| `activatedAt`, `disabledAt`, `createdAt`, `updatedAt` | Keep | Durable installation lifecycle timestamps, with sanitized copies on Slack routes. Configuration submission sets activation; inbound events do not. Public APIs project `activatedAt` as `lastValidatedAt`. |
| `observedAt` | Keep as runtime observation | Installation-authoritative. Updated after a correctly signed Agent-specific URL challenge, or after a correctly signed real event whose App, Team, and bot authorization match. Routes sync the sanitized timestamp. Public APIs project it as `lastRuntimeObservationAt`. It is not configuration evidence and does not change generation. |
| `observedConnectedAt` | Keep as generation identity closure | Installation-authoritative. For Slack, records when a signed real event's `authorizations` first closed the configured App/Team to the token-derived Bot User for the current installation generation. Later matching events preserve this first timestamp and refresh only `observedAt`. Configuration resets it; URL verification never sets it. Feishu retains its existing connection-observation meaning. |
| `lastInboundAt` and normalized `ImMessage`/Session state | Keep | Message runtime history and routing state. Only admitted inbound messages update it. URL verification does not. |
| `lastConfirmedAt` | Delete from public APIs | It mixed configuration time with runtime observation. Use `lastValidatedAt` and `lastRuntimeObservationAt`. |
| `lastErrorCode` | Keep | Durable recovery cause such as `SLACK_SCOPE_REAUTH_REQUIRED` or `SLACK_TOKEN_REVOKED`; observations do not clear configuration errors. |
| `receiveMode` on the Agent | Keep | Local `mention_only`/`all_message` policy, independent of Slack authorization and credential generation. |
| `replacementImBindingId` | Keep as cutover provenance | Links a disabled route to its replacement, including a Feishu Bot identity change and compatible Slack OAuth identity replacement. It is not setup progress. |
| `replacementSlackInstallationId` | Keep as installation provenance | Links a disabled Slack installation to its successor when activation releases an unused same-Agent installation or compatible OAuth reauthorization replaces its identity. It is not a configuration phase or a public replace intent. |
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
| `provisioning` | Not a normal Slack state. An incomplete legacy Slack row is disabled by migration; new configuration writes `active` directly. | Feishu first-time setup, which disables the row when the attempt ends without activating. Rows earlier binaries left behind are released by `0068_release_terminal_setup_slots` and by Slack's own configuration write. |
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
- `SLACK_APP_TEAM_ALREADY_BOUND`: the App/Team installation is current for another openTag Agent.

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
Manual credential updates require the same identity. Same-identity success advances the installation generation atomically
and syncs sanitized snapshots onto routes. OAuth retains its explicit existing reauthorization behavior; disconnect ends the Agent route's Sessions without uninstalling the Slack
installation. Concurrent configuration is fenced by the expected route ID and generation plus database uniqueness
constraints. Runtime observations, identity closure, provider revocation, and provider disable are independently fenced
to the event's exact installation credential generation.

## First-party distributed openTag Slack App

First-party OAuth remains available only as recovery for an existing official binding in the Web UI. Dedicated Apps do not offer replacement with the official App. The existing start/callback APIs remain compatible with older clients; removing their create contract is outside this change.

When the server is configured with the first-party Slack App credentials, legacy management can start OAuth. The visible
Slack Bot is the single openTag App; openTag internal subagents are not installed as additional Slack Bots.

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
plus that Agent's explicit default route only after all eighteen fixed bot scopes and identity checks pass.
Same-installation reauthorization increments credential generation. Slack replace is not a valid OAuth intent. Replay,
expiry, session mismatch, and a different Agent claiming the same current App/Team installation fail without mutating
the current installation.

The version-controlled Public Distribution manifest is
[slack-public-distribution-manifest.yaml](../../slack-public-distribution-manifest.yaml). Copy it into the Slack app
manifest editor and replace only the `https://YOUR_OPENTAG_ORIGIN` origin. Do not add scopes, App IDs, or secrets. Logo
assets are added later by the repository root and are not part of this template.

Operators must configure the openTag Slack App with:

- Bot display name **openTag**
- Redirect URL equal to `OPENTAG_SLACK_REDIRECT_URL`
- Events Request URL `{OPENTAG_PUBLIC_URL}/api/v1/im-bindings/slack/events` (signed HTTP, not Socket Mode)
- The same eighteen bot scopes and subscribed bot events as the checked-in Public Distribution manifest, including
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
