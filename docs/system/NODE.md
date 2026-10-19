---
title: "System"
description: "OpenTag architecture: identity model, Server/Client authority, runtimes, messaging, Agent capabilities, Cloud execution, and the Web App."
---

# System

OpenTag separates durable Server-owned identities and message facts from
Client-owned execution. The pages here define the boundaries that Session
lifecycle, placement, Provider runtimes, and message delivery must preserve,
and the contracts each subsystem implements.

## Pages

- **[Agent, Session, and Computer model](agent-session-computer-model.md)** —
  durable identity, conversation scope, placement, and execution resources.
- **[Server and Client Runtime boundary](server-client-boundary.md)** —
  control-plane authority, the Client connection, readiness, and
  authentication constraints.

## Domains

- **[runtime/](runtime/NODE.md)** — the Agent Runtime contract, runtime
  protocol, permissions, and self-configuration.
- **[messaging/](messaging/NODE.md)** — IM and Session messages, Channel and
  Thread Sessions, provider CLIs, and Feishu and Slack connections.
- **[capabilities/](capabilities/NODE.md)** — what Agents can use: Skills, MCP
  Servers, Context Trees, GitHub, and web tools.
- **[cloud/](cloud/NODE.md)** — Cloud Runner execution, persistence, context,
  and the Runner image.
- **[web/](web/NODE.md)** — Web App UI contract, surfaces, i18n, and analytics.
