---
title: "Custom Slack Apps"
description: "Per-Agent user-created Slack Apps in one Slack Team: setup flow, data model, and compatibility with official bindings."
---

# Custom Slack Apps

See [Slack setup](slack-app-setup.md) for the capability contract and operating instructions.

## Design and user flow

The current Web entry is **Connect Slack** in both Agent setup and Messaging settings. Local automatic setup uses one command and code; manual setup replaces the dialog contents rather than adding another form. Existing official bindings retain restricted OAuth recovery.

Each Agent uses a different user-created Slack App, installed in the same Team. A current App/Team pair belongs to one
Agent; another Agent cannot claim it. Agent creation succeeds without a Computer or messaging app. Connecting an app
retains the existing Computer requirement. The creation guide and Messaging settings share one concrete configuration
form, available even when first-party OAuth is unavailable.

The user opens the prefilled Slack creation link, chooses the Team, creates and installs the App, then pastes only
**Bot User OAuth Token** and **Signing Secret** and saves once. The manifest includes the existing 18 bot scopes,
7 events, Agent-specific Events URL, writable Messages tab, and existing Interactivity callback. After saving, the user
confirms **Verified → Save Changes** in Slack Event Subscriptions and sends the Bot a DM. No second manifest paste,
manual App/Team/Bot ID entry, or final confirmation page is required. Existing Apps can repair their URLs/events from
collapsed help without replacing their other configuration.

The new App's Bot name follows the Agent name within Slack's naming rules, with its exact prefilled `@name` visible
before opening Slack. Existing Apps keep their current names. Creation recovery stays in collapsed help: check Your Apps
first, finish installation for an App already created, or wait before retrying a rate-limited creation. No automatic
creation retry is introduced. Credential updates are directly available in the App dialog and show only the Token by
default; expand the Secret field when changing it. A connection that has received a real message verifies updated
credentials with another DM, without repeating an unchanged Events URL setup. The saved status and identity/runtime
readiness checks remain unchanged.

```mermaid
sequenceDiagram
    actor U as User
    participant W as OpenTag Web
    participant S as OpenTag Server
    participant D as Existing database
    participant L as Slack
    participant A as Agent runtime
    U->>W: Create Agent
    W->>S: Create request
    S->>D: Save Agent
    S-->>W: Agent ID
    Note over U,W: Messaging can be configured later; prepare Computer before connecting
    U->>W: Use your own Slack App
    W->>S: GET configuration
    S-->>W: Trusted Events URL and current binding expectation
    W-->>U: Prefilled Bot name and Slack creation link
    U->>L: Choose Team, create and install App
    L-->>U: Copy Bot Token and Signing Secret
    U->>W: Fill two credentials and save once
    W->>S: POST configuration with expected binding/generation
    S->>L: auth.test, actual scopes, bots.info
    L-->>S: Verified token-derived App/Team/Bot identity
    S->>D: Recheck authority and expectation; encrypt and activate atomically
    S-->>W: Installed; waiting for signed real event
    U->>L: Verify Events URL
    L->>S: Signed URL challenge
    S-->>L: Challenge response
    Note over S,L: Challenge alone does not close App/Team/Bot identity
    U->>L: Save Changes, then DM the Bot
    L->>S: Signed real event
    S->>D: Validate identity; existing scoped receipt/message/Session
    S->>A: Existing delivery path
    A->>L: Reply through existing credential proxy
    W->>S: Read readiness while pending
    S-->>W: Identity and runtime ready
```

## Data, compatibility, and simplicity

There are **no new database tables, columns, persisted fields, or migrations**. Reuse encrypted `slack_installations`,
`im_bindings`, generation fences, existing receipt keys, messages and Sessions. There is no `configuration_method`,
`slack_bot_message_policy`, App registry, new setup state machine, or generic Provider framework. Recovery preference is
derived by comparing existing installation credentials with configured first-party OAuth material.

This includes necessary GET/POST configuration APIs as well as Web changes. The server derives the App identity from
`auth.test` and `bots.info`, checks actual scopes, and rejects cross-App updates before writing. Nonempty credential
updates preserve blank values and require the same App/Team/Bot identity. The commit transaction rechecks Account
authority, Computer, binding ID and generation. Uncertain save results are resolved by reading state, never automatic POST
replay. Credentials are cleared on success, close, and Agent changes and are never returned by the management API.

First-party OAuth start/callback and explicit replacement semantics, signed Events, proxy/runtime, old CLI contracts,
and Feishu remain. Older servers keep OAuth recovery; missing `slackOAuthAvailable` retains the old behavior and only
explicit `false` hides the entry. Both human and other-Bot messages follow Agent `receiveMode`; `all_message` ambient
messages can complete silently. Binding-scoped projection/delivery prevents Team-wide deduplication from dropping events
seen independently by two Apps.
