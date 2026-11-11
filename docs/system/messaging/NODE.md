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
- **[Server-to-Client delivery](server-client-delivery.md)** — IM, Session, and
  scheduled hand-offs compared: records, frames, receipts, waits, timeouts,
  retries, Client deduplication, restart recovery, and failure notices.
- **[Unified delivery model](unified-delivery.md)** — proposal under review:
  one envelope, state machine, receipt window, retry ownership, deduplication
  contract, and notifier for the three hand-offs, with a phased plan.
- **[IM Channel and Thread Sessions](thread-sessions.md)** — lazy Thread
  Sessions, direct continuity, observer copies, and thread history.
- **[IM task feedback and safe recovery](im-feedback.md)** — system-owned reactions, offline notices, failure messages,
  Account confirmations, explicit retry attempts, and unknown-send reconciliation.
- **[IM delivery claim queries](im-delivery-claim.md)** — indexed delivery
  selection, eligibility hints, transactional custody checks, and the offline
  retry and termination policy.
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
