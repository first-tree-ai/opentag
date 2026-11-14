# Provider proxy passthrough release regression

Credential-free checklist for the Feishu and Slack provider proxies in proxy credential mode. Use a test Feishu
tenant, a test Slack workspace, and test Apps only. Do not commit tokens, App secrets, tenant, chat, document or user identifiers, or logs. Record results outside
the repository.

## Prerequisites

- A Local Computer with `OPENTAG_RUNTIME_CREDENTIAL_MODE=proxy` (or a Cloud Agent, which always uses proxy mode).
- A Server with `OPENTAG_PROVIDER_PROXY_PASSTHROUGH` unset or `on`.
- One Agent bound to the test Feishu App. The App has the `bitable:app` and `docx:document` scopes and can post in a
  test chat.

## Calls outside the explicit table

1. Ask the Agent in the test chat to create a Bitable app with `lark-cli` and report its URL.
   Expected: the app exists in the tenant; the reply arrives normally.
2. Ask the Agent to create a docx document, add one paragraph, and read it back.
   Expected: the document exists with the paragraph; the read returns its text.
3. Ask the Agent to download a file it uploaded to a Drive folder through the Drive media download API.
   Expected: the file is saved intact.
4. In the Server log, find `PROVIDER_PROXY_PASSTHROUGH` records for steps 1–3.
   Expected: each has `provider`, `method` and a `path` whose identifiers read `{id}`; no query string, body or token.

## Refusals

1. Ask the Agent to call `POST /open-apis/authen/v1/access_token` through `lark-cli api`.
   Expected: HTTP `403` with `operation_not_registered`; nothing is sent to Feishu.
2. Ask the Agent to call an API the App has no scope for.
   Expected: Feishu's own permission error is relayed unchanged.

## Slack

Use an Agent bound to a test Slack App with the `pins:write`, `pins:read` and `bookmarks:read` scopes.

1. Ask the Agent to pin one of its own messages with `slack api pins.add`, then list pins with `slack api pins.list`.
   Expected: the message is pinned; the list contains it, and any file URL in it is an OpenTag handle URL.
2. Ask the Agent to call `slack api oauth.v2.access` and `slack api auth.revoke`.
   Expected: both fail with HTTP `403` `operation_not_registered`; the bot token still works afterwards.
3. Ask the Agent to call a method the App has no scope for, such as `bookmarks.add`.
   Expected: Slack's own `missing_scope` error is relayed.
4. In the Server log, find `PROVIDER_PROXY_PASSTHROUGH` records with `provider=slack` and `path=/api/pins.add`.

## Switch off

1. Restart the Server with `OPENTAG_PROVIDER_PROXY_PASSTHROUGH=off` and repeat step 1 of the first section.
   Expected: the call fails with `403` `operation_not_registered`, as does Slack step 1; ordinary message replies
   still work on both providers.
2. Start the Server with `OPENTAG_PROVIDER_PROXY_PASSTHROUGH=yes`.
   Expected: startup fails with a configuration error.
