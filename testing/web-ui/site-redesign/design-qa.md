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
The guide was initially copied verbatim from that source; it now lives in
[the docs tree](../../../docs/system/web/design.md) with metadata, explicit website
links, and application ownership context. Generated concepts
are superseded and were not used as acceptance baselines.

Implementation: the production web build served by `scripts/e2e/site-redesign-preview.mjs` at
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
- **P2, fixed: icon-button padding.** Final review found that the shared 16px
  horizontal padding also applied to square icon buttons. Icon-only buttons now
  use zero horizontal padding. The [connector dialog](implementation/connector-dialog.png)
  was checked after merging main: its compact close button measures 32px, with a
  16px icon and zero horizontal padding; closing returns focus to Add custom.

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

## Review regression checks

The production browser smoke suite includes `e2e/tests/site-design-smoke.spec.ts`.
It creates real Agent identities and supplies deterministic no-Computer, runtime
sign-in, and messaging-permission states. All eight English/Chinese combinations
at 320, 390, 700, and 1440px check readable, unclipped names, page overflow, axe,
keyboard row/setup navigation, menu dismissal/focus return, and the 44px mobile
home/account/switcher/menu targets. A ninth case checks selected Skill filenames,
links, and keyboard scroll-region focus.

- Browser Smoke: **94 passed**, four Chromium workers, normal repository config.
- Complete web unit suite: **166 files, 2,021 tests passed**.
- Build, workspace typecheck, standalone E2E typecheck, and `pnpm check`: passed.
- Token tests include secondary/muted text on selected surfaces, separate warning
  and danger text, and meaningful status-indicator contrast.
- The deterministic preview server now lives in `scripts/e2e/`, alongside existing
  browser tooling. No coverage thresholds or exclusions were changed.

Representative captures from the passing smoke run:

- [English 320px](review-validation/roster-en-320.png),
  [English 390px](review-validation/roster-en-390.png),
  [Chinese 320px](review-validation/roster-zh-320.png),
  [Chinese 390px](review-validation/roster-zh-390.png).
- [700px shell](review-validation/roster-en-700.png),
  [1440px roster](review-validation/roster-en-1440.png),
  [Skill reader and keyboard focus](review-validation/skill-reader-contrast.png).

The desktop journey retains the website's 40px minimum account control and 32px
avatar; the separate narrow-screen matrix asserts the stronger 44px mobile floor.

### Full journey follow-up

The full 36-test journey project was executed. It exposed stale redesign
expectations and a Soul editor ResizeObserver delivery error. The editor now
coalesces observer work into the next animation frame and cancels pending work on
unmount. Its three height tests pass, including manual-height preservation and
layout changes after the observer callback has returned. Navigation assertions
now exercise Soul's real labels and actions, inline mobile links, keyboard
switching, and the legacy Integrations redirect to Account.

All **19 targeted app/navigation journeys pass** after these fixes:

```sh
pnpm --filter @opentag/e2e exec playwright test tests/app.spec.ts tests/navigation-polish.spec.ts --project=journey --workers=1 --grep-invert 'Internal tools opens from Agent navigation'
```

The full journey suite is **not recorded as green**. The broader run also found
these existing tests outside the redesigned flows:

- `runtime-test.spec.ts`: the first Claude connection test timed out waiting for
  success; local model options were unavailable. Four dependent serial tests did
  not run.
- `mcp-auth-rejection.spec.ts`: four 401/403 cases still target the former
  `Connector URL` input or a former list `Connect` button. These selectors no
  longer match the current connector UI.
- `navigation-polish.spec.ts`: the Internal tools toggle case expects an
  `Integrations` navigation link. Current navigation omits that link, and legacy
  Agent integration routes redirect to Account. This behavior and the stale
  assertion are also present in the PR base source.

The targeted command excludes only that last legacy-toggle case; it includes
both 320px and 390px Internal tools/account navigation tests. No permanent test
exclusion, weakened axe rule, or coverage-policy change was added.
