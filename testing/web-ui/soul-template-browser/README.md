# Soul editor and template browser

Implementation evidence for the [Web UI contract](../../../docs/system/web/web-ui-contract.md), verified on 2026-10-20.

## Implemented behavior

- Persistent Browse templates action and a borderless empty state matching Skills and Connectors, with two inline actions in one natural sentence.
- Eight bilingual templates with Phosphor icons, task summaries, applicability overviews, and complete expanded bodies.
- Desktop list and reader; compact list/detail navigation with selected-item focus restoration.
- Preview without changing a draft, explicit Use template, and separate Apply changes / Discard changes.
- Latest-saved discard, explicit clearing, revision-aware persistence, failure preservation, busy controls, and navigation protection.
- Catalog locale changes preserve saved or drafted text; using a template explicitly copies its current locale's body.
- Refined subtitle, empty guidance, consistent section headings, and a moderate body after the
  [editorial review](../../design/soul-template-catalog-v2/editorial-review.md).

## Screenshots

- [Empty Soul, Chinese desktop](preview-empty.png)
- [Borderless empty state, Chinese mobile](preview-empty-mobile.png)
- [Explicit blank editing, Chinese desktop](writing-zh-1440.png)
- [Template detail, Chinese desktop](preview-desktop.png)
- [Template detail, Chinese mobile](preview-mobile.png)
- [Empty Soul, Chinese mobile](empty-zh-390.png)
- [Editable template draft, English](draft-en-1440.png)
- [Saved content, English](saved-en-1440.png)
- [Save failure preserves the draft](error-en-1440.png)

The `empty-{en,zh}-{320,390,768,1440}.png` and `templates-{en,zh}-{320,390,768,1440}.png` files record the full layout matrix.
The `list-{en,zh}-{320,390}.png` files record the compact list. Keyboard-focused screenshots intentionally show the
reader's focus indicator; `preview-*.png` show the normal presentation.

## Browser acceptance

The [Playwright CLI journey](journey.spec.js) runs against a disposable Agent in an isolated local development database.
The application, sign-in, Agent creation, configuration reads, and successful writes use the built product and real local
APIs. Only the deliberately failing/held save responses and the same-origin axe script are browser fixtures. It does not
contact public providers or run an Agent model.

All eight language/width combinations passed:

- Empty entry, template count, applicability overview, four expanded document sections, and viewport bounds.
- Independent reader scrolling with a stable footer and access to the final section.
- Compact Back, selection focus, Cancel, Escape, and restoration to both opening controls.
- axe checks for empty, list, and detail states, after dialog entrance animations complete.

The full journey also passed draft preservation, no write on Use template, one explicit save, editor focus after use,
latest-saved discard, locale preservation, Chinese body insertion, failed-save recovery, busy control disabling,
both navigation-guard decisions, and explicit persisted clearing. Separate browser review confirmed that Research
selection survives desktop-to-mobile resizing and returning from detail to the list.

Run the CLI journey from the repository root after opening an empty, disposable Soul in a named browser session:

```bash
playwright-cli -s=soul run-code --filename=testing/web-ui/soul-template-browser/journey.spec.js
```

## Code checks and limits

Passed on the final implementation:

- `pnpm check`, including Context Tree verification and complexity ratchets.
- `pnpm typecheck`.
- `pnpm build`, followed by a final `pnpm --filter @opentag/web build` after copy and focus refinements.
- 76 directly affected tests across runtime configuration, editor sizing, catalog fidelity/localization, and the Kumo contract.
- `pnpm --filter @opentag/client test:agent-runtime:coverage`: 100% statements, branches, functions, and lines.

The full Web run passed 2,016 tests and reported one Chinese-label assertion while the catalogs were being regenerated.
A fresh final run of the affected files, including that assertion, passed all 76 tests. The full Web suite was not repeated
after that final regeneration.

The repository-wide `pnpm test` did not pass: unchanged Client tests reported 5-second timeouts, temporary-directory
cleanup failures, and a runner socket assertion. A targeted retry passed the cloud-turn and runner files but retained
timeouts in Client runtime composition and Context Tree tests. Database integration runs also reported migration/MCP/IM
test failures and timeouts; both broad runs were interrupted after repeated failures. An isolated retry of the CIMD
registration case passed. These outcomes are not presented as a green repository-wide gate, and no backend or Client
code was changed to work around them.

Browser rendering and content fidelity do not establish model effectiveness. The templates still need evaluation on
representative real tasks; no model-performance claim is made by these UI checks.

## Empty-state refinement

The composition matches Skills and Connectors: a light 32px icon, an empty-state heading, and one guidance sentence.
The Chinese copy reads “从模板开始，也可以按你的想法编写。” Both complete phrases use the same brand color and are
inline buttons; connecting text and punctuation are not interactive. Both template entries open the same chooser.
There are no persistent underlines or separate action rows. Hover adds
an underline, and keyboard focus remains visible. The page subtitle stays fixed without the Agent name.

Writing focuses the editor. Clearing during editing preserves it; applying a clear or discarding to empty restores the
empty state. Cancel closes pristine blank editing and restores focus to the writing action.

The final inline refinement passed the Web build, typecheck, `pnpm check`, and all 76 directly affected tests.
The full browser journey passed again at 1440, 768, 390, and 320 pixels in both languages, including axe, both
template entries, explicit writing, draft preservation, save, discard, error recovery, and clearing. The screenshots
above and the layout matrix were refreshed for the approved wording and full-phrase actions.

## Independent review

A separate automated review found a P2 issue: clearing a first draft after a failed save unexpectedly exited editing.
It is now fixed, with two retained regression cases, 76 passing affected tests, bilingual browser regression coverage,
and a fresh independent review reporting no actionable issues in the correction. See the
[review report, original reproduction, and fix evidence](independent-review.md).

The full eight-case language/width browser journey and axe checks passed again after the save-state correction.
The [retained save-failure regression](save-failure-regression.spec.js) separately covers failure, clearing with focus retained,
rewriting and real persistence, confirmed clearing, and explicit cancellation through both entry paths.

## Direct document editing

Verified on 2026-10-21. The editor now uses Tiptap 3.32.0 for editing, history, Markdown,
and selection positioning. Formatting controls use the existing Kumo Toolbar and Toolbar.Button through
our design-system adapter. Only heading, bold, and bullet list are exposed. A first-show attachment bridge
lets Kumo register connected controls before keyboard navigation; no custom arrow-key navigation remains.
The footer uses the shared settings action row, combining success and next-response timing in one sentence.
The Server API and database representation remain unchanged.

Validation:

- 84 affected tests pass across the editor, Markdown compatibility, runtime form, catalog, and Kumo contract.
- `pnpm check`, `pnpm typecheck`, and `pnpm build` pass. Existing lint and bundle-size warnings remain.
- The full bilingual 320/390/768/1440px browser journey and axe checks pass with the rich editor.
- [Rich editor journey](rich-editor-journey.spec.js) verifies Markdown paste and rendered structure, three standard
  controls, Alt+F10 entry, Kumo arrow-key navigation, bold, undo, Escape focus, stable save-row height,
  exact source preservation on reload and locale changes, a 390px selection menu, axe, and confirmed clearing.
- [Saved English document](rich-saved-en-1440.png) and [Chinese mobile selection](rich-selection-zh-390.png)
  show the real rendered implementation.

The preceding independent review applies to the earlier save-state correction. A fresh independent automated
review of document editing was attempted but did not complete after connection retries; no completed
independent-review claim is made for this increment. Native OS IME and screen-reader use were not manually exercised.

## Template detail hierarchy

Verified on 2026-10-21. Template names and applicability overviews remain on white; the complete body uses a single
light `bg-kumo-tint` surface with responsive padding. The former separating rule is removed. There is no additional
content label, helper sentence, border, or shadow. The body starts with its original first section and shares the
reader's scrolling; header, footer, preview, and explicit apply behavior are unchanged.

The 15 catalog and Kumo contract tests pass, as do the web build and `pnpm check`. A read-only browser review passed
for both languages at 320, 390, 768, and 1440px, checking the visual hierarchy, all four body sections, no nested
scrolling or page overflow, visible actions, draft preservation after Cancel, and zero axe violations. No Agent writes
were made during this review. Screenshots: [English desktop](detail-hierarchy-en-1440.png) and
[Chinese mobile](detail-hierarchy-zh-390.png).

## Typing in long documents

Verified on 2026-10-21. Intrinsic-height measurement temporarily expands the editable document, which resets its
internal scroll offset. The hook now restores the offset after measuring and setting its final height.

The retained [browser regression](typing-scroll-regression.spec.js) failed before the fix: a single typed character
changed scrollTop from 1580 to 0, moving the caret from the visible 676–696px range to 2257–2276px. After the fix,
scrollTop remains 1580 and the caret stays visible. The same sequence passes at 1440×900, 1440×700, and 390×844,
including continued typing, committed Chinese text, wrapping, and eight new paragraphs. This uses a disposable
verification Agent and discards drafts without saving. Native OS IME composition was not manually exercised.

The height-measurement unit regression was observed failing before the fix and now passes; all 66 affected editor
and runtime-form tests pass. The web build, web typecheck, and `pnpm check` pass. Screenshots:
[desktop](typing-scroll-fixed-1440x900.png), [short desktop](typing-scroll-fixed-1440x700.png), and
[mobile](typing-scroll-fixed-390x844.png).

## Shared document presentation and template lists

Verified on 2026-10-21. Template previews and editable Soul documents now share `soul-document.css` for body text,
section headings, paragraphs, lists, and other supported Markdown blocks. Desktop body text is 14px and narrow-screen
body text is 16px. Section headings are 16px semibold, with 8px below headings, 16px between paragraphs, and 24px before
subsequent sections. List markers, indentation, and item spacing are the same for template and user-created content.
Preview bodies retain their light tint, while the editable document retains its white surface.

All eight English and Chinese template bodies retain their wording and four sections. Role and communication remain
paragraphs; working approach uses three or four flat bullets, and deliverables uses two bullets. Only selecting a
template inserts this structure. Existing saved Soul text is not rewritten, and no API or database migration is involved.

Validation:

- All 87 affected tests pass, including all 16 catalog bodies, Markdown round trips, and bilingual template-to-editor
  list preservation alongside personal additions.
- The [retained shared-document journey](shared-document-journey.spec.js) passes for English and Chinese at 1440, 768, 390,
  and 320px. It compares actual computed typography between preview and editor, checks visible bullets and Markdown
  structure, and adds a personal heading and list through the editor's keyboard shortcuts. All preview and editor axe
  checks pass. Drafts are discarded on the disposable verification Agent; existing user Agents are untouched.
- The retained long-document typing regression passes again at all three viewport sizes, including committed Chinese
  text, wrapping, and eight new paragraphs. Native OS IME composition remains outside this automated check.
- The web build, web typecheck, and `pnpm check` pass.

Screenshots: [English preview](shared-document-preview-en-1440.png),
[English editor](shared-document-editor-en-1440.png), [Chinese mobile preview](shared-document-preview-zh-390.png),
and [Chinese mobile editor](shared-document-editor-zh-390.png).

## Pull-request acceptance on 2026-10-21

The final implementation is integrated with main at `2e7f1241`. Multiple independent review passes found 17 issues
in Markdown/source fidelity, clipboard handling, formatting, and responsive controls. Each was corrected with retained
coverage. The final focused independent review confirmed no actionable issues in the last six corrections, rerunning
43 retained tests and 15 additional in-memory cases. See [the full finding and correction record](independent-review.md).

Passed on the final product code:

- `pnpm check`, `pnpm typecheck`, and `pnpm build`.
- The complete Web suite: 170 files and 2,085 tests (`pnpm --filter @opentag/web exec vitest run --maxWorkers=2`).
- The complete Server unit suite: 3,982 passed and 16 skipped tests across 224 passed and one skipped file.
- `pnpm --filter @opentag/client test:agent-runtime:coverage`: 652 tests, with 100% statements, branches, functions,
  and lines on an isolated retry. An earlier loaded run failed a temporary-file wait in the Pi probe test.
- Agent API database integration: 33 tests, run alone with one worker and a 30-second test budget.
- All eight retained browser journeys against a separate real PR-verification Agent: template workflow,
  rich editing, save-failure recovery, shared typography, long-document typing, literal-source save/reload,
  literal clipboard handling, and formatting-menu scrolling. English and Chinese layouts cover 320/390/768/1440px,
  with axe, keyboard navigation, 44px mobile formatting controls, and in-flight-save protection.
- The updated standard Playwright navigation tests: desktop Soul save/guard/Agent switching, plus 320px and 390px touch
  navigation, all three passed against a separate disposable stack. Docker's automatic subnet pool was exhausted, so
  the stack used its own explicitly allocated `10.253.244.0/28` network and port 55440. The manual-preview project and
  database were not reused or stopped.

The default `pnpm test` remains a failed local gate: five Client tests in Session collaboration, Context Tree, and Pi
RPC failed under the default five-second budget, cancelling the concurrent Web/Server jobs. A retry of those three
Client files passed 65/66 tests; the remaining Context Tree test timed out again. All seven Context Tree tests passed
with a 30-second budget. No Client product or test code was changed to suppress those failures.

The full default Server integration command was attempted and interrupted after repeated migration/IM failures and
several minutes without progress. It is not claimed as passing. The successful isolated Agent API run and real browser
writes verify this change's existing persistence seam, without a Server or database-schema change. These local broad
gate limitations remain explicit for PR/CI review.

Manual preview data and the user's active verification Agent were preserved. Browser writes used a separate
`Soul editor verification (PR)` Agent, and all its journeys finish with an empty saved Soul. Native OS IME composition,
screen-reader use, and model effectiveness remain outside these automated checks.

## Pull-request CI compatibility

The catalog fixture is resolved relative to the test module rather than the process working directory. The same five
catalog tests pass both from `apps/web` and through the repository-root coverage project:

```bash
pnpm --filter @opentag/web exec vitest run src/features/agents/agent-settings/soul-templates.test.tsx
pnpm exec vitest run --config vitest.coverage.config.ts --project web apps/web/src/features/agents/agent-settings/soul-templates.test.tsx --coverage.enabled=false
```

Retained Playwright CLI scripts use the `.spec.js` test-file convention. Their content and invocation are unchanged;
this identifies acceptance tests correctly to the changed-line coverage classifier. Product coverage floors and the
80% changed-line threshold are unchanged.

## Pull-request serialization corrections

After the separate PR reviews, 27 retained regression cases cover literal prose, identifiers, placeholders, line-start
markers, and directly typed block-like text. All 131 affected tests pass. A fresh repository-root Web coverage run
passes 2,123 tests with 94.58% line coverage and no retries; the six additional typed-block cases also pass in the final
affected run. The updated source-preservation browser journey passes real save/API/reload checks, the literal-paste
journey passes all five contexts, and the complete bilingual 320/390/768/1440px journey passes again. The contract
explicitly describes whole-document Markdown normalization after editing. See the [review record](independent-review.md).

The PR keeps this acceptance evidence and the approved bilingual catalog with its pinned source map. Superseded
design iterations and exploratory research are archived locally rather than included in the final change.


## Reading and editing refinement

Verified on 2026-10-21. Saved documents now open in reading mode with a quiet Edit action below the document on the
right. Edit focuses the same document and exposes Cancel and Save changes. Unchanged drafts cannot save; Cancel
restores the latest confirmed source. Templates and the existing empty-state entries still create an editable draft
without saving automatically. The page subtitle is unchanged.

Dirty comparison, saved payloads, and leave protection share Markdown normalization: root boundary empty paragraphs
and CRLF/CR differences are ignored, while internal blank paragraphs, code/source indentation, line breaks, and
formatting remain changes. Saved feedback disappears after three seconds or immediately when Edit starts again.
Its hidden layout slot prevents changes to editor/footer heights or reading position. Errors retain the editable
draft and a retry action without expiring. Formatting requests reset when editing ends.

A production-built fixture mounts the real RuntimeConfigurationForm, Tiptap editor, theme, localization, query cache,
and Router with controlled save responses. Both locales at 320, 390, 768, and 1440px pass reading/editing, focus,
disabled unchanged Save, source preservation, Cancel, page bounds, and eight axe scans. Additional journeys pass
long-document boundary changes, one in-flight save, busy controls, timed success with unchanged editor/footer heights
and both scroll offsets, retained failure/retry, immediate feedback clearing, dirty/pristine navigation, and bilingual
empty/template entry. These checks do not exercise live Server persistence, a provider, OS IME, or a screen reader.
The retained earlier journeys and screenshots above describe their original direct-editing acceptance runs.
