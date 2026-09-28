# Agent permissions

[简体中文](./zh-CN/agent-permissions.md)

Local Agents allow workspace file reads and edits by default. Codex uses `workspace-write` with
`on-request` approvals and disabled sandbox network access. Claude Code uses `acceptEdits` and its
native permission callback. Pi explicitly loads `npm:@gotgenes/pi-permission-system@35.0.1` through Pi’s native package loader;
its defaults allow file tools inside the workspace and ask before bash, external-directory access,
and other tools. Claude and Pi permission gates do not provide an OS sandbox.
Pi ignores project-scoped permission configuration and treats IM messages as literal requests;
its permission policy comes from Agent execution settings.

Routine Feishu reply/send commands and Slack `chat.postMessage` are allowed by default through
native command rules. Run these CLIs directly: the managed launcher loads the Turn credentials.
Explicit custom rules can still ask for approval or deny these commands. Other shell actions keep
the provider's permission checks.

In Agent execution settings, enter the designated approver’s Slack user ID (`U…`) or Feishu app-specific
open ID (`ou_…`) as the approval user. Only that user can answer the Agent's approval requests.
Without an approval user, actions requiring approval are denied. Cloud Agents always run with full
permissions and have no permission settings.

The optional rules field accepts provider-native JSON. Empty rules use the defaults above. For example:

| Provider | Rule example |
| --- | --- |
| Codex | `[{"pattern":["git","status"],"decision":"allow"}]` |
| Claude Code | `{"allow":["Bash(git status)"],"deny":["Bash(sudo *)"]}` |
| Pi | `{"bash":{"*":"ask","git status":"allow","rm -rf *":"deny"}}` |

Codex decisions are `allow`, `prompt`, or `forbidden`. Claude supports `allow`, `ask`, and `deny`
lists. Pi supports `allow`, `ask`, and `deny` values or pattern maps. Rules are validated before saving.
The Agent's self-configuration API cannot modify permission settings. Pi installs the pinned package
on the first turn of a local runtime and reuses that runtime’s cache; if it cannot load, the turn fails
before any prompt is sent.

Slack Apps must enable Interactivity with request URL
`{OPENTAG_PUBLIC_URL}/api/v1/im-bindings/slack/interactions`. The first-party distribution manifest
includes it. Custom Apps may instead use
`{OPENTAG_PUBLIC_URL}/api/v1/agents/{agentId}/im-binding/slack/interactions`.
Slack callbacks are authenticated using the installation signing secret over the raw request body.

Feishu Apps must subscribe to the `card.action.trigger` callback through the existing long connection.
New QR registrations include this callback; existing Apps need it enabled in their developer console.

Approval requests appear in the originating IM thread with **Approve once** and **Deny** buttons.
Cards show the reason and action, without provider transport metadata or approver IDs.
The provider remains paused; clicking a button answers the same live turn. Decisions are stored long
enough to reach the server replica holding the runtime socket, and the card is resolved after the
runtime acknowledges the answer. Duplicate clicks, wrong users, expired requests, changed bindings,
changed permission settings, and replaced runtime connections cannot approve an action.

Requests expire with the existing turn deadline. Disconnects and server restarts invalidate pending
execution rather than replaying approvals. Completed request records are removed after seven days.
This first version supports one-action decisions, with no session-wide approval button or arbitrary
provider question dialogs. Requests too large to display in full are denied.
