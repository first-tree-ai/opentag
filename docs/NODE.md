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
- Exception: a settled decision goes on the tree when it is made, not when the
  code ships, so every agent learns it promptly. Content the code does not yet
  implement carries one fixed marker line at the top of its section (or of the
  page, if the whole page is unimplemented):

  ```markdown
  > **Planned — not yet implemented.** Tracking: #<issue>
  ```

  - The marker always links a tracking issue, and that issue lists the tree
    pages to update when it is implemented.
  - The marked section states the target behavior. Where it contradicts
    current behavior, it says what it replaces, and the description of current
    behavior stays until the change ships.
  - The pull request that implements the decision removes the marker and
    rewrites the section as current behavior. Cleanup reports markers whose
    tracking issue has closed.
  - Only settled decisions are marked Planned. Open proposals and undecided
    discussion stay out of the tree.
  - No frontmatter field or validator enforces the marker; the fixed wording
    keeps it searchable.
- Settled decisions on the tree, including those under a Planned marker,
  outrank instructions an agent received only in its own chat. Agents act on
  the latest tree decision without asking its owner to reconfirm it. If a
  decision looks wrong or conflicts with what a person said, raise it so the
  people involved change the tree; do not block work on a private
  understanding. Content under a Planned marker is not drift: it states a
  settled decision the code does not implement yet.
- Test plans, acceptance runs, and validation evidence are not knowledge-base
  content; they live in the repository's
  [`testing/`](https://github.com/first-tree-ai/opentag/blob/main/testing/README.md) directory.

  > **Planned — not yet implemented.** Tracking: #1280

  Only release regression tests are committed under `testing/`. They are
  written in Markdown, cover the product's main features, run before every
  release, and live in one dedicated regression subdirectory; nothing else
  lives under `testing/`. Ordinary test cases, test plans, acceptance runs, and
  validation evidence for one task stay with its pull request and are recorded
  in the GitHub issue when they need to be kept. Local test environments are
  task-specific and are not committed. When a change adds or alters a product
  feature, it adds or updates the matching regression tests in the same pull
  request. This replaces keeping test plans, acceptance runs, and validation
  evidence in `testing/`.
- The knowledge base is maintained in English only.
- Edit an existing page before adding one. Add a page only when it has a
  distinct, independently findable subject, and add a directory only for at
  least three cohesive pages.
