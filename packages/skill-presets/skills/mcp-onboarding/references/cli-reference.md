# MCP command reference

Two surfaces exist. The **Agent surface** authenticates with this Agent's Session proof and can only
touch this Agent's own mounts. The **Account surface** authenticates with a human operator's login
and owns Server definitions and credentials.

Both print one JSON document on stdout with `--json`. Diagnostics that a human must read — such as
an OAuth URL — go to stderr so `--json` stays parseable.

The production binary is `opentag`. A development Computer has `opentag-dev` and a staging Computer
has `opentag-staging`; substitute the binary this workspace actually has.

## Agent surface — `opentag agent self`

| Command | Effect | Flags |
| --- | --- | --- |
| `agent self show` | This Agent's configuration, including its id | `--json` |
| `agent self update` | Instructions, model, reasoning effort | `--model`, `--clear-model`, `--reasoning-effort`, `--clear-reasoning-effort`, `--instructions`, `--instructions-file`, `--json` |
| `agent self mcp list` | The MCP Servers this Agent mounts | `--json` |
| `agent self mcp available` | Account definitions this Agent does not mount | `--json` |
| `agent self mcp attach <server>` | Mount an Account definition on this Agent | `--disabled`, `--json` |
| `agent self mcp detach <server>` | Unmount it, dropping this Agent's credential | `--json` |
| `agent self mcp enable <server>` | Enable a mounted Server | `--json` |
| `agent self mcp disable <server>` | Disable it, keeping the mount and credential | `--json` |

`<server>` is a name or an id. There is no `--agent` flag on this surface: the Session proof names
the Agent, so no command can address another one.

## Account surface — `opentag mcp`

For a human operator. Every per-Agent command takes `--agent <agent-id>`.

| Command | Effect | Flags |
| --- | --- | --- |
| `mcp add` | Register a shared Server definition | `--name`, `--url`, `--default-auth <oauth\|bearer\|none>`, `--auth-header`, `--auth-scheme`, `--extra-header name=value` (repeatable), `--json` |
| `mcp list` | List the Account's definitions | `--json` |
| `mcp show <server>` | One definition, plus `agents[]`; add one Agent's effective view | `--agent`, `--json` |
| `mcp update <server>` | Edit the shared definition | `--description`, `--url`, `--default-auth`, `--auth-header`, `--auth-scheme`, `--extra-header`, `--clear-extra-headers`, `--empty-extra-headers`, `--expected-revision <n>`, `--json` |
| `mcp remove <server>` | Delete a definition; refused while any Agent mounts it | `--json` |
| `mcp use <server>` | Authorize one Agent with a Bearer key, or declare it anonymous | `--agent`, `--kind <bearer\|none>`, `--bearer-key-stdin`, `--bearer-key` (**UNSAFE**), `--json` |
| `mcp authorize <server>` | Authorize one Agent by OAuth, or declare it anonymous | `--agent`, `--kind <oauth\|none>`, `--scopes a,b`, `--no-wait`, `--json` |
| `mcp revoke <server>` | Drop one Agent's credential, keeping the mount | `--agent`, `--json` |
| `mcp probe <server>` | Re-probe one Agent's credential | `--agent`, `--json` |

`mcp add` has no `--description`: a definition's description is what the probe discovered, and
nothing can be probed before the definition exists. Use `mcp update --description` afterwards.

`--bearer-key` is retained for scripts and its help text calls it unsafe, because a command-line
argument is readable by every other process and lands in the shell history file. Prefer
`--bearer-key-stdin`, which reads the key from standard input.

## Account surface — `opentag agent mcp`

The same per-Agent work addressed by id, for an operator.

```sh
opentag agent mcp list <agent-id> [--json]
opentag agent mcp attach <agent-id> <server> [--disabled] [--json]
opentag agent mcp detach <agent-id> <server> [--json]
opentag agent mcp enable <agent-id> <server> [--json]
opentag agent mcp disable <agent-id> <server> [--json]
opentag agent mcp config <agent-id> <server> [--url <url>] [--auth-header <name>]
                            [--auth-scheme <scheme>] [--extra-header name=value]
                            [--clear-url] [--clear-auth-header] [--clear-auth-scheme]
                            [--clear-extra-headers | --empty-extra-headers] [--json]
```

`agent mcp config` writes this Agent's overrides of the shared definition. An override changes what
that Agent dials without changing what its siblings dial.

## Reading the authorization state

`list --json` reports the four states separately, and they have different fixes:

| Field | Values | What it means |
| --- | --- | --- |
| `enabled` | `true` / `false` | The mount. A disabled Server keeps its credential |
| `authorization.kind` | `none` / `bearer` / `oauth` | How this Agent authenticates |
| `authorization.status` | `pending` / `active` / `expired` / `revoked` / `error` | Whether the Agent can use it now |
| `authorization.probeState` | `pending` / `succeeded` / `failed` | Whether the tool snapshot was read |

`authorization` is `null` until a row exists for the pair, which is the state a Server that needs a
credential starts in. `authorization.toolsTruncated` means the snapshot was cut off by a bound or
pagination did not finish, not that the Server is broken.
