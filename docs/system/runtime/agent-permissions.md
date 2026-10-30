---
title: "Agent permissions"
description: "Per-Provider permission modes, native command rules, and the Slack/Feishu approval flow for Local Agents."
---

# Agent permissions

Local Codex Agents use `workspace-write` with `on-request` approvals and disabled sandbox network
access. Local Claude Code Agents use `auto`: its native classifier reviews actions and its permission
callback sends remaining requests to the task sender. Claude Code must support `auto` and
`--permission-prompt-tool`. Claude's native gate does not provide an OS sandbox.
Local Claude loads native user, project, and local settings, plugins, hooks, and Skill shell execution.
Its environment preserves operator-provided plugin variables. Users and Agents manage these through
native configuration and commands, preferably at project scope under the existing Agent Home.
Provider homes, native login, and Session history locations stay unchanged. Global settings retain
their native scope; project directories do not isolate them.
Claude discovers synced project Skills natively. External packaged Skills, including Context Tree
Skills, are linked into a private plugin with a fresh explicit `opentag-<random-id>` name per Run,
without linking project Skills a second time. Skill names use that Run's namespace, as listed in
the native catalog. Unavailable external Skills are skipped. Skills retain native metadata
and original resources; edits remain visible during a run. Claude honors
skill `allowed-tools` grants, which can pre-approve commands otherwise subject to approval. Approvals
are practical guardrails, not isolation from writable skills or approval-free file reads and uploads.
OpenTag's supplementary temporary MCP configuration uses fresh service names per Run, keeping
platform tools and their grant rules separate from native user servers. The gateway name stays
short enough to preserve its original tool-name budget. Native plugins and hooks execute as trusted local code and can run outside tool
approvals, and a model-written project configuration can enable them on the next Run. The inherited
daemon environment can include long-lived operator credentials; these are not fenced or revoked
with an execution. See the [native trust contract](agent-runtime-contract.md#local-claude-native-configuration-and-trust).
Subscription login is preserved. Provider readiness checks user-scoped authentication only, while
Agent-project authentication must be checked natively from Agent Home. Routine model-option queries
suppress hooks and MCP connections but still read native settings and may execute credential helpers;
their success does not establish that an installed plugin loaded or its tools worked. Chrome integration
also follows native configuration; OpenTag supplies no browser UI or additional browser isolation.
Pi always runs without approvals and has no permission settings or permission extension.

Native command rules allow Feishu and Slack message reads, sends, edits, reactions, conversation
lookup, native attachment commands, and `opentag` (`opentag-dev`, `opentag-staging`) and
`context-tree` CLI commands. Run the CLIs directly: the managed launcher loads the
Turn credentials. Quoted literal multiline bodies and JSON content use the native CLI; there is no
reply helper. Simple compound commands and pipelines are checked by the provider, with explicit
rules for `head`, `tail`, `cat`, `echo`, `printf`, `jq`, `wc`, `stat`, and `sleep` (rate limits).
Other actions follow native checks, including any active skill permission grants.
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
Both cards include a small footer: "Whitelist command or disable approvals in Agent Model Settings".
Only "Agent Model Settings" is linked, opening that Agent's Model settings directly.
Slack cards use a bold title at the same size as the body text and a separate explanation.
When the Client supplies structured command presentation, the full redacted command appears
in a native code block, preserving line breaks and literal formatting characters. The reason and
command remain available in notification and screen-reader text and after the decision. Older
Clients retain their full plain-text description. Execution outside the sandbox is not inferred
from free-text reasons or the presence of an approval request.
The provider remains paused; clicking a button answers the same live turn. Decisions are stored long
enough to reach the server replica holding the runtime socket, and the card is resolved after the
runtime acknowledges the answer. A failed card update is retried while the server is running. Duplicate clicks, wrong users, expired requests, changed bindings,
changed permission settings, and replaced runtime connections cannot approve an action.

Requests expire with the existing turn deadline. A replacement runtime connection invalidates requests
tied to its old connection in the registration transaction. Decision delivery checks the durable
connection and approval under the same Computer row lock, so a replacement on another server replica
cannot race an old acceptance. Heartbeats and disconnects also match the durable connection ID,
so an old socket cannot disconnect a replacement that reuses the same process instance. Any server
replica can expire orphaned requests and retry resolved card updates after a server restart; approvals
are never replayed onto a new connection. Request records are removed after seven days.
This first version supports one-action decisions, with no session-wide approval button or arbitrary
provider question dialogs. Requests too large to display in full are denied.

Codex MCP tool approvals include native form-mode elicitation requests explicitly marked
`mcp_tool_call`. The adapter accepts only the empty-object approval schema and a valid server,
message, and tool-argument object. The card shows the provider's action message and redacted
server/arguments, without thread or turn transport metadata. Tool arguments are rendered as
structured JSON after redaction, preserving nested keys even when their names match transport
metadata. Acceptance answers only that invocation with an empty object; decline and cancel retain
their native elicitation actions.
Legacy question-array approvals remain supported. Ordinary or malformed forms remain unsupported
questions and are cancelled by the existing Turn guard, including forms carrying approval-like
choices. No session-wide MCP grant is created.
