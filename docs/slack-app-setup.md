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

1. In the Agent's **IM** page, choose **Connect Slack App**, **Reauthorize Slack**, or **Replace Slack App**.
2. Open the generated manifest link, create a dedicated Slack App, and install it to the intended workspace.
3. Copy the **Bot User OAuth Token** from **OAuth & Permissions** and the **Signing Secret** from **Basic Information**
   into OpenTag.
4. OpenTag calls Slack's `auth.test` endpoint and derives the Team ID, Enterprise ID when present, Bot User ID, Bot ID,
   and the token's actual `x-oauth-scopes`. Slack may omit `app_id` for a valid Bot Token, so a browser-supplied App ID
   or scope list is never authoritative.
5. Return to **Event Subscriptions** and retry the generated Request URL. OpenTag verifies Slack's timestamped HMAC
   signature before returning the URL-verification challenge.
6. Invite the bot to a test channel and mention it. OpenTag reparses the signature-verified raw event and establishes the
   App ID from its `api_app_id` only when the envelope App and Team match the routed App and token-derived Team, and a bot
   authorization matches the token-derived Team and Bot User. If `auth.test` did return an App ID, it must also match.
   That event is then admitted through the active binding.

Slack can attempt URL verification as soon as the manifest is created, before OpenTag has the Signing Secret. A failed
initial attempt is expected; retry it after submitting the credentials.

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
target scopes; successful activation applies the target atomically.

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
- A Slack App installation can be current for only one Agent. Conflicts fail without changing either binding.
- Reauthorization preserves the current binding until the new credential generation is ready. Replacement creates a
  new binding identity and disables the previous one only at activation.
- Event activation locks and rechecks the exact current setup attempt, active state, expiry, signature, reparsed raw
  envelope, and token/event identity correlation before atomically advancing credentials, applying a pending
  receive-mode target, and completing the setup slot. Expired, canceled, or replaced attempts cannot activate from a
  stale event.
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
- concurrent setup/activation attempts without partial cutover;
- secret redaction in API responses, diagnostics, logs, and traces.

Slack protocol references: [app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/),
[`auth.test`](https://docs.slack.dev/reference/methods/auth.test/),
[request signing](https://docs.slack.dev/authentication/verifying-requests-from-slack/), and
[`url_verification`](https://docs.slack.dev/reference/events/url_verification/).
