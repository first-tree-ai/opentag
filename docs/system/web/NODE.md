---
title: "Web App"
description: "Admin-console scope and experience principles, UX review rubric, design guide, Web UI contract, Computer and Skill surfaces, internationalization, and analytics of the openTag Web App."
---

# Web App

The Web App is the admin console for configuring Agents, their Computers, and
their capabilities, and for judging whether each Agent is healthy. A surface
shows only what helps an admin do one of those two things. Per-Task process details such as pending approvals
or per-message states stay off the Web; approvals are handled by the people
involved in Feishu or Slack. Why: detail an admin cannot act on adds reading
without helping configure an Agent or judge its health. Its design guide and
UI contract define visual direction and application behavior together.

## Experience principles

The Web and the connect command follow the team's product-experience
principles. This section says where each is applied to openTag, so new UI and
UX reviews start from the existing rule instead of reinventing it. Reviews check
them with the [UX review rubric](ux-review-rubric.md).

- **Only what the admin can act on**: the admin-console scope above.
- **One fact, one place, one label**: a state uses one label on every page
  ([copy](web-ui-contract.md#internationalization-and-copy)); a connect surface
  shows one status, the command window's
  ([command window](computer-connection-controls.md#command-window)); a schedule
  row labels only non-default states
  ([schedules](web-ui-contract.md#schedule-handoff-feedback)).
- **Say what happened and what to do next**: messages carry no internal states,
  codes, or IDs ([copy](web-ui-contract.md#internationalization-and-copy),
  [schedules](web-ui-contract.md#schedule-handoff-feedback)).
- **One direct fix action per problem**: each fixable Agent roster state links to
  where it is fixed; a paused Agent gets none
  ([roster](web-ui-contract.md#layout-and-responsive-acceptance)).
- **Don't guess or pretend**: a cron rule with no exact plain form is shown as
  written ([schedules](web-ui-contract.md#schedule-handoff-feedback)); roster
  rows render the current Server status snapshot directly, with no browser hold
  ([roster](web-ui-contract.md#layout-and-responsive-acceptance)).
- **One command, no prompts, safe to rerun**: the connect command repairs or
  confirms an existing computer instead of adding a duplicate
  ([Server and Client boundary](../server-client-boundary.md),
  [access](computer-connection-controls.md#access-and-compatibility)).
- **One intent, one component, one wording**: every connect surface uses the
  shared command window; Chinese copy says Agent, 知识树 and 指令 everywhere
  ([glossary](i18n.md#glossary)).
- **Fewer steps**: deleting a running Agent pauses it inside the one confirmed
  action ([states](web-ui-contract.md#page-and-interaction-states)).
- **The action matches the message**: connector failures offer Edit address or
  Update key, with Retry only for transient causes
  ([MCP Web UI](../capabilities/mcp-server-integration.md#web-ui)).
- **Keyboard focus is never lost**: a pending switch keeps focus and a new setup
  step focuses its heading
  ([accessibility](web-ui-contract.md#accessibility-acceptance)).

## Pages

- **[Bot connection preview](bot-connection-preview.md)** — isolated local playground
  for the last Agent setup step, with production components and simulated connections.

- **[openTag design guide](design.md)** — shared visual rules and website
  references, with application implementation ownership made explicit.

- **[Web UI contract](web-ui-contract.md)** — composition rules and
  acceptance criteria for product UI.
- **[UX review rubric](ux-review-rubric.md)** — observable checks, severity,
  finding format, and what not to report when reviewing the Web.
- **[Computer connection controls](computer-connection-controls.md)** — the
  Account Computer connection surface.
- **[Skill details reader](skill-details-reader.md)** — reading a Skill's full
  instructions and files.
- **[Web i18n](i18n.md)** — locale strategy and message ownership.
- **[Web App analytics](web-analytics.md)** — what is measured and what is
  never sent.
