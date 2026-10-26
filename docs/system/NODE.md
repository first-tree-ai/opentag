---
title: "System"
description: "openTag architecture: identity model, Server/Client authority, runtimes, messaging, Agent capabilities, Cloud execution, and the Web App."
---

# System

openTag separates durable Server-owned identities and message facts from
Client-owned execution. The pages here define the boundaries that Session
lifecycle, placement, Provider runtimes, and message delivery must preserve,
and the contracts each subsystem implements.

## Pages

- **[Agent, Session, and Computer model](agent-session-computer-model.md)** —
  durable identity, conversation scope, placement, and execution resources.
- **[Agent usage accounting](agent-usage.md)** — where task and token counts come
  from, the Provider token rules, the safe-integer bounds, and the bounded
  UTC-day read shape.
- **[Server and Client Runtime boundary](server-client-boundary.md)** —
  control-plane authority, the Client connection, readiness, and
  authentication constraints.

- **[Database read/write standards](database-read-write-standards.md)** —
  atomicity, authorization, read consistency, lock order, external effects,
  idempotency, failure handling, and verification requirements for persistence changes.

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
