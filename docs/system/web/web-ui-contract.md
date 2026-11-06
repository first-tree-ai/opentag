---
title: "Web UI contract"
description: "Product UI composition rules over Kumo: ownership seams, layout, responsive and accessibility acceptance criteria."
---

# Web UI contract

This document defines the interface that openTag Web feature code uses to build consistent, accessible product UI. It
complements the implementation notes in [`apps/web/src/ui/KUMO.md`](https://github.com/first-tree-ai/opentag/blob/main/apps/web/src/ui/KUMO.md). Kumo supplies accessible
primitives; [design guide](design.md) owns the visual rules and shared recipes (its website-specific build instructions do not replace the app adapter); this contract owns openTag's product semantics, composition rules, and acceptance criteria.

## Ownership and dependency seam

The Web UI has one third-party implementation and two product-facing seams:

```text
                         ┌─ src/ui/design-system.tsx semantic adapter ─┐
@cloudflare/kumo ────────┤                                               ├─ src/features
                         └─ src/components/kumo owned reusable blocks ──┘
                                  ▲
                                  └─ may reuse the semantic adapter
```

- Kumo owns primitive semantics and baseline interaction behavior. openTag tokens and shared recipes own appearance,
  type, spacing, radii, and elevation.
- `src/ui/design-system.tsx` is the semantic adapter and the normal interface for product code. It owns openTag intent
  names, accessibility corrections, compatibility behavior, icon registration, and other rules that must remain
  consistent across callers.
- `src/components/kumo` contains reusable blocks whose behavior is deeper than a primitive, such as `PageHeader`. Their
  interfaces use openTag-owned types and must not expose Kumo-specific types or composition to callers.
- Feature modules compose either approved seam. They own domain state and copy, not new primitive conventions.

Feature modules must not import `@cloudflare/kumo` directly. Direct imports are limited to the application provider
wiring, the semantic adapter, and owned Kumo blocks. Tests may install their own provider wiring.

## Choosing where behavior belongs

Use an existing Kumo primitive through the semantic adapter when it already expresses the required behavior. Add or
deepen an adapter when openTag must consistently translate a product intent, repair accessibility, or hide Kumo-specific
composition from every caller.

Create an owned reusable block when either condition is true:

- the same product composition has at least three real callers; or
- the interaction or accessibility behavior is important and easy for callers to implement inconsistently.

Shared primitive style wrappers belong in the adapter, preserving the complete control API. Do not create page-level
wrappers that merely forward styling. A reusable block should hide meaningful behavior
behind a smaller interface. Test it through that interface rather than through Kumo implementation details.

## Page and interaction states

A data-backed surface must deliberately handle every state that its domain can enter. The relevant set normally includes:

- initial loading;
- content;
- empty content;
- partial or unavailable data;
- recoverable failure with a retry path; and
- terminal failure with a useful next action.

An interactive action must deliberately handle the relevant default, hover, focus-visible, disabled, busy, success, and
failure states. Busy actions must prevent duplicate submission. Feedback must remain associated with the action or field
that caused it, and a failure must not erase valid user input.

Use Kumo `Loader` or `SkeletonLine` for loading, `Empty` for a genuine empty result, `Banner` for contextual status, and
the shared route or resource-state modules for failures. Do not use an empty table, a disabled action without an
explanation, or layout movement as the only indication that state changed.

Irreversible, high-impact, or uncertain-scope destructive actions require an explicit confirmation surface, a clear
description of impact, a non-destructive default focus target, and an execution state that cannot be dismissed while the
outcome is uncertain. A low-impact action may execute immediately only when it is reliably reversible and offers a clear,
keyboard-accessible Undo path for long enough to recover.

Deleting an Agent is offered whether it is running or paused, behind one confirmation that requires typing its name.
The Server deletes only a paused Agent, so the Web pauses a running one first in the same action. If the pause fails,
nothing is deleted and the dialog says so. If the delete fails after the pause, the dialog says the Agent is now paused
and Try again retries only the delete. A missing permission is named as such. Why: the reader has already confirmed
the delete, so a separate pause step adds nothing for them, and each failure has to say which state it left.

Every full-screen state that replaces the application shell must keep a way to sign out, because an Account that has
not finished setup is shown nothing else. First-time creation and exact setup headers reuse the shared Account menu,
aligned with their navigation action. Until Account setup is complete, that menu offers only Sign out; navigation links
would redirect back to setup and discard the creation draft. Other full-screen states offer a direct sign-out control.
This covers the Agent Setup
states (creation header, exact setup header, unavailable, read-failed, adoption-failed, and choice), the Account gate
when `/api/v1/me` fails (which also offers Retry), and the error and not-found pages. Sign-out always follows one
contract (`features/session/use-sign-out.ts`): the Server confirms the logout first, then the Account session ends and
the browser goes to sign-in; a refused logout is shown inline and leaves the session untouched. Surfaces that may render
outside the Router, Query, or Account contexts use the context-free variant, which reloads onto sign-in instead. Because
the error and not-found pages also serve signed-out visitors, the context-free control appears only while the
script-readable CSRF cookie is present; without it the Server would refuse the logout.

Accounts entering Agent Setup from the application keep the account-level navigation rail throughout creation,
Computer preparation, messaging connection, and completion. The Agent-specific navigation does not appear inside
setup. These embedded pages omit their own header, including the brand, Account menu, and Back to Agents
action, and share the shell's single main landmark. The account rail provides the exit from unfinished setup;
completion provides the central View agent action.
The account rail's brand mark links to the Agent list, preserving the logo's home action in either layout.
On phones they follow the shell's existing compact navigation. The same shell and session-local page memory remain
mounted when moving between the Agent list and setup. An unfinished creation draft, including its current step,
name, runtime, and destination, is restored on return and cleared once its creation succeeds or the Account session ends.
An in-flight creation is shared across those visits. While it is pending, the name, runtime, and Create controls
are disabled on both the original and returning form. The active form always receives its outcome: success opens the
exact Agent's setup, while a refusal keeps the submitted draft available for editing and retry. Its result only clears
the submitted draft; a departed form cannot clear a later draft or redirect the reader back into setup.
Drafts are not persisted across a document reload or an external authorization round trip; after creation, the exact
Agent's server snapshot restores the remaining setup steps.
If a creation finishes after the user navigates away, it refreshes the Agent list without pulling the user back into setup.

The creation form starts with the product name as the Agent name; matching the product name is intended, not a
collision. The name field states the allowed characters before anything is typed, and a refused name gets a short
error that does not repeat them. A name past the length limit gets that error while typing, not only on Create,
because more typing cannot fix it; other name errors wait for blur or Create, so an empty field is not flagged
before anyone types. Why: a rule the reader only discovers by failing wastes an attempt, and repeating
it in the error adds reading without new information. Create stays disabled until a Local Agent's runtime is chosen;
no runtime is preselected, because the reader's computer may not have it.

Creating an Agent always starts with the type step (Local or Cloud), even when the deployment cannot run Cloud
Agents. When the availability check answers that Cloud is unavailable, the Cloud card stays in place, disabled, with an
**Temporarily unavailable** (**暂不可用**) badge and a line saying the Agent can still run on the reader's own computer; Local
stays the default. A failed check says so and offers Try again instead of claiming Cloud is unavailable. Why: the
step tells the reader Cloud exists as an option, which skipping straight to the Local form would hide.

First-time setup stays full-screen throughout its current journey, even when Account admission completes before
Computer or messaging setup. An Account-scoped, tab-local layout marker preserves this presentation across reloads
and external authorization; leaving setup or signing out clears it. If browser storage is unavailable, the current
document still retains its layout and navigation and sign-out continue to work; the reload hint is optional.
Restoring a browser tab that retains this hint also resumes full-screen setup, even after Account admission. The
header's brand link exits to All Agents and retires the hint, so the next setup visit uses the account rail.
Subsequent setup visits use the application shell.
Setup steps move forward only; they carry no in-flow Back. Leaving setup belongs to the header (or the account rail
when embedded). After an exact Agent has been admitted, the full-screen header offers **Back to Agents** (**返回 Agent
列表**) at every step, including the completion screen, and its openTag logo links to the same Agent list
(`/agents`); on phones the logo shows the mark alone so the logo, Back to Agents, and Account menu share one row. The list resumes unfinished setup through the Agent's Continue setup action. The pre-Agent creation header
offers both only to an Account that has completed setup; for a first-time Account the list would redirect back to setup.
Why: the Agent type (Local or Cloud) is fixed once chosen, because switching it mid-setup would discard the computer
or Cloud preparation already made for it. A single exit in a fixed place, the top-right Back to Agents, replaces a
step-by-step Back and a separate Set up later that each led somewhere different. The Agent list is where every
unfinished setup can be resumed.

After setup the same holds for an Agent's Computer, runtime, and messaging channel. They cannot be moved; to change
one, the person creates a new Agent and adds it to the conversation. Why: an Agent's Sessions are bound to that
channel, runtime, and the Computer's local storage, so a move is costly and risky (see
[Agent, Session, and Computer model](../agent-session-computer-model.md)).

When the Agent's runtime is installed but signed out, the setup page's runtime row offers **Sign in** (**去登录**). It
expands the terminal steps for that computer: open a terminal on it, run `claude` and enter `/login` for Claude Code,
or run `codex login` for Codex. The page's existing Check again follows. The commands are short enough to type, so they show as inline code with no copy control. The Agent list row and the
Agent page's runtime row name the same action with the same single link, which opens that setup step with the steps
already shown. Why: sign-in stays on the user's computer. openTag only checks it and never stores Claude or Codex
credentials, so the next step is the terminal on that computer, not a Web sign-in.
Every setup step uses one page surface and one progress rail; the messaging step does not switch to its own
workspace styling. The steps say only what the rows and controls do not:
- The Cloud destination card, when the deployment offers no Cloud, stays disabled with its "Temporarily unavailable"
  badge alone; the reason is the deployment's and the reader can do nothing about it.
- Choosing a computer lists the Account's computers with their status, and offers **Connect a new computer** in place
  beside them; a disconnected computer can be chosen and the step goes straight to its restore-connection command.
- Preparing the computer adds no footer line when every row is ready or while a row is checking: the row status says
  so. The footer speaks only when the reader has something to do (finish the step above, or check again).
- The messaging step's heading stands alone, without a "Set up {name}" subtitle repeating the Agent.
- The Lark step shows its QR code from 768px up, with its expiry relative ("Expires in 15 min"). Below 768px the
  reader is usually on the phone that would scan it, so the same authorization link opens in Lark instead, and the
  instruction and waiting line say to confirm in Lark rather than to scan.

The completion screen stays visible until the user navigates away. Its primary action, **View agent**
(**查看 Agent** in Chinese), opens that Agent's overview. Global navigation provides the return to the Agent list;
the completion screen does not repeat that destination as a secondary action or redirect automatically.

Cloud Agent home shows save-failure guidance without a recovery entry or workspace controls.
The notice identifies the problem, directs the reader to their administrator and warns against
resending completed requests without promising automatic recovery. Workspace diagnostics remain
available only through the explicit `?recovery=true` destination for guided troubleshooting, under
the same Account authorization. Closing the panel removes its controls; the ordinary page does
not expose a button to reopen it. This is not a new permission boundary.
The diagnostic panel pages the existing Account-owned conversation inventory and
offers only Server-authorized save/release or explicit discard/release. A captured environment
generation stays fixed through confirmation and is checked again before the request. Busy actions
cannot be repeated; failed or uncertain mutations cause status reads rather than automatic retries.
Running, queued and unknown work also requires confirmation before save/release interrupts it;
rows without a recorded save failure use a plain save/release label. Discard confirmation explains unsaved-file loss and that external effects are not undone. A
failed inventory read never becomes an empty list, and revoked access hides cached resources.

## Agent home and settings index

- **Settings has no navigation item of its own.** It opens from the Overview's Settings button, so the Overview stays
  current in the Agent navigation on every settings page, and each settings page's back link reads **Back to
  Overview** (**返回概览**) or **Back to Agent settings**. Why: a navigation with nothing current leaves the reader
  unsure where they are, and a back link carrying a long Agent name wrapped on phones while the name sat beside it.
- **The Agent's state reads the same everywhere:** **Running · Receiving messages** (**运行中 · 正在接收消息**) or
  **Paused · Not receiving messages** (**已暂停 · 不接收消息**), and the pause page describes it in the same terms.
  Why: "active" and "requests" named the same state differently, and requests are not a product concept; people send
  the Agent messages.
- **A settings row whose state the reader can fix carries the same single fix as the Agent list and home**, as its
  own named link beside the row: an offline or disconnected Computer offers **Restore connection** (**恢复连接**),
  which opens that Computer's card with its command window already shown, and a runtime problem shows the same label
  as the list (for example "Pi isn't installed") with **Continue setup**. The row itself still opens its settings page.
  Why: the settings index otherwise read healthy while the list and home showed a problem, and four different words
  for one fix made it look like four different actions.
- **A Cloud Computer is named "Cloud" (云端)** on the home, the settings index, and the Computer page, without a
  machine name or platform, which are openTag's choice and nothing the reader acts on.
- **The home's Task list asks for work only when work can arrive.** With no messaging app connected, its empty state
  offers the status card's own **Connect messaging app** (**连接消息应用**) link instead of asking the reader to message
  the Agent, and **View all** appears only once there is a Task. Why: an Agent without a channel cannot receive the
  message the old empty state asked for, and View all opened the same empty list.

## Paused Agent settings

Pausing an Agent does not change which settings its current Account owner can read. Name, Messaging, Computer,
Model and Soul, Context Trees, Skills, MCP connectors, and Pause/Delete remain accessible. The settings overview,
Agent status card, and Agent list use the existing channel identity and binding state. Why: an operator often pauses
an Agent precisely to inspect its configuration or prepare a change, and a configuration they cannot see gives them
nothing to decide from. A failed read stays unavailable; it is never presented as a missing or successful connection.

Messaging settings are read-only while paused. Connection, reauthorization, credential updates,
disconnection, activation checks, cancellation, and message-trigger changes are disabled with a localized reason.
Read-only controls keep their action labels; being paused does not show an operation as busy or in progress.
Saved Feishu attempts and Slack configuration details remain readable without starting setup or refreshing CLI
credentials. Existing permissions for other settings are unchanged. Deleted Agents, other Accounts, and revoked
Account sessions remain unauthorized; resuming the Agent is a separate explicit action.

## Layout and responsive acceptance

Authenticated pages use the named `content` container and the shared content frame documented in `KUMO.md`. Prefer
container queries for page composition because the Sidebar changes the space available to the route without changing
the viewport. The shell follows the website app preview breakpoints: 240px Agent sidebar above 950px, 200px from 641px to 950px,
and inline scrolling navigation at 640px and below. Compact controls retain account access and Agent switching.
The same route outlet remains mounted across those changes. Agent roster rows stack identity above status below a 42rem roster container width, keeping names and setup actions readable at 320px. Each row's open link precedes its status and action in keyboard order, matching how the row reads.

Every roster row whose blocked state the reader can fix offers exactly one action link to where it gets fixed:
setup-owned reasons (no Computer, runtime missing, unavailable, or needing sign-in, messaging not finished, or
delivery failing) use **Continue setup**; messaging that needs new permissions uses **Update permissions**; a
recoverable channel failure uses **Reconnect channel**; an offline Computer uses **Restore connection**. A configured
messaging identity that has been disconnected offers **New Agent**, because the identity cannot be replaced. A paused
Agent and states that resolve on their own offer no action. A fixable row without a way out reads as a dead end next
to rows that have one, so every fixable state carries the same single link.

The action answers the status the row shows. When the Server's status snapshot names a verdict about a
dependency setup already finished, that verdict decides the action, not the setup-owned reason it maps to:
a failed messaging credential check uses **Reconnect channel** and an unavailable messaging CLI uses
**Fix messaging**, both opening the Agent's messaging settings, on the row and on the Agent's dependency
rows alike. Check timeouts, rate-limited credential checks, an unreachable messaging provider and an expired
Computer status report resolve on their own and offer no action. **Continue setup** stays for setup that is actually unfinished.

Agent list and detail availability use the Server's current status snapshot. A foreground page polls
`GET /api/v1/agents/status?ids=...` every ten seconds, batching up to 100 unique visible Agent IDs per
request; hidden tabs do not poll. The Account identity list negotiates this resource with
`x-opentag-agent-status: 1` and an optional `statusVersion: 1` response. Older Servers retain the
existing read path. New status reads replace the per-Agent Computer, binding and handoff fanout.
Other ordinary live resources keep their existing cadence and cache policy.

The Server reads Agent ownership, owned Computers, and binding/installation scope with at most three
batch SELECTs in one short read-only Repeatable Read transaction. A missing or foreign ID refuses
the whole batch as 404. A changed live connection fence retries the whole snapshot once, then
returns a conflict. Responses are private and non-cacheable and contain no credential material.

The browser renders the current Server verdict directly. It does not retain a previous settled
status, add a Refreshing status hold, or start a preparation POST on entry. Normal query cache,
request deduplication and error presentation remain. Offline overrides other dependencies. First
credential initialization is neutral for at most 15 seconds; completed failures, stale reports and
check timeouts name the problem. Rechecks retain the last complete result at the Server. The
Agent's Work row still describes running Tasks separately from availability, with the same running-Task or
waiting-Task (**N tasks waiting**, **N 个任务等待中**, on every status) line as the list row.

Dependency rows use the causal status reason. Computer, runtime and initializing verdicts
leave messaging unconfirmed and offer no messaging repair; they do not establish a separate
channel failure even when a binding exists. Only messaging verdicts can offer messaging recovery.
An unconfigured channel remains neutral and reads Not connected. A paused Agent's readable stored
binding state remains visible without a messaging recovery action; Computer offline still voids it.

See [Agent status pipeline](../runtime/computer-status-pipeline.md) for the single-replica evidence
model. Older Servers without negotiated metadata use the legacy read path.

UI changes must be checked at these representative widths when the surface can render there:

| Width | Acceptance purpose |
| --- | --- |
| 320px | Minimum supported width; no page-level horizontal scrolling |
| 390px | Primary mobile composition and touch interaction |
| 768px | Navigation and compact-to-wide layout transition |
| 1440px | Desktop hierarchy, density, and maximum content width |

Horizontal overflow belongs to the nearest table, code, log, or other intrinsically wide region. That region must be
keyboard focusable and have an accessible name when keyboard users need to scroll it.

Use Kumo and Tailwind spacing and type utilities. Arbitrary measurements are allowed only for a demonstrated content or
layout constraint and should carry a short explanation when the reason is not evident from the interface.

## Accessibility acceptance

openTag Web targets WCAG 2.2 AA for product UI:

- normal text contrast is at least 4.5:1;
- large text and meaningful non-text UI contrast are at least 3:1;
- every interactive control has a visible focus indicator with at least 3:1 contrast against adjacent colors;
- shared buttons (including `Banner.Action`) and single-line controls retain at least 44px height below 768px, with icon buttons also at least 44px wide;
- keyboard order follows the visual and task order;
- Enter and Space activate controls according to their native semantics;
- Escape closes dismissible overlays, and focus returns to the control that opened them;
- icon-only controls have an accessible name, while decorative icons are hidden from assistive technology;
- validation identifies the field, describes the problem, and exposes the update to assistive technology;
- non-essential animation and transition are removed when `prefers-reduced-motion: reduce` is active;
- a control that changes in place keeps keyboard focus: a switch or button is not disabled while its write is
  pending (it ignores repeat input and reports busy instead), because disabling the focused element drops focus
  to the page;
- a step change inside one route, such as the next Agent Setup step, moves focus to the new step's heading, as a
  route change does;
- a save bar that goes away after its changes are saved or discarded moves focus that was on it to the first control
  of its form, such as the Name field; and
- Pause or Resume Agent keeps focus on the same button while pending; it then reads Resume or Pause.

Automated axe checks are required for representative browser flows, but they do not replace keyboard testing or review
of contrast, focus order, accessible names, and task completion.

## Soul editing and template selection

Soul has a persistent **Browse templates** action in the page header. With no saved content and no active draft, it
uses a borderless, centered composition with the same light 32px icon and typography as Skills and Connectors.
The heading identifies the empty state. One natural sentence offers **Start with a template** or
**write your own** for direct editing. Both complete phrases are inline buttons in the same brand color; connecting
text and punctuation are not interactive, and underlines appear only on hover. Both template entries open the same
chooser. Keyboard focus remains visible. There is no separate action row or decorative container. Writing opens and focuses the free-text editor; Cancel returns an unchanged empty
editor to the empty state. Guidance is never saved.
Saved Soul content opens as a read-only formatted document. A quiet **Edit** action remains below it on the right;
there is no extra edit action in the page header or click-to-edit hint. Edit focuses the same document and replaces
the action with **Cancel** and **Save changes**. Save changes stays disabled until the draft differs meaningfully
from the last saved content. Cancel restores the saved source and returns to reading; confirmed saves also return
to reading. No document remount is required for these transitions.
Tiptap owns selection, history, and Markdown conversion. In editing mode, its BubbleMenu hosts the shared Kumo
Toolbar and Toolbar.Button controls for heading, bold, and bullet list. Selecting text reveals the toolbar;
Alt+F10 focuses it, and Escape returns to the document. Standard editing shortcuts remain available. Reading
mode permits text selection and scrolling without exposing editing controls. Existing task lists, tables, links, and
code remain supported without adding more toolbar actions. Prompt markup, comments, and image references remain
inert editable source text. Opening, focusing, or changing the interface locale must preserve the exact saved
Markdown; an unrelated edit must not silently remove existing content. The API still accepts the same string.
An actual content edit serializes the complete document. Markdown spelling and whitespace may then normalize,
including bullet markers, emphasis delimiters, heading syntax, code fences, list spacing, tables, and bare links.
This is not a block-preserving source editor. Ordinary comparison symbols and ampersands remain literal prompt text,
identifiers such as `read_file` and `{{user_name}}` gain no escapes, and literal line-start markers retain the escapes
needed to prevent them from turning into headings, lists, quotes, or rules on reload.
This includes block and inline XML, valid source indentation, literal entities, and reference-style images.
Keyboard-created prompt tags retain their literal syntax. Plain-text paste inside code or prompt-source blocks
stays literal instead of inserting a separately parsed Markdown document. Ordinary horizontal rules remain
formatting boundaries; frontmatter recognition is limited to the document preamble. The formatting menu tracks
the editable document's own scroll container.
Template previews and editable documents share the same scoped typography: 14px body text on desktop, 16px on
narrow screens, 16px semibold section headings, 8px after headings, 16px between paragraphs, and 24px before sections.
Bullet and numbered lists share indentation, markers, and item spacing in both contexts, including user-added text.
Only the enclosing surfaces differ: template bodies are lightly tinted; the editable field stays white.
Automatic height measurement preserves the editor's scroll position so typing in a long document keeps the caret
and surrounding text visible instead of jumping back to the beginning.
There is no additional visible Instructions field heading. Clearing text during editing keeps the editor mounted;
only saving the clear or cancelling back to empty content restores the empty state. A failed save preserves explicit
editing mode, including when the user clears a first draft to rewrite it. Cancel and Save changes remain available.

Dirty comparison, the saved payload, and navigation protection share one Markdown normalization rule. Root-level
empty paragraphs at the beginning and end and CRLF/CR line endings do not create a change. Internal blank paragraphs,
line breaks, code indentation, prompt-source whitespace, and formatting remain meaningful. Clicking, selecting, or
moving the caret never creates a change. Merely entering editing mode does not trigger a leave warning.

Successful saves show “Saved. Changes take effect with the next response.” for three seconds; starting another edit
clears it immediately. Its reserved space remains after dismissal so editor height and scroll position stay stable.
Failed saves retain the error, draft, and enabled retry action without an automatic dismissal timer.

The chooser offers eight task-oriented templates: Engineering, Design, Product, Research, Writing, Data Analysis,
Growth, and Operations. Each has a Phosphor icon, name, concise list summary, applicability overview, and complete
localized body. English and Simplified Chinese catalog copy belongs to the `agent-settings` message area.
The page subtitle is fixed, without the Agent name, and identifies the editable role, communication style, and working principles; empty guidance offers
direct writing or browsing for a starting point. Body headings consistently identify role and purpose, working
approach, deliverables, and communication style, keeping comparisons predictable while their contents remain specific
to each role.
Role and purpose and communication style use short paragraphs. Working approach presents three to five parallel
principles as a flat bullet list, and deliverables groups distinct requirements into a short list. Template structure
applies when a template is selected; existing saved documents retain their original content and structure.

Desktop selection uses a list beside one scrollable reader. The name and applicability overview remain on white;
the complete body sits in one very lightly tinted surface, expanded by default. Spacing and background distinguish
the two parts without an extra content label, explanation, border, shadow, or separating rule. Body headings remain
smaller than the template name. The dialog header and footer remain available while reading. Below 768px the same dialog shows
the list first, then the selected detail with an **All templates** back action. Returning to the list restores focus to
the selected template. Both layouts retain the complete document without an inner textarea or disclosure toggle.

Selecting an item only previews it. **Use template** copies exactly the current locale's body into the draft and closes
the chooser, returning focus to the editor. It does not save. Closing, Cancel, or Escape preserves the draft and returns
focus to the opening control. With an existing draft, footer copy explains replacement and the separate save step.
Templates are editable starting points, not active bindings; catalog locale changes do not translate editor content.
They do not grant capabilities, integrations, or background schedules.

Editing exposes **Cancel** and **Save changes** even before the draft changes. Cancel restores the latest confirmed saved text;
Save changes persists a changed draft with its expected revision and takes effect with the next response. There is no separate
template Undo or blank template. Clearing saved text remains a change with an explicit clear notice. Saving disables
editing and browsing, errors preserve the draft, and success stays near the actions. The existing unsaved-navigation
guard offers continuing to edit or discarding and leaving.
The editor footer uses one action row. Pending copy explains that saving affects the next response;
after a confirmed save, one muted sentence briefly combines confirmation and timing in the same location while Edit
returns. No separate success banner or second explanation line is added. Narrow layouts may wrap the actions
below the sentence.

## Theme, color, and motion

openTag currently ships light mode as the supported product theme. Dark theme values may remain for Kumo compatibility
or future work, but their presence does not make dark mode a supported acceptance target. A future dark-mode change must
define complete surface, text, status, illustration, chart, and browser-level behavior before changing this policy.

Feature code must use Kumo semantic utilities or the openTag variables defined at the theme seam. Raw color literals are
limited to theme sources and explicitly reviewed module-owned styles. Teal communicates primary actions, blue identifies links, and neutral grey identifies selection. These roles
must not replace success, warning, danger, or informational status colors.

Switches use brand teal for the checked state and neutral colors for the unchecked state. The semantic adapter
owns this rule for both standalone and grouped switches; feature pages do not choose a color variant. Keyboard focus
uses the shared slate focus token rather than the checked-state brand color. Kumo continues to own their size, shape,
motion, and interaction behavior.

Page navigation replaces the content as soon as the route is ready, without fades, outgoing page snapshots, or
artificial animation delays, including navigation between workspace and Agent pages. The shell preserves
per-page scroll position and restores keyboard focus to the remembered link or the new page heading.

Motion must communicate a state change or spatial relationship. Prefer transform and opacity, avoid perpetual animation
outside an active progress state, and provide a reduced-motion result that communicates the same information without
movement.

## CSS exceptions

`src/app.css` is the application stylesheet entry. Product layout and appearance normally use Kumo and Tailwind
utilities. A module-owned stylesheet is an exception reserved for behavior that utilities cannot express clearly, such
as attribute-driven state or measured layout stability. Shared recipes and generated theme CSS are approved application
seams documented in design.md.

Every module-owned stylesheet must:

- be imported by the module that owns the behavior;
- use a module-specific class prefix;
- explain non-obvious measurements or raw colors next to the rule;
- avoid styling unrelated pages or Kumo internals globally; and
- be added to the static stylesheet seam allowlist in `src/ui/kumo-contract.test.ts`.

## Schedule handoff feedback

Each schedule row shows its name as a heading that opens the details, Pause or Resume, and a label only for a state
other than running on schedule (Paused, or Finished for a one-time schedule). Below it, one line gives the rule in
words ("Every weekday at 9:00", "Monthly on days 28–31 at 18:00"), the next time, and the last time. Times are short
(month, day, weekday, and an unpadded hour) and name the zone, after the time ("Mon, Nov 9, 9:30 (GMT+8)",
"11月9日周一 9:30（GMT+8）"), only when it differs from the reader's. Two zones count as the same when their UTC
offsets are equal at that run, not by name and not by a fixed offset: Asia/Shanghai reads the same as Asia/Singapore,
while a daylight-saving zone differs only on the dates its clock differs. Why: the reader needs the zone only when
their own clock would show a different time, and a zone name between the date and the time breaks the time apart. A cron
expression with no plain form is shown as written, never guessed.

The last run reads in the reader's terms. A run that happened shows only its time. One that did not run says why,
in the danger color ("didn't run: the computer was offline"). One whose handoff is unconfirmed says so, in the
warning color. The opened details add only what the row does not say: where the schedule posts (for example
"Lark · thread"), its zone when it differs from the reader's at the next (or last) run, one note after a failed or unconfirmed run, the full
task, and Delete. After a failed run, the note says it won't be rerun and, when another run exists, that the next
run follows the schedule. After an unconfirmed run, it says to check Tasks before starting the work again. Internal
identifiers and reason codes are not shown. The list uses its existing summary fields and does not fetch the private
prompt until details are opened.

Why: a schedule row answers whether the schedule will run and whether the last run worked. Labels for the default
state, a separate details button, raw cron, long timestamps, and handoff jargon repeated what the row already said or
asked the reader to know the delivery system. Delete is rare and irreversible, so it sits with the details rather
than on every row.

## Internationalization and copy

User-facing copy goes through Paraglide messages. English and Simplified Chinese message catalogues must remain complete
and synchronized as described in `DEVELOPMENT.md`. UI review must include the locale most likely to stress the changed
layout; do not assume English is always the longest representation.

One deliberate exception: the MCP marketplace catalog carries its own copy. Category labels and card
names and descriptions resolve from the catalog sources in `packages/mcp-presets`, localized inline
for every supported locale, and the generator that compiles them fails the build when a locale is
missing. Only the Discover surface's own chrome — the source label, the search
field, the method labels, and the installed states — goes through Paraglide. Do not move the catalog's
copy into the message catalog as if it were an omission; the exception and its reason are recorded in
`mcp-server-integration.md`.

A state uses one label everywhere it appears. For example, a messaging binding that needs new permissions reads
"Messaging permissions need updating" (需要更新消息权限) on the Agent list, the Agent page, the settings index, and the
messaging page, with the single action Update permissions. Page subtitles, field helpers, and notes appear only when they
add information the title or control does not already give. So the Tasks, messaging, Computer, Memory, Usage, and Account pages carry no
subtitle, and Account shows the sign-in email as plain text without explanatory helpers. The Soul editor's description
holds only the formatting hint while editing. The Model page shows one line by the model field only when the computer's
model list can't be read; when the runtime's suggested models are still offered, the line says the computer's
models couldn't be confirmed and to choose one or "Custom model ID…", rather than claiming there is no list. Usage notes unreported Tasks as a muted line under the totals, not a warning banner.
Settings pages hold their content in the same surface as Name and Model, the messaging page included, so the pages
read as one set. Self-configuration sits on the Model page beside Ask for approval, with the other rules about what the Agent may do on
its own. Why: repeated or differing wording makes one state read as several, and copy that restates the page is more
to read with nothing more to act on.

Controls use concise action labels. Errors explain what happened and what the user can do next. Messages stay short:
they say what happened and the next step, without internal states (such as "already connected" or "nothing
changed") or parenthetical mechanics. Explanatory text appears only when it adds information the reader needs, such
as which computer a command is for. Why: fewer words and fewer controls make the next step easier to find, and
internal details give the reader nothing to act on. Do not rely on color,
placeholder text, an icon, or a tooltip as the only communication of essential information.
