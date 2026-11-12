---
title: "Runtime"
description: "Agent Runtime contract, Client/Server runtime protocol, Agent permissions, and Agent self-configuration."
---

# Runtime

The runtime layer executes Agent Turns through Codex, Claude Code, or Pi behind
one Provider-neutral contract, and negotiates its protocol with the Server.

## Pages

- **[Agent Runtime contract](agent-runtime-contract.md)** — the normative
  Provider-neutral execution contract and Provider support.
- **[Runtime protocol compatibility](runtime-protocol.md)** — protocol,
  schema, and capability versions between Client and Server.
- **[Background work](background-work.md)** — how a Run waits for background work,
  stops at its limit, and tells the Session what became of the work.
- **[Agent permissions](agent-permissions.md)** — permission modes, command
  rules, and IM approval requests.
- **[Agent self-configuration](agent-self-configuration.md)** — what an Agent
  may change about itself through the CLI.
- **[Agent status pipeline](computer-status-pipeline.md)** — single-replica registry,
  independent heartbeats, bounded validation and foreground batch status reads.
