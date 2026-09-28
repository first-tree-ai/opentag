# Application reskin visual QA

Date: 2026-09-28. final result: passed

## Target and evidence

Source visual truth: [Concept 1 — Quiet Workspace](docs/design/concepts/quiet-workspace.png).
The user's follow-up requires a restrained tool, compact headings, essential information, and flat controls;
[design.md](design.md) records those production specifications.

Implementation: local production build, reviewed in the in-app browser with disposable API fixtures.
No live user data or external integrations were used for visual review.

| Evidence | CSS viewport / captured pixels | State |
| --- | --- | --- |
| [Agents desktop](docs/design/qa/agents-desktop.jpg) | 1487 × 1058 / 1487 × 1058 | Three agents, one working, workspace rail |
| [Agents mobile](docs/design/qa/agents-mobile.jpg) | 390 × 844 / 390 × 844 | Same roster, stacked rows, mobile header |
| [Model settings](docs/design/qa/model-settings.jpg) | 1440 × 2317 / 1440 × 2317 | Existing provider defaults, labeled controls |

The source is 1487 × 1058px. Desktop source and implementation were opened together in one comparison
input at the same size and light theme. Device pixel ratio was 1; no density rescaling was needed.
Fixture identities differ from the illustrative concept; they exercise real product state semantics.
Close review included the roster title/action/rows, labeled fields, mobile controls, and opened menus/dialogs.

## Fidelity surfaces

- **Typography:** Manrope for body and headings; 28px desktop and 24px mobile page titles,
  18px section headings, 14px controls. Commands remain monospace. Form labels and long titles wrap readably.
- **Layout:** 72px workspace rail, 240px agent navigation, bounded 1024px content, grouped white lists,
  12px surfaces, 8px controls. Compact composition intentionally replaces the concept's oversized title
  and marketing subtitle. No floating dock, routine panel elevation, or hover lift remains.
- **Color:** Website cream, white, dark text, violet actions, and lilac selection are shared tokens.
  Buttons are flat. Operational success/warning/error remain semantic, distinct from brand selection.
  Contrast contracts cover both palettes; light mode is the supported product theme.
- **Artwork:** Supplied OpenTag and provider assets are retained. Actual avatars/initials remain data;
  the concept's invented portraits and alternate cat artwork are not substituted into the application.
- **Content:** Existing localized task, configuration, and setup wording is preserved. Duplicate roster
  usage totals, completion title, and empty-Skills upload action were removed. No slogans or explanatory
  implementation text was added to product flows.

## Review history and resolved findings

| Finding | Correction | Post-fix evidence |
| --- | --- | --- |
| P1: shared size selectors overrode heading hierarchy | More specific semantic heading recipes | Desktop roster 28px, settings 28px, mobile roster 24px |
| P2: form boundaries too faint | Shared control boundary token and adapter recipe | Model settings and mobile MCP dialog |
| P2: compact inputs stayed 32px on mobile | Mobile selector outranks compact-size selector | Mobile search computed 44px after final build |
| P2: Context Tree mode choice resembled a second primary action | Ghost choices with quiet selected state | Connect/create form reviewed at 320px |
| P2: completed setup had two page titles | Retained only existing ready title | Ready scenario reviewed after rebuild |
| P2: selected panels and empty Skills repeated old recipes/actions | Shared surface recipes; one upload action | Internal tools and final empty Skills review |
| P1: bundled font data URLs violated production CSP | Emit same-origin font files | Browser smoke passed with no font policy errors |

## Screen and interaction coverage

Reviewed All Agents; overview; tasks and task detail; usage chart/table; Context Tree; MCP list and create
form; Skills populated/empty; integrations; account; computers; all six agent settings sections;
sign-in/registration; setup location, creation, computer connection, environment checks, messaging/QR,
and completion; internal tools/setup previews; loading, empty, error, and missing-page surfaces.

Checked 320, 390, 768, and 1440px, plus the exact reference viewport. No page overflow appeared.
Opened agent and account navigation, selected a model menu, navigated the mobile drawer, opened and
cancelled an MCP dialog, and verified focus returned to Create Server. The existing automated browser
checks cover keyboard order, menu dismissal, responsive bounds, accessibility, authentication, and
reset cancellation. Reduced motion retains control dimensions and removes nonessential transitions.

Visual fixture limitations: background computer sockets and cloud availability are not simulated;
production browser tests exercise the real isolated server. Dark compatibility is covered by token
contracts, not a newly supported dark-mode user flow.

No actionable P0/P1/P2 visual findings remain. No P3 polish is required for this scope.

## Maintenance checklist

1. Reuse the canonical tokens, generated theme, adapter, and shared recipes.
2. Review meaningful responsive and interactive states when changing a screen.
3. Keep the English guide and Chinese mirror synchronized; run repository checks before committing.
