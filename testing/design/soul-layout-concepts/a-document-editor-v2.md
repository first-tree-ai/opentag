# Refined Soul concept

Design direction: elegant, minimal, and precise.

[Refined image](a-document-editor-v2.png)

Generated with the built-in image generation tool using concept A as the edit target. This is a visual proposal, not an implemented screen.

## Decisions

- Keep one free-text instruction editor and one clear primary action.
- Consolidate template access into a single secondary action above the field.
- Present unsaved state once, directly beside the apply/discard actions.
- Keep the next-turn application notice beside the actions.
- Remove preview tabs, duplicate status labels, character counts, and the separate guidance panel.
- Keep arbitrary natural-language instructions and existing product semantics.

The populated text is an illustrative draft. Empty-state guidance must remain distinct from saved or editable content. Template replacement and undo still need to remain available in their relevant interaction states.

## Complete edit prompt

```text
Use case: ui-mockup.
Input image: the attached existing OpenTag concept A is the EDIT TARGET.
Refine this desktop Soul settings screenshot to feel ELEGANT, MINIMAL, PRECISE. Preserve the warm cream canvas, white editing field, restrained violet brand, modern Manrope-like sans typography, full left agent sidebar with exactly its current destinations, and English language. Produce one flat crisp front-on high-fidelity desktop screenshot, landscape 16:10. No decorative art, no perspective, no device frame, no design annotations.

The central improvement is subtraction and exact task hierarchy. Replace the cluttered main content with this carefully specified composition:
- A single approximately 900px wide form column, balanced within the main area with useful readable line lengths. Main starts around 60px from top. Maintain restrained 28px title, 14-16px supporting text. Left nav roughly 224px of a conceptual 1440px viewport.
- Top title 'Soul'. Below it ONE short sentence 'Define how this agent responds and works.' No status at top, no header buttons.
- 32px gap. One field-label row: 'Instructions' on left (14px semibold); on the far right a small neutral secondary button 'Use template' and downward chevron. This is the ONLY template entry. It is an action, not a selector showing a currently active template, because a draft may have been customized.
- 12px gap. ONE clean plain text editing field, white, 8px rounded corners, thin visible neutral boundary, about 420px high and 900px wide. No inner header, no inner footer, no tabs, no toolbar, no font controls, no character count, no preview, no help panel. Text padding about 24px, readable 16px sans font and 26px line height. The contents are actual editable draft text in dark ink, not a placeholder and not a rendered rich-text document. Use exactly:
'You are a software engineering assistant.'
'Be practical, precise, and candid.'
blank line
'Communication'
'- Lead with the answer. Keep replies concise.'
'- Explain trade-offs and recommend one option.'
blank line
'Working principles'
'- Read the relevant code before making changes.'
'- Verify assumptions and run focused checks.'
'- Ask when essential information is missing.'
All text, including section names, has the same font size because this is plain text. A small native resize grip in the bottom-right is enough.
- 20px below the editing field, one neat action row within the SAME column. Left has a small quiet neutral dot and 'Unsaved changes', below in smaller gray 'Changes apply from the next turn.' Right has text-style secondary 'Discard' and one solid violet primary button 'Apply changes'. The buttons are 40px tall and 8px radius with no gradient. Align the actions directly with the editing field rather than pinning a giant bar to the viewport bottom.
- Leave a calm modest amount of cream breathing space below; do not stretch the editor solely to fill the viewport.
- Left navigation is compact and precise, about 224px width with 14px labels, tidy 40px rows. Preserve 'All Agents', 'opentag-slack-2', 'Overview', 'Tasks', 'Soul', 'Memory', 'Skills', 'Connectors', 'Usage' and bottom user 'hao xiong'. Soul selected pale lavender and violet. No new destinations.

Remove ALL duplicate unsaved statuses, 'Starting point', 'Browse templates', 'Writing tips', template warnings, Edit/Preview toggle, Markdown-supported footer, character count, guidance accordion, sticky full-width footer bar, giant oversized padding. Keep only essential state and actions. Do not add new functionality. Every visible element has a clear role. Overall impression: quiet professional product configuration, precise alignment, comfortable line length, restrained details.

```

