---
schemaVersion: 1
title: "openTag knowledge base"
description: "openTag product decisions, system architecture and contracts, and operating procedures, maintained as a Context Tree next to the code."
---

# openTag knowledge base

openTag lets people collaborate with long-lived Agent identities from Feishu
and Slack while the Agents coordinate work across isolated Sessions on Local
or Cloud Computers. This directory is openTag's Context Tree: the canonical
home for its durable decisions, contracts, and procedures. New readers start
with the [Quick Start](https://github.com/first-tree-ai/opentag/blob/main/README.md#quick-start)
and the [development guide](https://github.com/first-tree-ai/opentag/blob/main/DEVELOPMENT.md).

## Domains

- **[product/](product/NODE.md)** — What people experience: Agent
  collaboration, Tasks, Cloud Computer and billing, Doctor, and trademarks.
- **[system/](system/NODE.md)** — How openTag is built: the core identity
  model, Server/Client authority, Agent runtimes, messaging, Agent
  capabilities, Cloud execution, and the Web App.
- **[operations/](operations/NODE.md)** — How openTag is released, deployed,
  observed, and diagnosed.

## Decision

The knowledge base lives in the code repository and follows Context Tree
conventions: every directory has a `NODE.md` index, every page has `title` and
`description` frontmatter, and cross-domain relationships use `soft_links`
instead of duplicated text. Pages may hold decisions with their rationale as
well as specifications and operating procedures, because they change in the
same pull request as the code they describe.

## Constraints

- When a change alters a documented behavior, contract, or procedure, update
  the affected page in the same pull request. Code is the ground truth when a
  page and the code disagree; fix the page from source evidence.
- State current truth in the present tense. Delivery history, PR references,
  and dated status belong in Git history and pull request descriptions.
- Test plans, acceptance runs, and validation evidence are not knowledge-base
  content; they live in the repository's
  [`testing/`](https://github.com/first-tree-ai/opentag/blob/main/testing/README.md) directory.
- The knowledge base is maintained in English only.
- Edit an existing page before adding one. Add a page only when it has a
  distinct, independently findable subject, and add a directory only for at
  least three cohesive pages.
