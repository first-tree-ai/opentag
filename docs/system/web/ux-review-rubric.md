---
title: "UX review rubric"
description: "Observable checks for reviewing the openTag Web (an admin console) and the connect command, with severity, finding format, and rulings on what not to report."
---

# UX review rubric

## Statement

A reviewer of the openTag Web judges what they **observe while using the
product**, not what the code intends. Every check is a question that a
screenshot, an accessibility snapshot, or a short task attempt can answer. The
checks make the team's product-experience principles and the scope in
[Web App](NODE.md) checkable; the rules they test are specified in the
[Web UI contract](web-ui-contract.md), [Computer connection
controls](computer-connection-controls.md), and [Web i18n](i18n.md).

**Lens: the Web is an admin console.** People work with Agents in Feishu or
Slack; the Web exists for admins to configure Agents and judge whether they are
healthy. A finding asks whether the surface helps with one of those two jobs.

Before reporting a finding, reproduce it with real interaction. Browser
automation can miss events a person triggers (such as paste), bypass
file-picker filters, or run in a different time zone than the reader.

## Checks

A finding cites one check.

### O Outcome first

Users care about the work an Agent did, not the configuration behind it.

- **O1** On each page, can the user tell within five seconds what work happened
  or is happening, before any configuration detail?
- **O2** Does a Task view lead with the outcome (result, artifact, decision,
  blocker) rather than the raw message or runtime log?
- **O3** Is a finished result findable again from the place the user would look
  a week later?

### M Messaging first

Work starts and is acted on in the team's existing IM conversation.

- **M1** Does the product send the user back to their IM where that is the
  natural place to act, instead of asking them to restart work in the Web?
- **M2** Does a Task seen in the Web name the IM and the kind of conversation
  it came from (private or group chat), so the admin can find it there?

### H Agent health at a glance

- **H1** Are Agent identity, state (working, blocked, idle, offline),
  permissions, and current activity visible without opening settings?
- **H2** When an Agent is blocked on something the admin can fix, is that state
  prominent, with one action that goes where it is fixed?
- **H3** Can the user move from overview (all Agents, Tasks) to summary to
  execution detail and back without losing their place?

### S Configuration supports the work

- **S1** Does setup reach a first working Agent quickly, rather than stopping
  at configuration the user cannot yet value?
- **S2** Are Computers, runtimes, connectors, and skills presented as means to
  an Agent's work, not as the main navigation model?

### A Agent-facing clarity

- **A1** Does copy use product terms from the [glossary](i18n.md#glossary)
  instead of system terms (session, client, provider, binding, preset) where a
  product term exists? A system term is acceptable only when the user must act
  on it and the copy explains it.
- **A2** Can a first-time user complete a step without a concept the page never
  explained?
- **A3** Can a copied command, invite, or error message be understood by a
  person or an Agent with no prior context?
- **A4** When a capability is missing (Computer offline, connector not
  connected, upstream failure), is only the dependent action blocked, with the
  consequence explained, while the rest of the page stays usable? Does the page
  avoid pushing the user to connect or install something the requested outcome
  does not need?

### C Web UI contract

- **C1** Does each data-backed surface handle loading, content, empty, partial,
  recoverable failure (with retry), and terminal failure (with a next action)?
  Empty states say what the area is for and offer the first action.
- **C2** At 320, 390, 768, and 1440 px: no page-level horizontal overflow, no
  clipped or overlapping controls, touch targets usable at 390 px.
- **C3** Keyboard: every action reachable with Tab, focus kept after an action,
  dialogs trap and restore focus, Escape closes. No axe violations at WCAG 2.2
  AA.
- **C4** Chinese and English: copy is natural in both, no untranslated strings,
  no layout breakage from longer English or denser Chinese.
- **C5** The same intent uses the same component, wording, and placement across
  pages.

### G General usability

- **G1** Is the primary action on each page obvious and singular?
- **G2** Does every action give feedback (progress, success, failure) within one
  second, and are destructive actions confirmed?
- **G3** Is anything wrong, stale, contradictory, or guessed compared with what
  the user just did?
- **G4** Is every control, step, and line of copy necessary? Explanatory text
  that repeats the title, redundant navigation, and repeated status lines are
  findings.
- **G5** Do messages say what happened and the next step, without internal
  states, codes, IDs, or mechanics? Does each fix action match its message?

### CX Connect command

The one command the Web gives for connecting a Computer is judged by running it
on machines in every state.

- **CX1** One command: it is all a user needs on any machine state, and exits 0
  whenever success is possible.
- **CX2** No duplicates: rerunning on a home that keeps its installation never
  adds a second Computer; the Account's existing Computer for that installation
  is confirmed or repaired in place (see
  [Server and Client boundary](../server-client-boundary.md)).
- **CX3** Healthy rerun: prints the normal one-line success, keeps the same
  Computer and running service, and consumes the code so the Web shows
  connected.
- **CX4** Repair in place: a broken connection is repaired and keeps its
  Computer.
- **CX5** Upgrade first: an outdated install is upgraded before connecting; a
  current one is not reinstalled.
- **CX6** Account conflict: a machine bound to another Account stops with a
  short explanation and next step; nothing is overwritten or consumed.
- **CX7** Never waits for input: completes or fails with stdin closed.
- **CX8** Plain failure: non-zero exit, one short plain reason plus a next step,
  no stack traces or raw dumps.
- **CX9** Really online: after success the Computer is online on the Server.
- **CX10** Safe failure: a failure before redemption creates no Computer and
  leaves the code usable.
- **CX11** Quiet by default: output is the outcome and one `Next:` line;
  detailed checks only with `--verbose`.

## Severity

| Level | Meaning |
| --- | --- |
| **S1 blocker** | The user cannot complete a core task, loses work, or is misled about what an Agent did. |
| **S2 major** | The task completes, but with confusion, a detour, or a principle clearly violated on a main path. |
| **S3 minor** | Friction or inconsistency off the main path, or polish on a main path. |
| **S4 note** | An observation or idea; not a defect. |

## Finding format

```text
F<n> [S2] S1 Setup asks for a runtime before any work is shown
Where: /agents/setup step 2, zh, 1440 px (scenario: fresh)
Saw: <what the screenshot shows, in the user's terms>
Why it matters: <which check, and the user consequence>
Suggest: <smallest change that would fix it>
Evidence: <screenshot path(s)>
```

Report sandbox artifacts separately from product findings. A review sandbox
with synthetic data and placeholder credentials shows connectors failing and
Computers offline; those states are valid material for **C1** and **A4**, but
"this connector is broken" is not a defect.

## Do not report

Rulings on findings that were rejected, so later reviews stop raising them.
One line each: `<check> — <ruling> — <reason>`.

- A2 — the default Agent name is openTag — matching the product name is intended brand reinforcement, not a collision.
- A2 — do not propose splitting an Agent's display name and handle — a restricted name field states its allowed characters instead.
- A1 — the "Runtime" / 运行环境 wording — kept for now.
- G1 — Create Agent stays disabled until a runtime is chosen — preselecting one is wrong because the user's computer may not have it.
- O1 — the Agent overview's module order (usage and schedules before Tasks) — kept for now.
- G4 — setup has no step-back or "configure later" — the Agent type is fixed once chosen; the only exit is Back to Agents.
- H1 — pending approvals and per-message states on the Web — admins cannot act on them; approvals happen in Feishu or Slack.
- C4 — a schedule time showing a zone such as GMT+8 — the zone is shown when it differs from the reader's, which is expected when the review browser's zone differs.
