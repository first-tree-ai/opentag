# Slack App setup

[简体中文](./zh-CN/slack-app-setup.md)

OpenTag supports a customer-owned Slack App for each Agent. A shared OpenTag App is not supported in this flow: each
Agent keeps a distinct bot identity, credential generation, message boundary, and recovery lifecycle, even when several
Agents join the same Slack workspace or channel.

## Product contract

An Agent can have at most one current IM binding. A Slack setup attempt has one explicit intent:

- `create` provisions the first Slack binding.
- `reauthorize` rotates credentials or adds scopes for the current App, Team, and Bot User identity. The current binding
  remains usable until the replacement credentials pass validation.
- `replace` switches to a different Slack App installation. Activation ends sessions owned by the previous binding.

OpenTag generates an Agent-specific Slack App manifest and Events API Request URL. The manifest requests only the bot
scopes and events required by the Agent's current receive mode or a server-recorded pending receive-mode target. It also
enables a writable App Home Messages tab so a user can start a direct-message conversation with the Agent.

## Admin flow

1. In the Agent's **IM** page, choose **Connect Slack App**, **Reauthorize Slack**, or **Replace Slack App**. A
   provisioning binding (a setup that was started earlier, for example before a page refresh) shows **Resume Slack
   setup** instead. Merely opening or refreshing the page never calls the mutating setup endpoint. The Admin must
   explicitly choose **Resume Slack setup**; it returns the in-flight attempt when one remains active and starts a
   successor only when the previous attempt is terminal.
2. Prepare the App for the chosen intent. OpenTag shows the generated manifest both as a create-new-App link and as
   copyable JSON:
   - **Connect** and **Replace** create a dedicated new App from the manifest and install it to the intended workspace.
   - **Reauthorize** keeps the same App, workspace, and bot user: open the existing App's **App Manifest** page, replace
     the manifest with the generated JSON, save, then choose **Reinstall to Workspace** under **OAuth & Permissions** so
     Slack grants any added scopes. The Bot User OAuth Token may change after reinstalling; the Signing Secret normally
     does not. The live binding keeps receiving throughout.
3. Copy the **Bot User OAuth Token** from **OAuth & Permissions** and the **Signing Secret** from **Basic Information**
   into OpenTag.
4. OpenTag calls Slack's `auth.test` endpoint and derives the Team ID, Enterprise ID when present, Bot User ID, Bot ID,
   and the token's actual `x-oauth-scopes`. Slack may omit `app_id` for a valid bot token, so the validated-installation
   panel identifies the workspace and bot user and names the App only once it is known; a browser-supplied App ID or
   scope list is never authoritative. The call is bounded by a timeout and reported as `SLACK_UPSTREAM_UNAVAILABLE`
   when Slack does not answer.
5. Return to **Event Subscriptions** and retry the generated Request URL. OpenTag verifies Slack's timestamped HMAC
   signature before returning the URL-verification challenge. The IM page distinguishes the two proofs: the Bot Token
   is validated as soon as `auth.test` succeeds (the derived App, workspace, and bot user are shown), while the Signing
   Secret stays unverified until Slack's URL verification succeeds.
6. Invite the bot to a test channel and mention it. OpenTag reparses the signature-verified raw event and establishes the
   App ID from its `api_app_id` only when the envelope App and Team match the routed App and token-derived Team, and a bot
   authorization matches the token-derived Team and Bot User. If `auth.test` did return an App ID, it must also match.
   That event is then admitted through the active binding.

Slack can attempt URL verification as soon as the manifest is created, before OpenTag has the Signing Secret. A failed
initial attempt is expected; retry it after submitting the credentials.

Slack sends `url_verification` only when the Request URL is set or changed, or when the admin clicks **Retry** in
**Event Subscriptions**. Updating event subscriptions through `apps.manifest.update` does not trigger it, and OpenTag
cannot trigger it on the admin's behalf: the **Retry** click is the supported step. Until it happens, the attempt stays
at "Signing Secret not yet verified". Reauthorization events continue through the active binding; for a first-time
setup with no active binding, a correctly signed event is acknowledged (`200`, pending) without activation or ingestion.

### Recovering a pending attempt

- A wrong Signing Secret does not fail the attempt. The failed URL verification is recorded on the attempt as a
  non-secret diagnostic (`SLACK_SIGNING_SECRET_INVALID` plus its time) and the IM page shows it. Choose **Edit
  credentials** to submit a corrected token and secret to the same attempt: OpenTag re-runs `auth.test`, replaces both
  secrets atomically, and restarts URL verification. Submitted secrets are never echoed back.
- **Cancel setup** ends an attempt at any time and remains terminal across navigation or refresh. Only an explicit
  **Resume Slack setup** or retry action may create its successor. A different intent cannot start while an attempt is
  active (`SLACK_SETUP_INTENT_CONFLICT`); cancel the current one first. Starting the same intent again returns the
  in-flight attempt.
- An attempt expires 30 minutes after it starts. Credentials submitted or URL verifications received after the deadline
  are rejected with `SLACK_SETUP_EXPIRED` instead of being persisted into a dead attempt.
- URL-verification writes compare the exact encrypted credential/proof snapshot they verified. If credentials are
  replaced concurrently on the same attempt, the stale challenge fails with `SLACK_SETUP_CONFLICT` and cannot restore
  the previous token or Signing Secret.
- The IM page polls the attempt with exponential backoff on transient failures and stops on a definitive answer, for
  example when the attempt no longer exists; **Refresh status** restarts polling.

## Required bot scopes and events

Both receive modes require these bot scopes:

- `app_mentions:read`
- `chat:write`
- `files:read`
- `im:history`

They subscribe to `app_mention`, `message.im`, `app_uninstalled`, and `tokens_revoked`.

`all_message` mode additionally requires `channels:history`, `groups:history`, and `mpim:history`, and subscribes to the
matching `message.channels`, `message.groups`, and `message.mpim` events. Changing from mentions-only to all-message
records the target on the Server and fails closed with a reauthorization requirement until Slack reports all additional
scopes. The current mentions-only policy remains effective while the generated reauthorization manifest requests the
target scopes; successful activation applies the target atomically. The pending target is projected as
`pendingReceiveMode` on the binding summary, admin detail, and diagnostics, and a real stored error code such as
`SLACK_TOKEN_REVOKED` is never masked by the scope-upgrade hint. Saving the receive mode unchanged does not cancel an
in-flight setup attempt; changing the effective target does, and records `SLACK_SETUP_CANCELED`.

`mention_only` does not promise automatic intervening channel messages around a mention. When a task needs more native
context, the Agent may query Slack directly through the official CLI, subject to the installed Bot Token's scopes and
conversation membership.

## Security and recovery

- Bot Tokens, Signing Secrets, and pending setup context are encrypted before database storage and are never returned by
  an admin or diagnostics API. The Signing Secret is never projected to the Agent runtime.
- OpenTag isolates automatic persistence and delivery by Session, but does not attenuate the projected Bot Token to the
  current channel or thread. During a valid visible IM Turn, the Agent may use the official Slack CLI anywhere the Bot
  Token's scopes and Slack membership allow. Such results stay in runtime context and do not automatically become
  OpenTag `ImMessage` history or deliveries for another Session.
- Slack request signatures use the raw request body, a five-minute replay window, and constant-time comparison.
- A URL-verification challenge proves the Signing Secret but does not carry App, Team, or Bot authorization identity.
  Activation therefore waits for a subsequent signed event whose raw envelope establishes the App and correlates its
  Team and bot authorization with the token-derived Team and Bot User. Browser identity is never part of this proof.
- Runtime credential validation preserves that signed-event App ID when a later `auth.test` omits `app_id`, while still
  rejecting a returned App ID mismatch or any Team, Bot User, or Bot ID drift.
- A Slack App installation can be current for only one Agent. Conflicts fail without changing either binding; both the
  in-transaction check and a concurrent unique-index race report `SLACK_APP_TEAM_ALREADY_BOUND`.
- Reauthorization preserves the current binding until the new credential generation is ready. Because the Signing
  Secret normally stays the same, live events also match the pending attempt; OpenTag never rejects them for a missing
  URL verification. An attempt that has not proven the Request URL yet is reported as awaiting its challenge, ingress
  falls through to the active binding, and an event for a first-time setup without any active binding is acknowledged
  with a no-op `200` (nothing is ingested) so Slack keeps the subscription alive. Replacement creates a new binding
  identity and disables the previous one only at activation.
- Event activation locks and rechecks the exact current setup attempt, active state, expiry, signature, reparsed raw
  envelope, and token/event identity correlation before atomically advancing credentials, applying a pending
  receive-mode target, and completing the setup slot. Expired, canceled, or replaced attempts cannot activate from a
  stale event.
- Slack disables an App's event subscription past roughly 95% delivery failures in a 60-minute window, and counts every
  non-2xx toward that budget. Ingress therefore reserves non-2xx for requests a caller should stop sending unchanged —
  signature failure, an unroutable or unknown binding, an App/Team identity mismatch, and structurally invalid bodies —
  and marks them `x-slack-no-retry`. A well-formed, routable callback whose event type or subtype OpenTag deliberately
  ignores, including `app_rate_limited`, is acknowledged with `200 {"ok":true,"ignored":"<reason>"}`.
- Ingested message subtypes are an explicit allow-list: no subtype, `file_share`, `thread_broadcast`, `message_changed`,
  `message_deleted`, and `bot_message` (still subject to the self filter). Every other subtype and any `hidden` message
  that is not an edit or delete revision is acknowledged and dropped, so channel-join and topic-change notices never
  reach the Agent.
- `X-Slack-Retry-Num` and `X-Slack-Retry-Reason` are read before signature verification and are therefore treated as
  untrusted: length-bounded, narrowed to Slack's documented reasons, and recorded only as span attributes.
- `tokens_revoked` moves the binding to reauthorization-required when the current bot token is affected.
- `app_uninstalled` disables the binding. Admins can retry an expired or failed setup, reauthorize, replace, or explicitly
  disable the binding.

Slack setup follows the same runtime readiness boundary as other IM providers. A configured binding is not handoff-ready
until the Agent runtime and official Slack CLI capability are both ready; outbound Slack delivery remains provider-native
and outside OpenTag's delivery truth.

## Acceptance coverage

The supported flow must cover:

- invalid Bot Tokens and unavailable Slack API responses;
- missing scopes for both receive modes;
- generated manifests keep the App Home Messages tab enabled and writable for direct messages;
- invalid, stale, or replayed Slack signatures;
- token-derived Team/Bot identity versus signed-event App/Team/bot-authorization correlation mismatch;
- duplicate App/Team installation conflicts;
- create, same-identity reauthorization, explicit replacement, disable, uninstall, and token-revocation recovery;
- wrong-secret recovery through credential re-submission, cancel, intent conflicts, and resume after a page refresh;
- live ingress during a same-secret reauthorization that still awaits URL verification;
- concurrent setup/activation attempts without partial cutover;
- secret redaction in API responses and diagnostics, verified by asserting that the credentials and error payloads
  contain no Bot Token or Signing Secret;
- credential scrubbing at the log and trace sinks, verified by injecting Bot Tokens, app-level tokens, and a Signing
  Secret directly into the Fastify logger and into raw span attributes, span events, exception messages, and status
  messages, then asserting that neither the capturing log sink nor the in-memory span exporter receives them. The
  enforcement is key-name and pattern based — known credential field names, Slack `xox*-` and `xapp-` prefixes,
  `Bearer` values, and labelled `secret=`/`token=` forms — so a credential that is neither carried under a known key nor
  recognizable by one of those patterns is not detectable and is instead prevented by never logging raw bodies;
- Slack ingress status policy: the typed failure codes, `x-slack-no-retry` on permanent rejections, `200` for
  deliberately ignored well-formed traffic, and one stored `im_messages` row across a duplicate retried delivery.

Slack protocol references: [app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/),
[`auth.test`](https://docs.slack.dev/reference/methods/auth.test/),
[request signing](https://docs.slack.dev/authentication/verifying-requests-from-slack/), and
[`url_verification`](https://docs.slack.dev/reference/events/url_verification/).
