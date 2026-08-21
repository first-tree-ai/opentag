# Direct provider CLI messaging

[简体中文](./zh-CN/direct-provider-cli.md)

OpenTag owns inbound IM routing, Integration credentials, temporary Client credential projection, and provider-native inbound references. It does not expose a message send, reply, Reaction, or upload API.

For every valid visible IM Turn, the Client creates a private `0600` environment file and passes only its path as `OPENTAG_PROVIDER_ENV_FILE`. The Agent sources that file and calls the official `lark-cli` or `slack api` command directly. The file is removed when the Turn finishes, retried during Session or Client shutdown if removal fails, and recovered by the next Client startup after a crash.

Provider-native cards, Blocks, files, threads, stickers, and Reactions stay in the provider CLI. OpenTag does not translate them or receive their content, provider message IDs, or results. Consequently, OpenTag has no outbound delivery status, audit trail, idempotency guarantee, stale-reply guard, or conversation-level outbound target restriction.

Both `direct` and `ambient` Turns receive the same credential lifecycle. `direct` means a human explicitly addressed the Agent or Session. `ambient` means the Agent overheard the message and should normally avoid redundant or intrusive participation, but it may still reply, react, send proactively, or take no action.

Direct provider CLI execution requires Runtime network access and grants the Agent every permission in the bound Bot token's scope, so the configured scopes must be treated as the deliberate Agent authority boundary. Feishu and Slack CLI installation readiness is reported independently from Codex or Claude Code readiness; handoff requires both the selected Agent Runtime and provider CLI to be ready, plus a ready ingress connection when the provider requires one.

Existing Slack bindings require one reauthorization after this upgrade so OpenTag can verify and retain Slack's Bot ID separately from its Bot User ID. That verified identity is used only to discard the bound Bot's own ingress before persistence and prevent message loops.
