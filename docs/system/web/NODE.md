---
title: "Web App"
description: "Design guide, Web UI contract, Computer and Skill surfaces, internationalization, and analytics of the openTag Web App."
---

# Web App

The Web App is the admin console for configuring Agents, their Computers, and
their capabilities, and for judging whether each Agent is healthy. A surface
shows only what helps an admin do one of those two things. Admins cannot act
on an individual Task, so per-Task process details such as pending approvals
or per-message states stay off the Web; approvals are handled by the people
involved in Feishu or Slack. Why: detail an admin cannot act on adds reading
without helping configure an Agent or judge its health. Its design guide and
UI contract define visual direction and application behavior together.

## Pages

- **[Bot connection preview](bot-connection-preview.md)** — isolated local playground
  for the last Agent setup step, with production components and simulated connections.

- **[openTag design guide](design.md)** — shared visual rules and website
  references, with application implementation ownership made explicit.

- **[Web UI contract](web-ui-contract.md)** — composition rules and
  acceptance criteria for product UI.
- **[Computer connection controls](computer-connection-controls.md)** — the
  Account Computer connection surface.
- **[Skill details reader](skill-details-reader.md)** — reading a Skill's full
  instructions and files.
- **[Web i18n](i18n.md)** — locale strategy and message ownership.
- **[Web App analytics](web-analytics.md)** — what is measured and what is
  never sent.
