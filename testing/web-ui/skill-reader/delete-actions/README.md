# Direct Skill deletion: browser acceptance

Captured on 2026-10-22 in headed Chrome through the Playwright CLI. A disposable production Vite build mounted the
actual `SkillsPage`, shared theme, providers and focus-modality handling under React StrictMode. Synthetic in-memory
API responses supplied installed Skills, delayed deletion, a failed deletion and unavailable storage.
The current action-layout captures use four Skills, including long names and descriptions. The preview entry
and build are not shipped. This verifies browser UI behavior, not a live storage/database end-to-end run.

## Layout and appearance

- At 320px, 390px, 768px and 1440px, the document has no horizontal overflow. Descriptions remain single-line;
  controls remain separate from the details target. At narrow widths they align with the Skill name.
- Delete buttons are always visible, with 44 × 44px targets at 320px/390px and the shared 32 × 32px compact size
  at 768px/1440px. Default icon color is the secondary token (`rgb(105, 108, 115)`).
- Hover uses danger-color icons (`rgb(180, 35, 24)`) over neutral tint (`rgb(244, 245, 247)`), with the localized
  Delete skill tooltip. Keyboard focus retains the shared 2px outline.
- The switch retains its 36 × 18px Kumo track, with a transparent 44 × 44px pointer target. All four target corners
  hit the switch at every tested viewport. A matching layout slot gives it an 8px gap from the delete target;
  the delete button's right inset remains 16px. Visible switch/delete centers match the preceding layout exactly.
- Wide layouts center both controls against the complete content group; compact layouts center them against the
  name. A 526px content container inside a 1440px viewport also follows the compact composition.
- Standalone and grouped switches use the shared slate token for keyboard focus, including checked controls.
  The explicit checked-focus rule prevents the checked-state brand ring from overriding focus color.
- The list has no Download or More actions. The reader retains Download and its canonical `.tar.gz` filename.

## Interaction and accessibility

- Tab reaches the named delete button after the switch; Enter opens confirmation and initially focuses Cancel.
  Escape/cancellation restores the original trigger. Switch actions do not open the reader.
- Confirmed deletion moves focus to the next row, the preceding row when deleting the last row, or the named Skills
  page when the list becomes empty. The deleted trigger is explicitly excluded even before React commits its removal.
  Regression tests cover an earlier pending toggle, a pending next row and a background removal. Browser checks also
  verify both pending-toggle cases. Focus searches stable neighbouring controls instead of indexing a filtered list.
- A touch-enabled mobile Chrome context verifies taps outside the visible switch track but inside its expanded
  target, the delete button's bottom edge, and disabled-state protection. DOM hit regions remain separate.
- Pending deletion disables cancellation and rejects Escape; a failure stays in the confirmation dialog. Reopening
  a cancelled confirmation clears its prior error.
- Unavailable storage disables importing while leaving deletion available. Chinese labels and the confirmation fit
  at 320px with complete accessible names.
- axe WCAG 2 A/AA, 2.1 AA and 2.2 AA scans cover all four list widths and the English/Chinese confirmations.
  Dialog scans wait for opening animations to finish; scanning during opacity interpolation produces transient
  contrast findings. Stable-state scans have no violations.

Raw results: [initial list measurements](measurements.json), [current layout and focus review](action-layout-review.json),
[touch and concurrent actions](touch-and-concurrency.json), [interaction and dialog scans](interactions.json).

## Screenshots

| State | Evidence |
| --- | --- |
| Desktop list | [1440px](list-1440.png) |
| Tablet list | [768px](list-768.png) |
| Mobile list | [390px](list-390.png), [320px](list-320.png) |
| Hover and tooltip | [Desktop](hover-1440.png) |
| Keyboard focus | [Delete](keyboard-1440.png), [switch](switch-keyboard-1440.png) |
| Compact desktop container | [1440px viewport](compact-desktop.png) |
| Confirmation | [English desktop](confirmation-1440.png), [Chinese mobile](confirmation-zh-320.png) |
| Unavailable storage | [Chinese mobile](storage-zh-320.png) |

## Local checks

The change is scoped to Web UI and the shared Dialog focus-return timing. Validation includes the Skills page,
reader and Agent-switch tests, the design-system tests and Kumo contract checks, followed by the Web package suite
because the focus-return adapter is shared. Web type checking and the production build cover the new localized
message and generated output. `pnpm check` covers formatting, repository contracts and Context Tree validity.
Server/database integration and Agent Runtime coverage are outside this UI-only change.

| Command | Result |
| --- | --- |
| `pnpm --filter @opentag/web test` | 173 files / 2,179 tests passed; one i18n assertion failed because the removed list actions left unused message keys. |
| `pnpm --filter @opentag/web test src/__tests__/i18n-catalog.test.ts` | After removing those two unused keys in both locales, all 3 tests passed. The full package run was not repeated for that isolated catalog cleanup. |
| `pnpm --filter @opentag/web build` | Passed after the final catalog cleanup. |
| `pnpm --filter @opentag/web typecheck` | Passed after the final catalog cleanup. |
| `pnpm check` | Passed after the final catalog cleanup; existing repository warnings remain. |


## Action-layout refinement validation

- `pnpm --filter @opentag/web test src/features/skills/skills-page.test.tsx src/features/skills/skills-page-agent-switch.test.tsx src/features/skills/skill-details-dialog.test.tsx src/ui/kumo-contract.test.ts src/ui/text-metrics.test.ts`: 5 files, 69 tests passed, including the concurrent focus regressions.
- `pnpm --filter @opentag/web test src/ui/design-system.test.tsx src/ui/design.tokens.test.ts src/ui/kumo-contract.test.ts`: 3 files, 33 tests passed after the final focus-color rules. This run overlaps the Kumo contract file above.
- The prior package-wide run is retained above. It was not repeated for this refinement: JavaScript behavior changes are limited to Skills focus restoration; shared Switch changes only select the existing focus token. Component/contrast/contract tests and actual browser focus checks cover both standalone and grouped forms.
- Browser geometry and axe checks passed at 320px, 390px, 768px and 1440px. Touch checks used `hasTouch: true`, mobile emulation and a coarse pointer; confirmation scans wait for animation completion.
- The final refinement also passes `pnpm --filter @opentag/web build`, `pnpm --filter @opentag/web typecheck`, `pnpm check` and `git diff --check`.
