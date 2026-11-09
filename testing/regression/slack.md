# Slack messaging release regression

Credential-free checklist for a later live pass against a **separately registered test Slack Team and Slack App**. Do
not commit tokens, signing secrets, OAuth codes, Team IDs, channel IDs, user IDs, or traces. Record results outside the
repository.

This pass covers the single-Slack-Team / single-Agent classic messaging path only. It does not accept Agent View,
multi-Agent routing, slash commands, security redesign, or message-retention changes. Inbound persistence and
`mention_only` / `all_message` behavior stay as currently implemented.

## Prerequisites

- A dedicated test Slack Team that is not a production workspace.
- A separately registered Slack App whose bot scopes and subscribed bot events match
  [slack-public-distribution-manifest.yaml](../../docs/slack-public-distribution-manifest.yaml).
- A local OpenTag server configured with that test App's first-party credentials (`OPENTAG_SLACK_*`), never checked in.
- One OpenTag Agent whose current Slack installation is that App/Team pair.
- Human test users who can DM the bot, mention it in a public channel, invite it to a private channel, and start an
  MPIM.

Exact required bot scopes, in contract order:

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

## Exact scope verification

1. Complete first-party OAuth for the Agent.
2. Confirm OpenTag diagnostics `requiredCapabilities` and `grantedCapabilities` equal the eighteen scopes above, with
   `missingCapabilities` empty.
3. Confirm Slack's installed App shows the same bot scopes. Do not paste token headers or `x-oauth-scopes` into notes
   that will be committed.
4. Repeat OAuth with one required scope removed from the test App. OpenTag must fail closed with
   `SLACK_SCOPE_REAUTH_REQUIRED` and must not report the installation healthy.

## Ingress by conversation kind

For each conversation, send a human message and confirm OpenTag **persists** the inbound row even when it later withholds
delivery:

| Conversation | Setup | Persist | Delivery notes |
| --- | --- | --- | --- |
| DM | Open a DM with the bot | Yes | Direct, independent of receive mode |
| Public channel | Bot is a member | Yes | Mention / `all_message` as below |
| Private channel | Invite the bot; do not rely on `channels:join` | Yes | Same admission as public; membership is required |
| MPIM | Include the bot in a group DM | Yes | Treat as `group_dm` |

A public-channel `conversations.join` from the Agent CLI may add the bot when that channel is relevant to the current
task, even if the user did not name the channel. The Agent must not roam through or bulk-join task-unrelated channels.
Joining intentionally enrolls future messages in normal persistence and `receiveMode` delivery. A private channel or
MPIM without membership must not be joinable through `channels:join`.

## `mention_only` and `all_message`

Switch only the Agent `receiveMode`. This must not rotate credential generation, rewrite the Slack manifest, or require
reauthorization.

- **`mention_only`:** an unmentioned public/private/MPIM message is persisted and not delivered. An `@mention` is
  delivered `direct`. A DM is delivered `direct`.
- **`all_message`:** an unmentioned channel or MPIM message is persisted and delivered `ambient`. Mentions and DMs remain
  `direct`.
- Thread continuity stays as in [thread-sessions.md](../../docs/system/messaging/thread-sessions.md): `mention_only` does not materialize a Thread
  Session for an unaddressed reply unless trusted direct continuity already exists; `all_message` may materialize or wake
  the Thread Session as `ambient` and also deliver an observer copy to the Channel Session.

## Root, thread, edit, delete, and dedup

1. Post a root channel message that addresses the Agent. Confirm Channel Session delivery and no pre-created Thread
   Session.
2. Reply in a Slack thread. Confirm the Thread Session materializes according to receive mode, and that bounded history
   on the first direct Thread delivery includes the visible root plus prior thread messages, not sibling threads.
3. Edit the root and a thread reply. Confirm the same `externalMessageId` receives a new revision and later history shows
   the edited text, not the original.
4. Delete a thread reply. Confirm later history shows `[deleted]` for that message.
5. Replay the same Slack `event_id`. Confirm the inbound row is not duplicated (`duplicate: true` / single persisted
   message).

## Cross-channel reads

From a Turn in conversation A, give the Agent a task for which conversation B is relevant, without necessarily naming B,
then let it discover B with `conversations.list` / `conversations.info` and read it with `conversations.history` /
`conversations.replies`.

- Public channel the bot has joined: read succeeds.
- Public channel the bot has not joined: after Slack returns `not_in_channel`, the Agent confirms that B is public and
  task-relevant, calls `conversations.join` once, and retries the original read once. It must not join merely to explore.
- After that join, under `mention_only`, an unmentioned human message is persisted but not delivered and a mention is
  delivered `direct`; under `all_message`, an unmentioned human message is persisted and delivered `ambient`.
- Private channel, MPIM, `channel_not_found`, or unknown conversation type: the Agent does not guess or retry join. A
  human must invite the bot before access.

## Proactive message and DM

- `chat.postMessage` to the current channel, including a threaded reply when `threadTs` is present.
- `chat.update` / `chat.delete` / `chat.scheduleMessage` on a message the bot owns. For cancellation, leave enough lead
  time, call `chat.deleteScheduledMessage` immediately with the returned `scheduled_message_id`, and verify absence with
  `chat.scheduledMessages.list`.
- Discover existing DMs and MPIMs with `conversations.list`; verify that both conversation types are visible when the bot
  is a member.
- `conversations.open` with exactly one user ID plus `chat.postMessage` to start or continue a one-to-one DM. Do not use
  it to create a new MPIM; an existing MPIM may be read or written only when the bot already has access.

Use `slack api <method> --json '<json>'` with one JSON object for writes. For reads, use URL-encoded `--data`, for
example `slack api conversations.history --data 'channel=C...&limit=10'` or
`slack api files.info --data 'file=F...'`: Slack legacy read methods ignore JSON parameters in direct Local mode.
Do not pass token, app, team, workspace, config, or update override flags.

## Reactions

- `reactions.add`, `reactions.get`, and `reactions.remove` on an inbound human message.
- Confirm the bot cannot substitute an OpenTag Session ID for Slack `channel` / `timestamp`.

## Inbound and outbound files

- Inbound: attach an image and a non-image file to a human message. Confirm the persisted message stores resource
  descriptors and the Agent Turn can fetch available files with `files:read`.
- Repeat with no caption, with image plus text, with a historical file downloaded to a fresh path, and with a file sent
  during an active Turn. Confirm the original byte count and SHA-256 match the fixture, the image reaches native image
  viewing when required, and the reply is visible in Slack. For the active Turn case, verify arrival falls inside the
  running command interval and the attachment is steered into that same Turn.
- Run the default Local credential path separately from explicit proxy mode. For Local downloads, use the private
  `OPENTAG_SLACK_DOWNLOAD_CONFIG` with `curl --disable --config '<path>'` only for HTTPS `files.slack.com` URLs from
  `files.info`; do not print the config or follow redirects. Proxy downloads use the scoped proxy URL, CA and handle
  path described in [direct-provider-cli.md](../../docs/system/messaging/direct-provider-cli.md). One mode passing does not validate the other.
- Outbound: use Slack's current external upload only: `files.getUploadURLExternal` → HTTP POST bytes to `upload_url` →
  `files.completeUploadExternal`. Do not use deprecated `files.upload`.

## Expected Slack errors

- With an authorized Cloud test Agent, send a message while its Sandbox cold-starts, then run a
  Turn longer than 15 seconds. Initial allocation waits and confirmed `started`/`reported` recovery
  use `debug` retry logs without Server error diagnostics; the real reply still arrives once.
  Controlled allocation failure, workspace-save blockage, loss of the Runner/query response, and
  waiting beyond the documented diagnostic bounds must remain visible as faults. Use the offline
  Server tests for injected failures; do not disrupt a shared or production Runner.
Provoke and confirm the Agent surfaces the provider error instead of inventing success:

- `not_in_channel` on a confirmed public, task-relevant channel follows the single join-and-retry recovery above;
  `channel_not_found`, private, MPIM, or unknown targets require a human invitation
- `msg_too_long` or a split across multiple `chat.postMessage` calls when the body exceeds Slack's `text` /
  `markdown_text` limits
- HTTP `429` / `ratelimited` with `Retry-After` honored once, not a tight poll
- `invalid_auth` / `token_revoked` after the test App's bot token is revoked in Slack
- `missing_scope` if a method is called without the matching granted scope (should not happen on a complete install)

## Execution admission and configuration changes

Use an authorized test binding and a harmless, uniquely marked DM for each new
Turn. Exercise startup while delivery acceptance is still committing. Pending
custody remains retryable; matching accepted custody starts the Turn without a
spurious `credential_unavailable`. Terminal custody and a different Turn,
Session, Agent, Computer, connection instance, or placement never authorize it.
The controlled acceptance race is also covered by
`runtime-credentials-db.test.ts` and `runtime-execution-authority.test.ts`.

For self-configuration, finish any pre-save notice before saving. The old Turn's
provider access must fail after its Agent revision changes. Send a new DM and
verify that its fresh Turn can read the saved configuration and send one marked
reply. Confirm delivery by provider receipt and message readback, without
replaying the old Turn's uncertain send. Run this sequence separately for Slack
and Feishu when both authorized test bindings are available.

A Local Agent's Sessions run concurrently, and a configuration change doesn't wait for them. Use two chats of one Agent:

1. Start a long Turn in chat A. Before it ends, send a message in chat B. Chat B replies while chat A is still running.
2. Send a follow-up in chat A. It joins the running Turn, with no second Turn and no extra report.
3. Start another long Turn in chat A, then change the Agent's model while it runs. Send a message in chat B. Chat B starts
   at once on the new model. It must not wait for chat A.
4. Let chat A finish. It ran on the old model. As the case above says, its provider access fails from the save onwards,
   so what it sends after the change may not arrive. Send another message in chat A. That Turn runs on the new model.
5. Repeat step 3, then restart the daemon right after chat B's message is sent. Chat A resumes once on the old model and
   completes, chat B completes on the new model, and neither chat gets a failure message. The client log has no
   `TURN_RETRY_ABANDONED`. The arrival order after a restart can't be forced by hand, so if chat A happened to recover
   first, this step passes without covering the other order. `session-binding-store.test.ts` pins chat B arriving first.
6. With 10 chats running, send a message in an 11th. It waits with no error, then runs once a slot opens. A follow-up in a
   running chat still joins its Turn while the Agent is at the limit.

## Cloud Agent `/slackauthticket` automatic setup

1. Create a Cloud Agent (or open **Messaging** settings on an unbound Cloud Agent) with fresh browser state and choose
   **Connect Slack**. Confirm the UI first opens the explicit existing-App / new-App choice (**View Apps** link to
   `https://api.slack.com/apps`, **Manual setup**, and **Create App**) without requesting a ticket on mount. Select
   **Create App** and confirm OpenTag sends `authorize` (`force: true`) and displays the `/slackauthticket <ticket>`
   command + challenge code form.
2. Paste `/slackauthticket <ticket>` in a channel or DM of a test workspace that requires app-installation approval,
   confirm permissions in Slack, paste the challenge code into OpenTag, and select **Connect**.
3. Confirm OpenTag creates the App once, submits the installation approval request automatically, and displays
   `Request submitted. Continue after approval.` with **View approval** (`https://app.slack.com/apps-manage/<teamId>`)
   and `App: <appId> · Workspace: <teamId>` in **Diagnostics**.
4. Select **Continue** before approving in Slack and confirm OpenTag stays in `approval_pending` for the same `appId`
   without creating a second App or submitting a duplicate approval request.
5. Approve the request in Slack's **Requests to install** as a Workspace Owner or App Manager, then select **Continue**
   in OpenTag (within the same Server process). Confirm the same `appId` is installed, bound, and has its Events API and
   Interactivity Request URLs verified. Send the Bot a DM and confirm its reply closes identity and reaches the Cloud Agent.
6. **Server restart during unfinished setup:** start `/slackauthticket` setup for a second Cloud Agent up to
   `approval_pending`, then restart the OpenTag Server before selecting **Continue**. Confirm that selecting **Continue**
   returns `manual_required` (`Use manual setup for this App.`) and switches to **Manual setup** for the existing App
   (`View Apps` link to `https://api.slack.com/apps`, with no **Reauthorize** action and no second `apps.manifest.create`),
   and that opening **Connect Slack** on a fresh browser/device after the restart also presents the **View Apps** /
   **Manual setup** / **Create App** gate before any new ticket is issued.

## Reauthorization

1. After a required-scope expansion, an existing 7-scope (or otherwise incomplete) install must project
   `reauthorization_required` / `SLACK_SCOPE_REAUTH_REQUIRED` without reporting healthy credentials.
2. Same-identity reauthorization with the complete eighteen scopes must keep App, Team, and Bot User, increment
   `credentialGeneration`, and restore `active` once identity closure succeeds.
3. A different Agent claiming the same App/Team must return `SLACK_APP_TEAM_ALREADY_BOUND` with no side effects.

## Revoke and uninstall

- Slack `tokens_revoked` for this Bot User: installation generation moves to `reauthorization_required` with
  `SLACK_TOKEN_REVOKED`. Inbound delivery fails closed.
- Slack `app_uninstalled`: that installation generation is disabled and active credential material is erased. The Agent
  route must not keep a usable Bot Token.

Do not store the revoked token, signing secret, or raw event bodies in the repository.
