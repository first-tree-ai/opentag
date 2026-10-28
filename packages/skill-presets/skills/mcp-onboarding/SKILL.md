---
name: mcp-onboarding
description: "Connect, authorize, and manage MCP Servers for this Agent inside the current OpenTag chat. Use when the user wants to configure, connect, add, enable, disable, remove, or authorize a tool, connector, integration, or MCP Server; when they name a product or service; when they paste an MCP config, URL, or API key; or when a mounted Server is missing, disabled, or unauthorized. Also match 我想配置 X 的 MCP, 配置 MCP, 连接, 接入, 授权, 帮我接一下, and 加上这个服务. Do not answer those requests with a web-console guide."
---

# MCP onboarding

Configure MCP in this OpenTag chat. You run the commands before you reply. The user stays in the
conversation. The one step they take outside the chat is opening the OAuth consent URL you give them.

A message such as "我想配置 Figma 的 MCP" is a request for a new connection. A message such as
"disable Notion" is a request about a binding you already have. Decide which one it is before you
search or add. The wrong reply is a setup guide: two methods, a recommended web console, "log in,
open Agent settings, open Connectors, search, click Connect", or a list of actions and tool names
you have not observed. The Connectors page exists. Describing it is still the wrong reply.

The production binary is `opentag`. A development Computer has `opentag-dev` and a staging Computer
has `opentag-staging`. Use the binary this workspace has. `opentag self` and `opentag agent self`
are the same command group. Inside a managed Session, type `opentag self`.

These commands run only while self-configuration is enabled for this Agent. It is on by default. If
a command fails with `AGENT_SELF_CONFIGURATION_DISABLED`, tell the user that the owner turned it off
and can turn it on with the Self-configuration switch on this Agent's Name settings page. Do not send
them to the web MCP screen as a substitute.

## Decide from what the user said

1. **They ask to enable, disable, remove, detach, or reauthorize a Server.** This includes "disable
   Notion". The first command is `opentag self mcp list --json`. Use the mounted name from that
   list, even when it is a custom name such as `work-notion`. Then run `enable`, `disable`, or
   `delete` on that binding. Run `generate_oauth_url` only when they explicitly ask to replace the
   link. A status of `pending` is not that request: the link you already sent is still live, and a
   new URL invalidates it. Do not search the catalog. Do not run `add`. `add` only creates a
   definition. It does not change an existing one.

2. **They ask to connect or configure a product this Agent does not mount yet.** This includes
   "我想配置 Figma 的 MCP". Check the bindings you already have before you search:

   ```sh
   opentag self mcp list --json
   opentag self mcp available --json
   ```

   If it is already mounted, reuse that name. Do not add a second definition. A mount is not a
   usable connection: an enabled OAuth binding can still have `authorization: null`. If `enabled`
   is false, run `opentag self mcp enable <server>`. Then run the authorization check in Procedure
   step 5 on that name. A missing Bearer key is written with `opentag self mcp use <server>
   --api-key-stdin`. Do not run `add` to store a key for an existing name. `authorization: null`
   means no OAuth flow has started: run `generate_oauth_url` once. A status of `pending` means that
   link is still live: check again and wait. Do not start a new flow while it is `pending`. Start
   one again only when the status is `expired`, `revoked`, or `error`, or when the user says the
   link was refused or already used. Stop only when the observed state is enabled, the
   authorization status is `active`, and `probeState` is `succeeded`. If the Account already
   defines it and you do not mount it, run `opentag self mcp attach <server>` and run the same
   check. Search only when neither list has it. Use their words as the query:

   ```sh
   opentag self mcp search notion --json
   ```

   A usable match has `installable: true` and a `url`. Add that `name`, `url`, and
   `defaultAuthKind`. Tell the user what the command returned. Do not ask them for an endpoint the
   catalog already has.

3. **The search has no installable match.** Ask them to paste the MCP configuration into this chat.
   Accept a remote `http` or `https` URL, JSON or YAML whose servers sit under `mcpServers`, `mcp`,
   `servers`, or `mcp_servers`, or a `claude mcp add` / `codex mcp add` line that names a remote URL.

   From the paste, take the server name, the HTTP endpoint, and `oauth` or `bearer`. Normalize the
   name to lowercase letters, digits, and single hyphens, at most 64 characters, with no leading or
   trailing hyphen. A bearer token in the paste goes to `add` through `--api-key-stdin`. Do not
   repeat the token in the chat, in a file, or as a command argument.

   A paste that is only a local process (`stdio`, `command`, `args`, or `npx`) has no endpoint this
   Session can register. Say that, and ask for the remote HTTP URL. Do not invent a vendor URL.

   `self mcp add` stores the endpoint and this Agent's own credential. It does not store extra
   headers. Register what it can store, and tell the user that shared extra headers stay with a
   human operator.

An anonymous Server (`none`) is refused here. Tell the user that an Account owner adds that kind.

## The two boundaries

Read this before you promise anything.

| Step | Who can do it | Command |
| --- | --- | --- |
| Search the connector catalog | You | `opentag self mcp search <query>` |
| Read a pasted MCP configuration | The user, in this chat | You parse it, then you run `add` |
| Register a Server definition and mount it on yourself | You | `opentag self mcp add <name> <url> [oauth\|bearer]` |
| Write a Bearer key while creating the definition | You | `opentag self mcp add … bearer --api-key-stdin` |
| Write a Bearer key onto a Server you already mount | You | `opentag self mcp use <server> --api-key-stdin` |
| Start an OAuth flow | You | `opentag self mcp generate_oauth_url <server>` |
| Complete an OAuth consent screen | The user, in a browser | `opentag self mcp check_oauth_status <server> --wait` |
| Mount, enable, or disable an Account definition | You | `opentag self mcp attach` / `enable` / `disable` |
| Edit or delete a definition another Agent still mounts | A human operator | `opentag mcp remove` |

Your commands are authenticated by the Session proof, which names this Agent. That proof lets you
create definitions and write *your own* credentials. It can never write a credential for another
Agent, and it cannot mount a Server that requires no credentials at all. A definition you create is
shared with the Account's other Agents as an *available* definition, so name it for the service, not
for yourself.

## Procedure

Use this procedure for a new connection. An enable, disable, remove, or reauthorize request stops
after `list` and the requested command. It does not continue into search or `add`.

1. **See what you already mount.**

   ```sh
   opentag self mcp list --json
   ```

   Each entry carries four independent states: `enabled`, `authorization.kind`,
   `authorization.status`, and `authorization.probeState`. If the Server you want is already here,
   go to step 5. If it is here but `enabled` is false, run `opentag self mcp enable <server>` and go
   to step 5. A disabled Server keeps its credential and needs no reauthorization.

2. **Find the connector, or take the paste.** Follow **Decide from what the user said**. The catalog
   read needs no network and no existing definition. Each match gives a `name`, an auth kind, and a
   `url` when the Server is hosted and installable. Use the catalog's `name` so the definition
   matches what a person will search for later.

3. **See whether the Account already defines it.**

   ```sh
   opentag self mcp available --json
   ```

   Match on `name`, then on `description`. If it is here, mount it with
   `opentag self mcp attach <server>` and go to step 5. Do not create a duplicate.

4. **Add it, and mount it in the same step.**

   OAuth Server. It is not usable until step 6:

   ```sh
   opentag self mcp add notion https://mcp.notion.com/mcp oauth
   ```

   Bearer Server, when the user already gave you a key:

   ```sh
   opentag self mcp add cmdb https://cmdb.internal.example/mcp bearer --api-key-stdin
   ```

   `auth_kind` defaults to `bearer` when a key is supplied and to `oauth` otherwise. `none` is
   refused. An anonymous mount would be usable immediately, which is a decision the Account owner
   keeps. A bearer key goes in over standard input, never as an argument. A command line is
   readable by other processes and lands in the shell history.

5. **Check whether it is usable.**

   ```sh
   opentag self mcp check_oauth_status <server>
   ```

   - `authKind` is `none` and `probeState` is `null`, or `authorization` is null. Nothing has been
     authorized yet. For a Bearer Server, ask the user for the key and run `opentag self mcp use
     <server> --api-key-stdin`. Do not run `add` again: the name already exists. For an OAuth
     Server, go to step 6 once.
   - `authStatus` is `pending`. The consent link is still live. Do not run `generate_oauth_url`.
     Tell the user to finish the link you already sent, and check again when they say they have
     finished.
   - `authStatus` is `expired`, `revoked`, or `error`. The previous flow cannot be finished. For
     OAuth, generate a fresh URL. For Bearer, run `use` again with a new key.
   - `authStatus` is `active` and `probeState` is `failed`. The Server was reached but its tools
     could not be read. Report `probeError` to the user. The usual causes are a rejected
     credential, a protocol revision the Server does not speak, or an endpoint the platform refuses
     to dial.
   - `authStatus` is `active` and `probeState` is `succeeded` with `toolsCount` above zero. You are
     done. The `tools` names are what you can now do. Tools are available on the next Turn.

   A `toolsCount` of `0` means the Server answered and offers no tools to this credential. Report
   that fact. Do not treat it as success.

6. **Start the OAuth flow, and hand the URL to the user.**

   ```sh
   opentag self mcp generate_oauth_url notion
   ```

   Then say, in one message: what you added, that one click is needed, the URL, and that you will
   report when it lands. The link only works for the Account that owns this Agent and only once.
   Tell them to open it themselves while signed in to openTag. Do not forward it to a colleague,
   and do not open it twice. Poll only briefly, because a login plus a second factor can take longer
   than a Turn:

   ```sh
   opentag self mcp check_oauth_status notion --wait 45
   ```

   If it has not settled, tell the user to reply when they have finished, and check once more then
   with no `--wait`. A status that is still `pending` is that wait. It is not a reason to generate
   another URL. If they report that the link was refused or already used, generate a fresh one.
   Do not reuse the old URL. Do not block indefinitely, and do not claim success you have not
   observed.

## What stays with the user

- **The OAuth consent screen.** You can start the flow. Only they can approve it. The link is bound
  to the Account that owns this Agent and is single use, so it cannot be shared or retried.
- **Deleting an Account definition.** `opentag self mcp delete <server>` removes your mount and your
  authorization, but retains the Account definition. Removing or reusing its name requires human
  Account deletion.
- **The Account's other Agents.** You cannot read or write their mounts or credentials.
- **A local-process MCP config, and shared extra headers.** Ask for a remote HTTP URL. Leave extra
  headers to a human operator.

## Rules that keep this safe

- Do not invent, guess, or reuse a credential, and do not write one into a file, a task, or this
  conversation.
- Do not add a Server you cannot explain. Name the endpoint and the tools it will add.
- Prefer `disable` over `detach` when the mount should stay. A disabled mount keeps its credential
  and re-enables with no reauthorization.
- Report what you observed. The exact `probeState`, `toolsCount`, and `probeError` are what let a
  person fix the problem.
- Do the management in this chat. A reply that only tells the user how to use the web console, Agent
  settings, or the Connectors page is a failed turn. Account commands `opentag mcp` and
  `opentag agent mcp` are not a substitute you hand to the user.

## Reference

`references/cli-reference.md` in this Skill lists the full flag matrix for both surfaces, including
the Account-side commands a human operator may need.
