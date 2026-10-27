---
name: mcp-onboarding
description: Add MCP tools to this Agent. Use when a task needs a tool that lives behind MCP, when a mounted Server is disabled or unauthorized, or when the human asks to register or add an MCP Server.
---

# MCP onboarding

An MCP Server gives this Agent a group of tools. This Skill tells you how to find one, how to add it
to yourself, and which single step still needs the human: completing an OAuth consent screen in a
browser.

## The two boundaries

Read this before you promise anything.

| Step | Who can do it | Command |
| --- | --- | --- |
| Search the connector catalog | You | `opentag self mcp search <query>` |
| Register a Server definition and mount it on yourself | You | `opentag self mcp add <name> <url> [oauth\|bearer]` |
| Write your own Bearer key | You | `opentag self mcp add … bearer --api-key-stdin` |
| Start an OAuth flow | You | `opentag self mcp generate_oauth_url <server>` |
| Complete an OAuth consent screen | The human, in a browser | `opentag self mcp check_oauth_status <server> --wait` |
| Mount, enable, or disable an Account definition | You | `opentag agent self mcp attach` / `enable` / `disable` |
| Edit or delete a definition another Agent still mounts | A human operator | `opentag mcp remove` |

Your commands are authenticated by the Session proof, which names this Agent. That proof lets you
create definitions and write *your own* credentials; it can never write a credential for another
Agent, and it cannot mount a Server that requires no credentials at all. A definition you create is
shared with the Account's other Agents as an *available* definition, so name it for the service, not
for yourself.

## Procedure

1. **See what you already mount.**

   ```sh
   opentag self mcp list --json
   ```

   Each entry carries four independent states: `enabled`, `authorization.kind`,
   `authorization.status`, and `authorization.probeState`. If the Server you want is already here,
   go to step 5. If it is here but `enabled` is false, run `opentag self mcp enable <server>` and go
   to step 5 — a disabled Server keeps its credential and needs no reauthorization.

2. **Find the connector.**

   ```sh
   opentag self mcp search hubspot
   ```

   This reads the catalog shipped with the CLI, so it works before any definition exists. Each match
   gives a `name`, an `auth` kind, and a `url` when the Server is hosted and installable. Use the
   catalog's `name` so the definition matches what a human will search for later.

   If the catalog has no match, ask the human for the endpoint URL. Never invent one.

3. **See whether the Account already defines it.**

   ```sh
   opentag self mcp available --json
   ```

   Match on `name`, then on `description`. If it is here, mount it with
   `opentag self mcp attach <server>` and go to step 5 instead of creating a duplicate.

4. **Add it, and mount it in the same step.**

   OAuth Server — no credential yet, so it is not usable until step 6:

   ```sh
   opentag self mcp add hubspot https://mcp.hubspot.com oauth
   ```

   Bearer Server, when the human already gave you a key:

   ```sh
   opentag self mcp add cmdb https://cmdb.internal.example/mcp bearer --api-key-stdin
   ```

   `auth_kind` defaults to `bearer` when a key is supplied and to `oauth` otherwise. `none` is
   refused: an anonymous mount would be usable immediately, which is a decision the Account owner
   keeps. A bearer key goes in over standard input, never as an argument — a command line is
   readable by other processes and lands in the shell history.

5. **Check whether it is usable.**

   ```sh
   opentag self mcp check_oauth_status <server>
   ```

   - `authKind` is `none` and `probeState` is `null` → nothing has been authorized yet. For a Bearer
     Server, ask the human for the key and run step 4 again with `--api-key-stdin`. For an OAuth
     Server, go to step 6.
   - `authStatus` is `active` and `probeState` is `failed` → the Server was reached but its tools
     could not be read. Report `probeError` to the human. The usual causes are a rejected
     credential, a protocol revision the Server does not speak, or an endpoint the platform refuses
     to dial.
   - `authStatus` is `active` and `probeState` is `succeeded` with `toolsCount` above zero → you are
     done. The `tools` names are what you can now do. Tools are available on the next Turn.

   A `toolsCount` of `0` means the Server answered and offers no tools to this credential — report
   that fact rather than treating it as success.

6. **Start the OAuth flow, and hand the URL to the human.**

   ```sh
   opentag self mcp generate_oauth_url hubspot
   ```

   Then say, in one message: what you added, that one click is needed, the URL, and that you will
   report when it lands. The link only works for the Account that owns this Agent and only once, so
   tell them to open it themselves while signed in to openTag — not to forward it to a colleague, and
   not to open it twice. Poll only briefly, because a login plus a second factor can take longer
   than a Turn:

   ```sh
   opentag self mcp check_oauth_status hubspot --wait 45
   ```

   If it has not settled, tell the human to reply when they have finished, and check once more then
   with no `--wait`. If they report that the link was refused or already used, generate a fresh one —
   never reuse the old URL. Never block indefinitely, and never claim success you have not observed.

## What stays with the human

- **The OAuth consent screen.** You can start the flow; only they can approve it. The link is bound
  to the Account that owns this Agent and is single use, so it cannot be shared or retried.
- **Deleting an Account definition.** `opentag self mcp delete <server>` removes your mount and your
  authorization, but retains the Account definition. Removing or reusing its name requires human
  Account deletion.
- **The Account's other Agents.** You cannot read or write their mounts or credentials.

## Rules that keep this safe

- Never invent, guess, or reuse a credential, and never write one into a file, a task, or this
  conversation.
- Never add a Server you cannot explain: name the endpoint and the tools it will add.
- Prefer `disable` over `detach` when the mount should stay; a disabled mount keeps its credential
  and re-enables with no reauthorization.
- Report what you observed, not what you expected: the exact `probeState`, `toolsCount`, and
  `probeError` are what let a human fix the problem.

## Reference

`references/cli-reference.md` in this Skill lists the full flag matrix for both surfaces, including
the Account-side commands a human operator may need.
