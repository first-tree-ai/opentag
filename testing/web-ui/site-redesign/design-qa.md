# Website preview alignment: implementation QA

This records the initial layout acceptance run. The subsequently approved
[avatar replacement](avatar-concepts/IMPLEMENTATION.md) supersedes references
below to preserving the old cat artwork.

## Result and scope

Final result: passed

No unresolved P0/P1/P2 findings remain in the representative light-theme
roster, overview and Soul comparisons. Shared tokens, controls and shell styles
also apply to other pages; this report does not claim a complete visual audit
of every populated screen, integration or server-backed workflow.

## Source and evidence

Source truth is `opentag-site` branch `codex/design-token-refresh`, commit
`4f63d20383045861ca5cd93be8196829f0974e5f`: `agents-preview.html`,
`product-preview.html`, its Soul state, `tokens.css` and `ui-kit.css`.
The root `design.md` is copied verbatim from that source. Generated concepts
are superseded and were not used as acceptance baselines.

Implementation: the production web build served by `preview-server.mjs` at
<http://127.0.0.1:4317/agents>, using two isolated fixture Agents, incomplete setup,
zero usage, empty schedules/tasks and a blank Soul editor. Both sides use Chinese
for direct comparison. The second fixture name differs from the source example.

All paired captures use CSS viewports and image dimensions of **1280 × 720**
or **390 × 844**, one image pixel per CSS pixel, with no density rescaling.
Each comparison puts the source on the left and implementation on the right.

| Screen | Desktop comparison | Mobile comparison |
| --- | --- | --- |
| Roster | [1280px](implementation/comparison-roster-1280.png) | [390px](implementation/comparison-roster-390.png) |
| Overview | [1280px](implementation/comparison-overview-1280.png) | [390px](implementation/comparison-overview-390.png) |
| Soul | [1280px](implementation/comparison-soul-1280.png) | [390px](implementation/comparison-soul-390.png) |

Individual source images are `references/final-{roster,overview,soul}-{1280,390}.png`;
app images are `implementation/{roster,overview,soul}-{1280,390}-zh.png`.
[Overview control detail](implementation/comparison-overview-controls.png)
shows source above implementation at original scale, making labels, separators,
control borders and status indicators readable.

## Findings and iteration history

- **P2, fixed: typography and spacing drift.** Initial rendering inherited Kumo's
  13px small type, oversized navigation gaps and different overview card geometry.
  Shared text sizing now uses the source 14px/16px hierarchy; navigation uses
  source icon shapes, row spacing and padding; overview rows, cards and metrics
  use the source geometry. The final paired overview captures show the corrections.
- **P2, fixed: Soul mobile type and example rhythm.** The first mobile comparison
  kept 16px text, causing an extra line in the example. The source uses 14px below
  641px. The editor and example now follow that breakpoint, with source paragraph
  spacing. Final Soul captures include this correction.
- **P2, fixed: narrow roster target height.** Axe reported setup links below the
  WCAG 2.2 minimum target height. Links now have a 24px minimum hit area and the
  source arrow. The final roster check reports no violations.
- **P2, fixed: primary pressed-state contrast.** The first pressed fill failed
  normal-text contrast. The pressed state now uses the reviewed hover teal and
  retains charcoal labels. Palette tests pass.

## Fidelity review

- **Fonts and typography:** Manrope remains the shared family, with the source
  hierarchy, charcoal labels and subdued metadata. Mobile Soul uses 14px/2;
  desktop uses 16px/2. Header and small control text were inspected in paired
  captures and the focused control comparison.
- **Spacing and layout:** 72px workspace rail, 240px Agent sidebar, 200px tablet
  sidebar, inline navigation below 641px, source frame padding, card radii,
  flat surfaces and overview grid are applied. The content subtree stays mounted
  across resizing. Mobile navigation scrolls locally.
- **Colors and tokens:** canvas `#fafafa`, white cards, teal actions with charcoal
  labels, blue links, neutral selected navigation and semantic status dots match
  the source roles. Focus, action foreground and inverse text are independent.
- **Assets:** official site mark and lockup are reused; the lockup adds only an
  accessible title. Cat avatar assets are unchanged. Existing Phosphor icons use
  the source's assignments. No generated image replaces a production asset.
- **Copy and content:** localized production wording is preserved, including
  Connectors rather than the dummy MCP label. No demo footer, fake statistics or
  session-only-save statement enters the app.

## Necessary production adaptations

These are functional/accessibility adaptations, not a separate visual direction:

- Keep account access and Agent switching on mobile; the static source hides
  identity/account controls there. Keep the real usage-period Select, Soul
  presets, save/discard, revision handling and unsaved-change protection.
- Soul sizing reserves space for its real action area and retains manual resizing
  and keyboard stability. Its mobile editor can therefore be shorter than the
  dummy preview's fixed `56vh` box.
- Strengthen input boundaries to `#8a8e95` and retain accessible destructive text
  and button colors. The source's lighter input border and orange small error
  text do not meet the app's contrast checks. Orange remains available for
  warning/status fills.
- Kumo/Base UI remains the control implementation. The Select trigger and option
  styling reproduce the site treatment without adding a second component library.

## Validation

- `pnpm install`: passed.
- `pnpm check`: passed, including generated theme, i18n, complexity ratchet,
  Biome and Context Tree verification; existing warnings remain.
- `pnpm build` and `pnpm typecheck`: passed for the workspace.
- Complete web suite: **166 files, 2,012 tests passed**.
- Final Soul typography adjustment: production web build and all 3 Soul editor
  tests passed again. The final documentation pass is checked separately.
- Browser overview checks at 320, 390, 640, 768, 950 and 1440px in English and
  Chinese found no page/main horizontal overflow. See
  [English measurements](implementation/responsive-english.json).
  Roster at 320px and Soul at 320/390px were also checked.
- Keyboard usage-period Select, selection and focus return; account-menu Escape
  and focus return; Agent switching and route retention; language selection;
  Soul edit, leave guard, keep editing, apply, preset and undo; and draft retention
  while resizing were exercised in the browser.
- Axe 4.13, WCAG A/AA through 2.2, reports zero violations for
  [roster at 320px](implementation/axe-roster-320.json),
  [overview at 1280px](implementation/axe-overview-1280.json), and
  [Soul at 390px](implementation/axe-soul-390.json).

The first fixture revision lacked account integration endpoints and produced
expected fixture errors there. The helper now explicitly supplies unavailable
integration states. Console logs were checked again on the representative routes;
the fixture also returns 404 for the optional Internal Tools availability probe
(`GET /api/v1/me/setup/reset`), which the app treats as unavailable.
Automated accessibility checks supplement the manual checks; they do not prove
complete accessibility.

## Remaining validation scope

Real provider setup, populated task/log/table flows, server integration and the
full repository unit/agent-runtime coverage suites are not part of this local
visual acceptance run. Run all repository-required gates before opening a PR.
No production data was changed and no deployment was performed.

## Implementation checklist

- Shared theme, controls and official brand assets applied.
- Roster, overview, Soul and responsive shell matched and compared.
- Cats and working production controls preserved.
- App ownership documentation updated separately from the copied site guide.
- Local fixture, comparison captures and validation evidence saved here.
