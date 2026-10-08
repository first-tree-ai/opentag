---
name: mcp-onboarding
description: Add MCP tools to this Agent. Use when a task needs a tool that lives behind MCP, when a mounted Server is disabled or unauthorized, or when the human asks to register or add an MCP Server.
---

# MCP onboarding

An MCP Server gives this Agent a group of tools. This Skill tells you how to find one, how to mount
it on yourself, and — because two of the three steps are not yours to take — exactly what to ask the
human for.

## The boundary you cannot cross

Read this before you promise anything.

| Step | Who can do it | Command |
| --- | --- | --- |
| Register a Server definition for the Account | A human operator | `opentag mcp add` |
| Mount an Account definition on this Agent | You | `opentag agent self mcp attach` |
| Write this Agent's credential (key or OAuth) | A human operator | `opentag mcp use`, `opentag mcp authorize` |

Your own commands are authenticated by the Session proof, which names this Agent. That proof can
mount an existing definition on you and nothing else: your Agent id is not a parameter anywhere, and
the Account's Server definitions and every credential stay behind the operator's authority. Do not
attempt them, and do not ask the human to paste a credential into the conversation.

## Procedure

Work in this order. Stop as soon as the Server you want is mounted and usable.

1. **See what you already mount.**

   ```sh
   opentag agent self mcp list --json
   ```

   Each entry carries four independent states: `enabled`, `authorization.kind`,
   `authorization.status`, and `authorization.probeState`. If the Server you want is already here,
   go to step 4. If it is here but `enabled` is false, run `opentag agent self mcp enable <server>`
   and go to step 4 — a disabled Server keeps its credential and needs no reauthorization.

2. **See whether the Account already defines it.**

   ```sh
   opentag agent self mcp available --json
   ```

   This lists Account definitions you do not mount. Match on `name`, then on `description`.

3. **Mount it, if the Account defines it.**

   ```sh
   opentag agent self mcp attach <server> --json
   ```

   `<server>` is the `name` or the `id` from step 2. If the Server you want is **not** in that list,
   no definition exists: go to "What to ask the human for" and ask for a definition.

4. **Check whether it is usable.**

   Run `opentag agent self mcp list --json` again and read the entry:

   - `authorization` is `null` or `authorization.status` is not `active` → this Server needs a
     credential that only a human can write. Ask for it (below).
   - `authorization.status` is `active` but `authorization.probeState` is `failed` → the Server was
     reached but its tools could not be read. Report `authorization.probeError` to the human. The
     usual causes are a rejected credential, a protocol revision the Server does not speak, or an
     endpoint the platform refuses to dial.
   - `authorization.status` is `active` and `probeState` is `succeeded` with
     `authorization.toolsCount` above zero → you are done. Its tools are available on the next Turn.

   A `toolsCount` of `0` means the Server answered and offers no tools to this credential — report
   that fact rather than treating it as success.

## What to ask the human for

Give the human a finished command, not a description of a command. Always include the reason in one
sentence, and never include a credential value.

**A definition does not exist yet.** Ask for this, with the real endpoint and a lowercase hyphenated
name:

```sh
opentag mcp add --name <name> --url <url> --default-auth oauth
```

Pass `--default-auth none` only when the endpoint is genuinely public. It is a prefill for a new
authorization, never a statement about what the Server requires, so do not describe it to the human
as "this Server needs OAuth". Add `--auth-header` and `--auth-scheme` for a bearer Server whose
header is not `Authorization: Bearer`, and `--extra-header name=value` for static headers the
endpoint documents.

**The Server needs a credential.** Ask for this, substituting your own Agent id, which
`opentag agent self show --json` reports:

```sh
opentag mcp authorize <server> --agent <your-agent-id>
```

Use `opentag mcp use <server> --agent <your-agent-id> --kind bearer --bearer-key-stdin` instead when
the service issues a static key. The key goes in over standard input, never as an argument: a
command line is readable by other processes and lands in the shell history.

**The credential exists but is stale.** Ask for the same authorize command again, or
`opentag mcp revoke` followed by it when the old credential must not be reused.

## Rules that keep this safe

- Never invent, guess, or reuse a credential, and never write one into a file, a task, or this
  conversation.
- Do not ask for a credential before you know the Server needs one. Attach first, then read the
  state: an anonymous Server is usable immediately and needs nothing from the human.
- Never mount a Server you cannot explain: name the endpoint and the tools it will add.
- `opentag agent self mcp detach <server>` drops your credential for that Server. Prefer
  `disable` when the mount should stay; a disabled mount keeps its credential and re-enables with no
  reauthorization.
- A Server definition is shared by every Agent in the Account. Editing or removing one is not your
  decision to make, and `mcp remove` is refused while any Agent still mounts it.
- Report what you observed, not what you expected: the exact `probeState`, `toolsCount`, and
  `probeError` are what let a human fix the problem.

## Reference

`references/cli-reference.md` in this Skill lists the full flag matrix for both surfaces, including
the Account-side commands you will ask a human to run.
