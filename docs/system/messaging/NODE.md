---
title: "Messaging"
description: "IM and Session message domains, Channel and Thread Sessions, provider CLI sending, content delivery, and Feishu and Slack connections."
---

# Messaging

Messaging covers how human-visible IM messages reach Agent Sessions, how
Sessions collaborate with each other, and how Agents reply through the official
provider CLIs.

## Pages

- **[Message domains and routing](message-domains.md)** — IM messages versus
  Session messages, attention, and the human-visible send path.
- **[IM Channel and Thread Sessions](thread-sessions.md)** — lazy Thread
  Sessions, direct continuity, observer copies, and thread history.
- **[IM delivery claim queries](im-delivery-claim.md)** — indexed delivery
  selection, eligibility hints, and transactional custody checks.
- **[IM content and attachment delivery](im-content-delivery.md)** — how
  provider message structure and resources become Agent input.
- **[Internal Session collaboration](internal-session-collaboration.md)** — the
  Session CLI and callbacks into visible Sessions.
- **[Direct provider CLI messaging](direct-provider-cli.md)** — sending through
  the official Feishu and Slack CLIs with Turn-scoped credentials.
- **[Feishu connection lifecycle](feishu-connection-lifecycle.md)** — durable
  authorization and recovery for Feishu Apps.
- **[Slack App connections](slack-app-setup.md)** — Slack App, Team, and Bot
  ownership per Agent, and setup instructions.
- **[Custom Slack Apps](custom-slack-apps.md)** — per-Agent user-created Slack
  Apps in one Slack Team.
- **[Slack Agent provisioning](slack-agent-provisioning.md)** — creating an
  Agent with its own Slack App from Slack.
