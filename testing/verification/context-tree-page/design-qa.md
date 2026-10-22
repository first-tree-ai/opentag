# Context Tree page design QA

Final result: passed

## Design target and scope

Selected concepts:

- Empty: `/Users/gabriel/.codex/generated_images/01a151e7-32be-7050-b356-0c1a2bac09fb/exec-7c65a79d-62db-45f8-8175-bfc4fbdaba71.png`
- Connected: `/Users/gabriel/.codex/generated_images/01a151e7-32be-7050-b356-0c1a2bac09fb/exec-f206fb09-c1f0-4adb-a960-e7029c243b28.png`

The agreed refinement makes each tree compact and its title a direct GitHub link. There is no separate details view. The existing production shell and typography remain in use.

## Evidence and normalization

Browser checks used the actual production page for the connected state. An ignored, isolated fixture mounted the same production component for empty, paused, and Cloud states. Its operation handler returned a simulated permission failure; it did not modify agent connections or create repositories.

- Desktop captures: 1440 × 1024 CSS pixels, 1× capture density. Concept images: 1487 × 1058.
- Mobile captures: 390 × 844 CSS pixels, 1× capture density.
- Comparisons crop both source and implementation to equal 820 × 530 content regions without rescaling. This removes the fixture's missing navigation shell from the comparison. Concept typography is deliberately replaced by the existing shared product typography.
- `connected-desktop.png`: running application and existing connection.
- `empty-desktop.png`, `empty-mobile.png`: empty choices.
- `connect-dialog-desktop.png`: focused, stacked form.
- `connect-error-mobile.png`: simulated permission error.
- `add-menu-mobile.png`: both actions and explanatory copy.
- `empty-comparison.png`, `connected-comparison.png`: source and implementation together.

## Visual surfaces

| Surface | Result |
| --- | --- |
| Typography | Shared Manrope headings and body styles; semantic headings and accessible link names. |
| Spacing and layout | Compact source cards; separate setup dialog; mobile choices stack. Fields and menu content stay within viewport. |
| Color and tokens | Existing warm canvas, white surfaces, purple action/focus colors, neutral connection label, red error Banner. |
| Assets | Existing Phosphor icon library through the shared Icon registry; no raster assets or custom SVGs. |
| Copy | Short descriptions distinguish connect from create. Repository/path appears once per card. English and Chinese catalogs match. |

## Interaction verification

Verified empty choices, connect/create field differences, initial focus, Cancel and Escape focus return, menu-to-dialog transition, required-field validation, visible permission errors, and Cloud's connect-only state in the browser. The active production agent's Add tree action is disabled with one pause explanation; GitHub browsing stays available.

Unit tests also verify exact source selection, offline disconnect, pause restrictions, retry identity, operation failures, and stale response fencing. No real connection was removed or repository created for this design check.

## Corrections and validation

The first dialog render cramped two repository fields. They now stack at all sizes. The first menu render crowded icons against text; explicit spacing corrected it. Shared Text components satisfy the UI contract, and the collection renderer is separate from form operation state.

Final checks: `pnpm check`, web type checking, production web build, and four focused test files (43 tests) passed. The build emits the existing large-chunk advisory; its bundle budget passes. The isolated final fixture reported no console errors.

## Simplified copy and setup forms

The user-provided copy replaces the original heading and descriptions. The empty-state explanation is removed because the page introduction now explains shared knowledge and GitHub storage. Connect now accepts a GitHub repository URL and an optional directory; the directory starts empty. Create retains owner and name only. Neither form exposes a branch input.

The running local application was checked at its default desktop viewport and at 390 × 844. Both dialogs fit, initial focus targets the first relevant field, and Cancel returns focus to the action. Screenshots: `empty-simple.png`, `connect-simple-desktop.png`, `create-simple-desktop.png`, `connect-simple-mobile.png`, and `create-simple-mobile.png`. The desktop and mobile forms were inspected visually; no connection or repository was created for browser QA.

Connect resolves Git HEAD to the repository's actual default branch before verification and persists that branch. Create runs on the Server using the Account's current GitHub credential and commits the initial page on GitHub's default branch. Offline tests verify a non-main default branch, the pinned CLI initializer, default-branch persistence and deduplication, URL validation, and empty-directory normalization.

Final validation for this revision: 74 affected tests passed (27 web, 39 server, 8 client), repository-wide type checking, `pnpm check`, and `pnpm build` passed. The rebuilt server reports ready and the local daemon reports a consistent running owner.

## Compact empty state

The final empty state removes the large folder icon and tightens the introduction, heading,
and action spacing. `empty-compact-desktop.png` and `empty-compact-mobile.png` show the
current layout. Desktop and 390px mobile were checked; 320px and 768px were not separately
captured. The forms and connected cards retain the earlier interaction coverage.
