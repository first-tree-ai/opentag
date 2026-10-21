# Soul interaction refinements

Generated with the built-in image generation tool. These are visual proposals; no product code was changed. Template names, count, and bodies remain illustrative.

## Reviewed changes

- [Empty editor](01-empty-state.png): Browse templates stays in the page header at all times. The initial empty editor adds a centered guidance sentence with an inline browse templates link. Both entries open the same chooser.
- [Template detail](02-template-overview.png): a concise overview appears directly beneath the selected template name, describing applicable tasks and expected assistance. A quiet divider separates that catalog overview from the full template document.
- Full template text is expanded by default. The right reader scrolls as one region; list and footer remain available.
- There is no separate Overview title, Instruction focus module, or full-document disclosure toggle.
- The existing draft/apply flow remains as described in [the preceding interaction proposal](../soul-interaction-v3/README.md), with Discard changes and Apply changes and no separate Undo.

## Complete edit prompts

### 01: Empty editor with persistent and contextual template entry

Edit target: /Users/gandy/.codex/worktrees/3959/opentag/testing/design/soul-interaction-v3/01-entry.png

```text
Use case: ui-mockup.
Edit target: attached OpenTag Soul EMPTY page screenshot. Refine ONLY the initial empty-state guidance. Preserve the exact complete app screenshot, landscape dimensions, sidebar structure, Soul title, subtitle, header positions, generous editable white field, warm cream/white/violet palette, font family and quiet minimal style.
CRITICAL: keep the top-right secondary button 'Browse templates' fully visible and UNCHANGED. It is a permanent entry point and must remain.
Remove the old top-left placeholder 'Describe how you want your agent to work.' from inside the empty field. Also remove the redundant helper 'No custom instructions yet.' underneath.
At the horizontal and vertical CENTER of the same empty editing field put ONE compact, readable 16px inline guidance sentence:
'Write your own, or browse templates to get started.'
The words 'browse templates' WITHIN this sentence are a violet #5638d8 subtly underlined text link, same size as surrounding text. The rest of the sentence is a readable medium-dark gray. This is a REAL interactive text-link affordance, not all one gray placeholder; visually distinguish the link. Keep the sentence one line if it fits, otherwise two centered lines. Do not add a second filled button, extra heading, extra panel, artwork, icon or badge.
The rest of the field stays empty and click-to-edit. No Instructions heading, no dirty-state actions, no Undo. The top-right persistent entry and center contextual link intentionally open the SAME template chooser. Render only one full screen, no annotations, no numbered steps or collage. Crisp shippable UI mockup.
```

### 02: Template overview and expanded full document

Edit target: /Users/gandy/.codex/worktrees/3959/opentag/testing/design/soul-interaction-v3/02-browse-templates.png

```text
Use case: ui-mockup.
Edit target: attached OpenTag template chooser screenshot. Make ONE precise improvement: restore a concise task-oriented overview directly under the right-pane 'Engineering' title, before the actual template document. Preserve the complete screenshot dimensions, sidebar, dialog width and height, left list items, chosen Engineering, exact header 'Choose a template', close X, footer 'Cancel' and 'Use template', typography and restrained warm-white/violet visual system.
Right detail hierarchy, exactly:
1. Title 'Engineering' with existing title styling.
2. NEW OVERVIEW immediately below, regular readable 15-16px dark-secondary text across 2-3 lines:
'For implementing features, debugging issues, and reviewing code. Get focused solutions, clear trade-offs, and practical verification steps.'
This is catalog guidance to help users decide applicability. Do NOT label it Overview, Summary, Instruction focus, or Example task. Do not wrap it in a card or badge. Give it enough breathing room to distinguish it from the full document.
3. A thin neutral divider, then 20px gap.
4. The ACTUAL FULL TEMPLATE DOCUMENT, default expanded, preserving the existing text and document headings 'Role and goal', 'Working approach', 'Deliverables', 'Communication'. Do not replace the document with the overview. Keep text readable; the right pane may scroll as a SINGLE region when needed. Show the top of the actual body with multiple full sections and natural continuation of the final paragraph below if required. No nested textarea, no inner scrolling box, no extra Full instructions label, no disclosure toggle.
Only the right detail pane has a subtle scrollbar; left list and footer stay stable. The user can still read the actual full document before using the template.
Background top-right Browse templates remains present. Keep background page an empty editor; show a faint central empty-state guidance only if the portion of background field is visible, never a dirty save button. No independent Undo, no scores, no screenshots inside screenshots. Output one full high-fidelity desktop screen.
```

