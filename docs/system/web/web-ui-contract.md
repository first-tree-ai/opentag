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
setup. These embedded pages omit their own header, including the brand, Account menu, and Back to agent/Set up later
action, and share the shell's single main landmark. The account rail provides the exit from unfinished setup;
completion provides the central View agent action.
The account rail's brand mark links to the Agent list, preserving the logo's home action in either layout.
On phones they follow the shell's existing compact navigation. The same shell and session-local page memory remain
mounted when moving between the Agent list and setup. An unfinished creation draft, including its current step,
name, runtime, and destination, is restored on return and cleared once its creation succeeds or the Account session ends.
An in-flight creation is shared across those visits. While it is pending, the name, runtime, Back, and Create controls
are disabled on both the original and returning form. The active form always receives its outcome: success opens the
exact Agent's setup, while a refusal keeps the submitted draft available for editing and retry. Its result only clears
the submitted draft; a departed form cannot clear a later draft or redirect the reader back into setup.
Drafts are not persisted across a document reload or an external authorization round trip; after creation, the exact
Agent's server snapshot restores the remaining setup steps.
If a creation finishes after the user navigates away, it refreshes the Agent list without pulling the user back into setup.

First-time setup stays full-screen throughout its current journey, even when Account admission completes before
Computer or messaging setup. An Account-scoped, tab-local layout marker preserves this presentation across reloads
and external authorization; leaving setup or signing out clears it. If browser storage is unavailable, the current
document still retains its layout and navigation and sign-out continue to work; the reload hint is optional.
Restoring a browser tab that retains this hint also resumes full-screen setup, even after Account admission. The
header's brand link exits to All Agents and retires the hint, so the next setup visit uses the account rail.
Subsequent setup visits use the application shell.
After an exact Agent has been admitted, the full-screen header's openTag logo links to the Agent list (`/agents`),
including on the setup completion screen. The pre-Agent creation header keeps its existing navigation restrictions.
The completion screen stays visible until the user navigates away. Its primary action, **View agent**
(**查看 Agent** in Chinese), opens that Agent's overview. Global navigation provides the return to the Agent list;
the completion screen does not repeat that destination as a secondary action or redirect automatically.

## Layout and responsive acceptance

Authenticated pages use the named `content` container and the shared content frame documented in `KUMO.md`. Prefer
container queries for page composition because the Sidebar changes the space available to the route without changing
the viewport. The shell follows the website app preview breakpoints: 240px Agent sidebar above 950px, 200px from 641px to 950px,
and inline scrolling navigation at 640px and below. Compact controls retain account access and Agent switching.
The same route outlet remains mounted across those changes. Agent roster rows stack identity above status below a 42rem roster container width, keeping names and setup actions readable at 320px.

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
- validation identifies the field, describes the problem, and exposes the update to assistive technology; and
- non-essential animation and transition are removed when `prefers-reduced-motion: reduce` is active.

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

Schedule rows keep configuration state (Enabled, Paused, or an exhausted one-time schedule) separate from the
latest handoff result. Rows prioritize the task name, friendly time rule and relative next occurrence.
Normal runtime receipt does not occupy a separate row. Exceptional or unconfirmed triggers show a concise
relative-time warning that opens details; they do not claim task failure or completion. Exact timestamps
and timezones remain available in time titles and details. Relative labels update locally once per minute
without fetching private details. On a minute tick at or after a loaded enabled occurrence's due time,
the list revalidates summaries once per schedule and observed occurrence. An unchanged past occurrence
does not cause repeated reads; a failed refresh retains rows and exposes Retry. The list uses summary
fields and fetches the private prompt only on open.

The list stays in one card with compact divided rows; pagination remains an explicit Load more action.
The schedule name opens a focused detail dialog, including when reached through the existing schedule deep link.
The row action menu contains pause/resume and delete. A pending mutation prevents overlapping writes, while
read-only details remain available. Deletion confirms the schedule and its impact, initially focuses Cancel,
retains a refused operation inside the dialog, and returns focus to the section after a confirmed removal.
After a revision conflict, refreshed summaries update the confirmation target before the user explicitly
confirms again. If the target disappears, the confirmation closes and focus returns to the section.
A failed refresh disables deletion until an explicit read recovers; stale data cannot be resubmitted.
Closing details returns focus to the name, or the section for a deep link without a surviving trigger.
Switching Agents closes any open detail or confirmation. Failed list refreshes retain loaded rows and expose
Retry. A failed initial read does not masquerade as an empty list. The empty state explains that schedules are
created by asking the Agent in its existing chat; the page does not introduce a separate creation form.

Details prioritize the instructions, the same friendly rule with its timezone, next occurrence and a
provider/conversation description. Instructions offer expansion only when the rendered paragraph is clipped, including after a resize. Existing channel/thread identifiers
remain available as technical references; the API does not supply a human-readable destination name.
Recorded trigger diagnostics are collapsed by default and retain exact times, reason codes and explanations.
Times omit seconds and repeated GMT offsets; expanded content remains in the dialog's scroll container. An accepted handoff
confirms runtime receipt, never task completion. An unknown handoff may still be in flight or may already have started work; users check
Tasks before starting it again. Unreachable and rejected handoffs direct users to the Agent's Computer status,
without diagnosing the cause from current presence. Skipped occurrences retain their reason code. The schedule
does not retry an occurrence. Explanations do not imply a future occurrence when the next trigger is absent;
future occurrences, when present, follow the current enabled state and time rule. These messages
do not introduce retries, execution history, or a separate task lifecycle.

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

Controls use concise action labels. Errors explain what happened and what the user can do next. Do not rely on color,
placeholder text, an icon, or a tooltip as the only communication of essential information.
