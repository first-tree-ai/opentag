# Agent permissions

[简体中文](./zh-CN/agent-permissions.md)

Local Codex Agents use `workspace-write` with `on-request` approvals and disabled sandbox network
access. Local Claude Code Agents use `auto`: its native classifier reviews actions and its permission
callback sends remaining requests to the task sender. Claude Code must support `auto` and
`--permission-prompt-tool`. Claude's native gate does not provide an OS sandbox.
Claude loads no user or project settings and disables hooks and dynamic skill shell execution.
Only explicitly synced skills and packaged Context Tree skills are copied into a private skills-only
plugin as `opentag:<skill-name>`. Symlinked or unavailable skills are skipped. Copies retain their
instructions and resources, but native frontmatter is limited to the name and description so a skill
cannot pre-approve tools. Subscription login is preserved.
Pi always runs without approvals and has no permission settings or permission extension.

Native command rules allow Feishu and Slack message reads, sends, edits, reactions, conversation
lookup, and native attachment commands. Run the CLIs directly: the managed launcher loads the
Turn credentials. Quoted literal multiline bodies and JSON content use the native CLI; there is no
reply helper. Simple compound commands and pipelines are checked by the provider, with explicit
rules for `head`, `tail`, `cat`, `echo`, `printf`, `jq`, `wc`, `stat`, and `sleep` (rate limits).
Unrelated actions keep native checks.
Shell assignments, substitutions, redirections, and heredocs can still require approval; avoid them
for ordinary messaging. Slack attachment transfers use a scoped `curl https://slack.com --request-target`
rule with literal execution proxy/CA arguments and the returned handle path. Only the two nonsecret
routing fields are read from the environment file; the shell does not source it.

Local Codex and Claude Code Agent Model settings let an owner turn off approvals for future work
or add command prefixes, including arguments after the prefix. Claude auto mode can still review
broad execution rules. Built-in commands are not shown in the list. Approval requests go to the
Slack or Feishu user who sent the task; no approver ID or account linking is needed. Cloud Agents
always run with full permissions and have no permission settings.

The Agent's self-configuration API cannot modify permission settings.

Slack Apps must enable Interactivity with request URL
`{OPENTAG_PUBLIC_URL}/api/v1/im-bindings/slack/interactions`. The first-party distribution manifest
includes it. Custom Apps may instead use
`{OPENTAG_PUBLIC_URL}/api/v1/agents/{agentId}/im-binding/slack/interactions`.
Slack callbacks are authenticated using the installation signing secret over the raw request body.

Feishu Apps must subscribe to the `card.action.trigger` callback through the existing long connection.
New QR registrations include this callback; existing Apps need it enabled in their developer console.

Approval requests appear in a private message to the task sender with **Approve** and **Deny** buttons.
Cards show the reason and action, without provider transport metadata or user IDs.
The provider remains paused; clicking a button answers the same live turn. Decisions are stored long
enough to reach the server replica holding the runtime socket, and the card is resolved after the
runtime acknowledges the answer. A failed card update is retried while the server is running. Duplicate clicks, wrong users, expired requests, changed bindings,
changed permission settings, and replaced runtime connections cannot approve an action.

Requests expire with the existing turn deadline. A replacement runtime connection invalidates requests
tied to its old connection in the registration transaction. Decision delivery checks the durable
connection and approval under the same Computer row lock, so a replacement on another server replica
cannot race an old acceptance. Any server replica can expire orphaned requests and retry resolved card updates
after a server restart; approvals are never replayed onto a new connection. Request records are removed after seven days.
This first version supports one-action decisions, with no session-wide approval button or arbitrary
provider question dialogs. Requests too large to display in full are denied.
