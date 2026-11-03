# Agent list: coding assistant sign-in required

Verifies how the Agent list presents an Agent whose local Computer reports its coding assistant (Codex, Claude Code)
as installed but signed out (`providerReadiness` status `sign-in`). Supports the Agent roster rules in the
[Web UI contract](../../../docs/system/web/web-ui-contract.md).

## Method

The real `AgentList` component and the real `projectAgentAvailability` projection were mounted in a temporary,
production-bundled page with the repository's fonts, theme, and English/Chinese messages. Each row is fed a
synthetic local Computer that is online, has an active messaging binding, and reports the Agent's Provider as
`sign-in`; a third row reports `ready` for contrast. No Server, database, daemon, or Provider account was used, so
this establishes presentation, not that a real Computer reports `sign-in` after a sign-out.

The destination of the row's link was captured from the Agent Setup Lab (`/internal/agent-setup`, page
**验证运行环境**, state **登录 Runtime**), which renders the same setup surface against its in-memory adapter.

## Before

The row stated the problem but not where to fix it, and its only action read **继续设置 / Continue setup**, which
describes an Agent left mid-setup rather than one whose assistant was signed out later.

- [Chinese, 1440px](before-zh-1440.png)
- [Chinese, 390px](before-zh-390.png)

## After

The row keeps the warning label, adds the Computer to sign in on, and names the action for what it does. The link
still opens Agent setup for that Agent, which repeats the instruction and offers **重新检查 / Check again**.

- [Chinese, 1440px](after-zh-1440.png), [Chinese, 390px](after-zh-390.png)
- [English, 1440px](after-en-1440.png), [English, 390px](after-en-390.png)
- [Setup destination, Chinese, 1440px](setup-sign-in-zh-1440.png)
- Long Agent and Computer names: [Chinese, 1440px](long-name-zh-1440.png), [English, 320px](long-name-en-320.png)

| | Before | After |
| --- | --- | --- |
| Label | 需要登录 Claude Code | 需要登录 Claude Code |
| Detail | — | 请在 {Computer} 上登录 |
| Action | 继续设置 → | 检查登录状态 → |

At 320, 390, 768, and 1440px in both languages the page had no horizontal overflow and no page errors, and every
sign-in row linked to `/agents/setup?agentId=<that Agent>`. The detail line is capped at 20rem and wraps anywhere, so
a 61-character Computer name wraps inside the status column instead of taking width from the Agent name (the status
column measured 320px at 1440px and 768px). A missing installation keeps **Continue setup**; only `sign-in` changed.
