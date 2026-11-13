# Provider proxy passthrough release regression

Credential-free checklist for the Feishu provider proxy in proxy credential mode. Use a test Feishu tenant and a test
App only. Do not commit tokens, App secrets, tenant, chat, document or user identifiers, or logs. Record results outside
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

## Switch off

1. Restart the Server with `OPENTAG_PROVIDER_PROXY_PASSTHROUGH=off` and repeat step 1 of the first section.
   Expected: the call fails with `403` `operation_not_registered`; ordinary message replies still work.
2. Start the Server with `OPENTAG_PROVIDER_PROXY_PASSTHROUGH=yes`.
   Expected: startup fails with a configuration error.
