# Direct provider CLI messaging

[简体中文](./zh-CN/direct-provider-cli.md)

The local package, path, execution-identity, and credential handoff foundation is
defined by the shipped Provider CLI management foundation. OpenTag-managed Provider
CLIs are account-global commands that the user may also invoke directly; only an
authorized Turn receives OpenTag-projected credentials.

OpenTag owns inbound IM routing, Integration credentials, temporary Client credential projection, and provider-native inbound references. It does not expose a message send, reply, Reaction, or upload API.

An active Feishu/Lark or Slack binding is the requirement signal. The daemon may repair only the corresponding
OpenTag-managed artifact and validates that exact CLI with the real bound credential before reporting it ready; it never
replaces an external installation or foreign shim. `opentag doctor` and the portable installer only report static
account-global installation state. They do not install, repair, validate credentials, or infer login/subscription state.

For every valid visible Session Turn that may write to IM, including an IM delivery or an internal-collaboration callback,
the Client creates a private `0600` environment file and passes only its path as `OPENTAG_PROVIDER_ENV_FILE`. The Agent
sources that file and calls the official `lark-cli` or `slack api` command directly. The file is removed when the Turn
finishes, retried during Session or Client shutdown if removal fails, and recovered by the next Client startup after a
crash. Internal Sessions never receive the file.

An IM-delivery Turn receives the provider-native message reference from that event. A visible collaboration callback
instead receives a non-secret default outbox context from credential grant v2. The Server derives that context from the
target Session's existing channel or thread scope in the same authorization operation that grants credentials; the
Client and Agent cannot nominate an OpenTag outbox target. A callback to a thread Session keeps its provider-native thread
scope. This context is a default delivery target, not a restriction on the broader Bot-token authority described below.

For Feishu Turns, the managed Turn context instructs the Agent to pass rich or multiline `lark-cli` text through a
non-interpolating POSIX heredoc or PowerShell here-string variable. It also requires a pre-send check that rejects an
intended multiline body when shell quoting left multiple literal `\n` tokens but no real newline. The check deliberately
does not rewrite every `\n`, because code and prose may intentionally discuss that token.

Provider-native cards, Blocks, files, threads, stickers, and Reactions stay in the provider CLI. OpenTag does not translate them or receive their content, provider message IDs, or results. Consequently, OpenTag has no outbound delivery status, audit trail, idempotency guarantee, stale-reply guard, or conversation-level outbound target restriction.

Both `direct` and `ambient` Turns receive the same credential lifecycle. `direct` means a human explicitly addressed the Agent or Session. `ambient` means the Agent overheard the message and should normally avoid redundant or intrusive participation, but it may still reply, react, send proactively, or take no action.

Direct provider CLI execution requires Runtime network access and grants the Agent every permission in the bound Bot token's scope, so the configured scopes must be treated as the deliberate Agent authority boundary. Feishu and Slack CLI installation readiness is reported independently from Codex or Claude Code readiness; handoff requires both the selected Agent Runtime and provider CLI to be ready, plus a ready ingress connection when the provider requires one.

Session conversation scope limits OpenTag's automatic persistence, history bootstrap, and routing; it does not restrict
provider API targets available to the projected Bot token. The Agent may query additional native history when the task
requires it, including another conversation the Bot can access. Provider query results remain Runtime context and do not
automatically create `ImMessage` records or cross-Session deliveries.

Existing Slack bindings require one reauthorization after this upgrade so OpenTag can verify and retain Slack's Bot ID separately from its Bot User ID. That verified identity is used only to discard the bound Bot's own ingress before persistence and prevent message loops.
