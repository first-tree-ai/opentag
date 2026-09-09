# Direct provider CLI messaging

[简体中文](./zh-CN/direct-provider-cli.md)

The local package, path, execution-identity, and credential handoff foundation is
defined by the shipped Provider CLI management foundation. OpenTag-managed Provider
CLIs are account-global commands that the user may also invoke directly; only an
authorized Turn receives OpenTag-projected credentials.

OpenTag owns inbound IM routing, Integration credentials, temporary Client credential projection, and provider-native inbound references. It does not expose a message send, reply, Reaction, or upload API.

The targeted first-setup `opentag connect` command is the only installer for both official Provider CLIs during
onboarding. It is non-interactive, returns bounded next actions, and can be run by a person or an Agent. The daemon
independently inspects and reports both CLIs while setup is incomplete; it does not race the foreground installer.

After a Feishu/Lark or Slack binding becomes active, the daemon may repair only that binding's corresponding
OpenTag-managed artifact and validates the exact CLI with the real bound credential before reporting it ready; it never
replaces an external installation or foreign shim. Automatic install/repair and credential validation are bounded: the
Server keeps the terminal observation on the same connection, readiness GETs never refill the budget, and a replacement
request or grant id cannot start a new episode. Manual failures such as `unsupported_platform`, `global_bin_unavailable`,
`integrity_failed`, and a final ensure `version_incompatible` settle immediately. Web and Agent diagnostics map those
allowlisted reasons to the next step. An inspection `version_incompatible` may still be repaired with a supported
managed artifact. Periodic Client inspection stays read-only, keeps the visible failure, and can recover after a real
local repair without ensure. Explicit Check again / `refreshPreparation` opens one new bounded recovery (duplicate
clicks coalesce per Agent). Reconnect, credential generation change, and an actual Computer placement change may start a
new episode; a repeated identical placement notification must not. Public reasons are allowlisted and negotiated with
reconcile capability v2; older peers keep exact v1 frames and a generic stable diagnostic after a bounded unknown
episode. HTTP responses keep the pre-#490 shape unless the caller opts in with `x-opentag-provider-cli-reason: 2`.

`opentag doctor` and the portable installer only report static account-global installation state. They do not install,
repair, validate credentials, or infer login/subscription state.

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

Provider-native cards, Blocks, files, threads, stickers, and Reactions stay in the provider CLI. OpenTag does not translate them, send them, or expose a message send, reply, Reaction, or upload API. Direct CLI execution remains the Agent's only outbound path and retains that authority.

As a bounded capture exception for Task history, the Turn runner records successful Lark `+messages-send` / `+messages-reply` mutations (and native or raw API equivalents) from the official CLI. Capture is opt-in on Feishu Turn plans (`captureOutgoingReplies: true`) for report-bearing Turns; visible inbox and other prepares omit the field, so a successful send through that launcher does not persist receipts. Slack plans must not enable capture. The supported official lark-cli range is `>=1.0.92 <2.0.0`, which supplies the required `ok`/`identity` envelope and raw API JSON output. Older external versions are rejected during selection. Classified successful send/reply stdout with a missing or unrecognized envelope is still incomplete rather than a completed zero-send Turn. Capture also requires a successful exit, a provider message ID, and a chat ID. Shortcut send/reply receipts do not include the body, so after a valid send the runner may issue a bounded read-only raw `GET` of that message using the same verified target and environment. If that read fails — including missing read permission — the send still succeeded; OpenTag keeps the receipt and marks content unavailable. It never substitutes argv Markdown or model output, never retries a successful send, and never treats a send receipt as proof that a person read the message.

Captured receipts are private per-run files under the existing Home/Session/Run plan identity. They are collected into the Turn report before construction, hashed only when present so legacy reports keep their old hash, and omitted from old Servers that did not negotiate Turn report v2. Slack is not collected as Lark. Bounds follow the existing 64 KiB runtime frame and 48 KiB `finalText` (before JSON escaping); a receipts-only report must fit, and outgoing content is preferred over the optional runtime summary when budgeting.

Capture is observational and covers only recognized message mutations through the managed official CLI launcher. Other processes, SDK calls, Reactions, edits, and historical sends are not backfilled. A snapshot becomes available with the terminal Turn report. Reports hold at most 16 replies, 8 KiB per text/raw field and 32 KiB total; truncation or omitted content is explicit. Private chats match the chat; groups and topics also require matching root/thread evidence. The message body is read from the provider, never reconstructed from arguments.

The negotiated report version is fixed when the Turn starts, so disconnects cannot silently drop the snapshot. Receipt files are removed only after the Turn report is durably stored. Startup recovery invalidates execution plans but preserves receipt-only evidence. Recovery and the next Session prepare also sweep inspectable abandoned Run directories older than seven days. The current active Run and Runs with inflight writers remain protected. Missing nested receipt directories are treated as absent; unsafe files, unknown entries, or uninspectable directories preserve the evidence. A crash before report persistence cannot automatically reconstruct the original Task scope; the recovered Turn remains uncertain and reply history unavailable rather than claiming no send. Once persisted, the existing report replay path retains replies and a canonical JSON hash across reconnects and JSONB storage.

OpenTag still has no outbound delivery status, idempotency guarantee, stale-reply guard, or conversation-level outbound target restriction beyond associating captured receipts with the originating Task conversation.

Both `direct` and `ambient` Turns receive the same credential lifecycle. `direct` means a human explicitly addressed the Agent or Session. `ambient` means the Agent overheard the message and should normally avoid redundant or intrusive participation, but it may still reply, react, send proactively, or take no action.

Direct provider CLI execution requires Runtime network access and grants the Agent every permission in the bound Bot token's scope, so the configured scopes must be treated as the deliberate Agent authority boundary. Feishu and Slack CLI installation readiness is reported independently from Codex or Claude Code readiness; handoff requires both the selected Agent Runtime and provider CLI to be ready, plus a ready ingress connection when the provider requires one.

Session conversation scope limits OpenTag's automatic persistence, history bootstrap, and routing; it does not restrict
provider API targets available to the projected Bot token. The Agent may query additional native history when the task
requires it, including another conversation the Bot can access. Provider query results remain Runtime context and do not
automatically create `ImMessage` records or cross-Session deliveries.

Existing Slack bindings require one reauthorization after this upgrade so OpenTag can verify and retain Slack's Bot ID separately from its Bot User ID. That verified identity is used only to discard the bound Bot's own ingress before persistence and prevent message loops.
