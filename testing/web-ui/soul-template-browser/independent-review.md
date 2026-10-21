# Independent Soul implementation review

Reviewed on 2026-10-20 against the uncommitted changes based on `af9705a3`.

## Method and scope

A separate Codex CLI review session ran `codex review --uncommitted` without the implementation conversation.
It inspected staged, unstaged, and untracked changes, including the Soul components, localized catalog, editing
state transitions, responsive chooser, design-system additions, and affected tests. This is an independent automated
review, not a human approval. The implementation agent separately reproduced the finding in a real browser.

Initial outcome: one P2 finding was reported, with no P0 or P1 findings. Product code was not changed during that
review. The follow-up below records its correction and verification.

## P2: Preserve writing mode after a failed first save

Location: `apps/web/src/features/agents/agent-settings/soul-configuration-section.tsx`, lines 73–75.

The form awaits `onSubmit` and then unconditionally calls `setWriting(false)`. The parent `saveInstructions` catches
save errors internally, so its promise also resolves on failure. For a previously empty saved Soul, a failed first
save therefore resets writing mode while the dirty text temporarily keeps the editor mounted. When the user clears
that draft to rewrite it, the draft matches the empty saved value and the editor immediately unmounts.

This contradicts the editing contract that clearing during an active edit keeps the editor available. The focused
textarea disappears and keyboard focus falls back to the document body.

Reproduction:

1. Open an Agent with an empty saved Soul.
2. Choose **write your own** and enter a draft.
3. Apply changes with a failing save response.
4. After the failure appears, select all draft text and delete it.
5. Observe that the editor disappears and the empty state returns.

A temporary component regression test independently failed with this sequence and was removed after review.
The separate [browser reproduction](review-repro.spec.js) used a real local Agent and API reads, with only the deliberately
failing PATCH mocked as HTTP 503. It observed:

```json
{
  "editorCountAfterClearing": 0,
  "emptyHeadingVisible": true,
  "focusedElement": { "tag": "BODY", "id": "" },
  "errorVisible": 0
}
```

Evidence:

- [Failed first save with the editor still visible](review-first-save-error.png)
- [Clearing the failed draft unexpectedly exits editing](review-clear-after-first-save-error.png)

Recommended correction: reset explicit writing mode only after confirmed successful application, explicit Cancel,
or Discard. Do not interpret a resolved parent submission callback as confirmation of success. Add a retained
regression test for failure followed by clearing a first draft.

## Verification and limits

The independent reviewer reran the Web typecheck and 62 existing tests across runtime configuration, editor sizing,
and template catalog/localization; these passed. They do not cover the failure-then-clear transition above.
The browser reproduction confirmed that finding. An additional desktop-to-mobile chooser check retained visible
focus inside the dialog and was not reported as a defect.

This review does not replace the broader validation limits recorded in README.md, including the incomplete
repository-wide test and database integration gates. No real provider or Agent model was invoked for reproduction.

## Fix and independent follow-up

The submission callback now returns `Promise<boolean>`: the parent returns true only after a confirmed API update,
and false after a failure or an ignored busy submission. The child resets writing mode only on true. Explicit Cancel
and Discard retain their existing behavior.

Two retained regression cases in `runtime-configuration.test.tsx` cover both manual and template-first entry. Both
failed against the original implementation when the editor disappeared after clearing. After the correction, all
76 directly affected tests passed, together with `pnpm check`, the Web typecheck, and the Web production build.
The tests also verify rewriting, retrying successfully, and restoring the empty state after a later confirmed clear.

The [browser regression](save-failure-regression.spec.js) passed for both entry paths in English desktop and Chinese mobile.
It verifies retained editor identity and focus after a failed first save followed by clearing, real persistence of the
rewritten draft, confirmed clearing, and explicit Cancel with writing-action focus restoration. Only the deliberate
save failures are mocked; successful writes and confirmation reads use the real local APIs.

- [English manual entry after failed-save clearing](fixed-clear-after-save-error-en-manual.png)
- [English template entry after failed-save clearing](fixed-clear-after-save-error-en-template.png)
- [Chinese manual entry after failed-save clearing](fixed-clear-after-save-error-zh-manual.png)
- [Chinese template entry after failed-save clearing](fixed-clear-after-save-error-zh-template.png)

A fresh independent Codex CLI session reviewed the correction and retained tests. It reported no actionable issues
remaining in the fix. That follow-up review was read-only and did not run tests; test execution and browser validation
were performed separately as described above. The original P2 finding is resolved.

The full existing language/width journey and axe checks also passed again after the correction.

## Complete editor review on 2026-10-21

Fresh, separate `codex review --uncommitted` sessions reviewed the complete implementation and subsequent fixes without
the implementation conversation. The change was also integrated with main at `2e7f1241`; the existing deferred
ResizeObserver delivery and the updated navigation icons were preserved.

The independent review passes found seventeen actionable issues, all corrected:

| Priority | Finding | Correction |
| --- | --- | --- |
| P2 | Unhandled block XML, including CDATA, disappeared after an unrelated edit. | Preserve additional Marked HTML/XML tokens as inert source. |
| P2 | Keyboard-created prompt tags serialized as HTML entities. | Serialize tag spans literally while retaining normal Markdown escaping, existing entity literals, and code. |
| P2 | Two ordinary horizontal rules consumed the intervening headings and lists as frontmatter. | Restrict frontmatter recognition to the document preamble. |
| P1 | Inline CDATA and processing instructions disappeared after an unrelated edit. | Preserve inline XML forms before HTML parsing. |
| P2 | Reference-style images gained an escaped exclamation mark after editing. | Recognize reference images using Marked's syntax rules without loading media. |
| P2 | Formatting controls stayed at their old position during internal document scrolling. | Set BubbleMenu's scroll target to the editable element. |
| P2 | Source comments and reference definitions with valid leading indentation disappeared. | Accept zero to three leading spaces and preserve their source. |
| P2 | Pasting into code or prompt-source blocks split the literal content and parsed Markdown punctuation. | Use ProseMirror's literal paste behavior in code contexts. |
| P2 | Quoted angle brackets terminated an inline XML tag too early. | Share a quote-aware markup matcher between parsing and typed-tag serialization. |
| P2 | Shortcut reference links gained escaped brackets. | Preserve Marked reference syntax while leaving ordinary inline links formatted. |
| P2 | Mobile toolbar controls bypassed the shared 44px touch-target recipe. | Adapt Toolbar.Button through the same responsive button classes while preserving Kumo behavior and refs. |
| P2 | Nested code fences changed the document's block boundaries after serialization. | Extend the standard CodeBlock serializer with fences longer than any backtick run in its body. |
| P2 | Inline-source paste rules removed literal punctuation. | Insert literal text directly in code/source contexts without invoking paste rules. |
| P2 | Namespaced XML body indentation became Markdown list formatting. | Preserve namespaced block tag names and their complete bodies. |
| P2 | Localized toolbar keys remounted controls while disconnected. | Keep stable icon keys across locale updates. |
| P2 | Toolbar actions remained usable during saving. | Forward the disabled state and guard formatting commands while a save is in flight. |
| P2 | Recursive blockquote tokenization still matched frontmatter. | Recognize the preamble only in the parse-scoped root Lexer.lex call. |

Retained tests cover loaded and typed XML, indentation, ordinary separators and frontmatter, reference images, existing
entities, and paste within fenced code, prompt-source blocks, and inline code. Real browser regressions additionally
exercise [source preservation through API save/reload](markup-preservation-journey.spec.js),
[literal clipboard handling](literal-paste-journey.spec.js), and
[formatting-menu scrolling](formatting-scroll-journey.spec.js). The menu regression was observed failing before the correction;
afterward a 40px document scroll moves the menu by the same 40px.

Browser validation also caught an integration difference in the updated main typography: preview headings inherited
a 24px line height while editable headings used 22.4px. The shared recipe now uses the standard 1.5 heading line height
in both surfaces.

Full Web verification also identified older textarea-based page/Cloud tests and the message-directory ordering
contract. These tests now exercise the direct editor and approved feedback copy; message keys remain sorted, and the
interpolated guidance call stays statically discoverable by the existing catalog test.

The final independent, read-only correction review reported: **“No actionable issues remain in the six corrections.”**
It reran 43 retained tests and 15 additional in-memory cases covering the final six findings. No files were modified by
the reviewer. Earlier broad passes supplied the remaining findings above; this last pass specifically verified their
latest corrections rather than repeating a new broad design review.

## Pull-request review: literal prose and Markdown structure

A separate pull-request reviewer reproduced three serialization defects at `22c9af4d`:
comparison symbols and ampersands became HTML entities, identifiers gained underscore escapes, and escaped literal
line starts became headings, lists, or quotes after reload. Fourteen new regression cases failed before correction.

The serializer now retains literal comparison symbols, ampersands, and intraword identifier underscores while using
the standard paragraph extension to protect literal block markers. Marked token ranges and prompt-source ranges
keep that protection outside inline code, images, and raw source spans. Twenty-seven retained cases cover loaded and typed
prose, repeated reloads, Unicode identifiers, placeholders, formatted text, table cells, and literal heading/list/quote/
rule markers. The affected editor, catalog, Markdown, and runtime-configuration suites pass all 131 tests.

The updated [source-preservation browser journey](markup-preservation-journey.spec.js) verifies the emitted draft,
real API persistence, and reload for the reported cases. Existing entities, XML, references, and code remain covered.
The Web UI contract now explicitly distinguishes exact preservation before editing from whole-document Markdown
normalization after an actual edit; it does not promise preservation of every original formatting delimiter.

A separate Server coverage run also reported an unhandled `EPIPE` from a real-Git test fixture after all assertions
passed. The fixture now observes stdin errors, accepts an early closed input pipe only when Git exits successfully
with a valid CGI response, and propagates other errors. The existing Local Git scenario passes; Cloud execution is
Linux-only and remains covered by CI. No Server product behavior or schema was changed.
