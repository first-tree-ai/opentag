# Simplified Soul template journey

Visual proposals for one editor and one template chooser, reflecting the settled product rule: users edit, then either discard or apply. There is no separate template Undo action.

The refined images were generated with the built-in image generation tool. The unchanged entry image is reused from the preceding journey. These are design mockups, not implemented screens or acceptance evidence.

## Screens

1. [Entry](01-entry.png): write directly or browse templates. Empty guidance is visibly separate from saved text.
2. [Choose a template](02-choose-template.png): scan task descriptions, inspect intended use, instruction focus, and a typical task. Full instructions are collapsed by default.
3. [Read full instructions](03-full-instructions.png): optional expansion inside the same chooser. One scrolling details pane; template list and actions remain available.
4. [Edit the draft](04-edit-draft.png): using a template fills the editor without saving. The user has added a requirement to ask before adding a dependency. The only editing actions are Discard changes and Apply changes.
5. [Applied](05-applied.png): the same customized text is saved; the feedback specifies next-turn application.

## Branches

- Direct writing: Entry -> Edit the draft -> Applied. Templates are optional.
- Template use: Entry -> Choose a template -> optional full instructions -> Edit the draft -> Applied.
- Cancel or close the chooser: return to the unchanged editor.
- Discard changes: restore the most recently saved text and remove dirty actions. In this first-visit example the saved text is empty, so the result is exactly the Entry image. After a successful save, later discarding restores that saved text instead.
- Apply changes: persist the current text and show the saved result. The only primary persistence action is Apply changes.

No extra undo concept, no automatic persistence after template selection, and no mandatory wizard are introduced.

## Design notes

- Template descriptions and examples help choose by task rather than by name alone.
- The expanded preview shows the template before the user's custom requirement is added.
- Summaries and example tasks are illustrative copy; implementation must derive accurate descriptions from real preset contents.
- Errors, busy state, responsive adaptation, and keyboard/accessibility behavior remain implementation acceptance work.
- This proposal removes the independent template Undo shown in earlier concepts; product code has not been modified.

## Complete generation prompts

The reused entry image and its original prompt are documented in [the preceding journey](../soul-template-journey/README.md).

### 02: Choose a template

```text
Use case: ui-mockup.
Edit target: attached OpenTag EMPTY Soul page. Create ONE full desktop screenshot for the same app, same 1600x1000 landscape proportions, exact same left navigation and regular-page geometry, warm cream #fffcf7 canvas, white inputs, dark #171719 text, secondary gray #4c4d5c, flat violet #5638d8 actions and pale lavender selection. Modern Manrope-like sans font, readable 14-16px body, 28px page title, flat 8px control corners and 16px modal corners, restrained precise spacing. Front-on product UI, no device frame, perspective, decorations, step numbers, annotations or multi-screen boards.
Keep All Agents; agent opentag-slack-2; Overview, Tasks, Soul selected, Memory, Skills, Connectors, Usage; bottom hao xiong. Main page title Soul, subtitle 'Define how this agent responds and works.', field label Instructions, secondary 'Browse templates'. Do not add new navigation.
Product simplicity rule: NO Undo action or undo/revert-template text anywhere. Editable dirty page has ONLY 'Discard changes' and 'Apply changes' as editing actions. Template browsing never changes draft; explicit Use Engineering fills it; Apply changes is the only persistent save. No autosave claims, no scores, no chat test, no duplicate state labels.

STATE: TEMPLATE CHOOSER, OVERVIEW.
Add one centered white modal roughly 1000px wide and 650px tall over a lightly dimmed EMPTY Soul page. Background editor remains empty, no save buttons behind the modal. Modal header 'Choose a starting point' and close X. No repetitive subtitle.
Body: narrow 240px left list, hairline separator, spacious 700px right details. Left rows show title plus one short gray task descriptor, all five visible:
Engineering / Build, debug, and review code
Design / Shape interfaces and experiences
Product / Clarify needs and priorities
Growth / Plan experiments and campaigns
Operations / Coordinate workflows and delivery
Engineering is selected with pale lavender and violet text. These are browse selections only. No green checks implying applied state.
RIGHT pane:
Title 'Engineering'.
Fit sentence 'For implementing features, debugging issues, and reviewing code.'
24px gap.
Small semibold section 'Instruction focus'
Three simple dark bullet lines:
'Read relevant code before making changes.'
'Explain trade-offs and recommend a path.'
'Verify changes with focused checks.'
24px gap.
Small semibold section 'Example task'
A short natural-language example, not a chat or input: 'Find the cause of intermittent login timeouts and verify the fix.'
24px gap then one subtle horizontal divider and an accordion disclosure row with right-pointing chevron, text 'View full instructions'. It is COLLAPSED, so no raw instruction text is displayed yet. Do NOT put every block into its own card. The examples and task scope should be easy to scan at a glance.
Fixed modal footer separated by one hairline: left small text 'You can edit these instructions before saving.' Right ghost 'Cancel' and violet button 'Use Engineering'. This is one dialog, not an extra page or onboarding wizard. Preserve ample readable spacing without giant blank regions.

```

### 04: Edit the draft

```text
Use case: ui-mockup.
Edit target: attached OpenTag EMPTY Soul page. Create ONE full desktop screenshot for the same app, same 1600x1000 landscape proportions, exact same left navigation and regular-page geometry, warm cream #fffcf7 canvas, white inputs, dark #171719 text, secondary gray #4c4d5c, flat violet #5638d8 actions and pale lavender selection. Modern Manrope-like sans font, readable 14-16px body, 28px page title, flat 8px control corners and 16px modal corners, restrained precise spacing. Front-on product UI, no device frame, perspective, decorations, step numbers, annotations or multi-screen boards.
Keep All Agents; agent opentag-slack-2; Overview, Tasks, Soul selected, Memory, Skills, Connectors, Usage; bottom hao xiong. Main page title Soul, subtitle 'Define how this agent responds and works.', field label Instructions, secondary 'Browse templates'. Do not add new navigation.
Product simplicity rule: NO Undo action or undo/revert-template text anywhere. Editable dirty page has ONLY 'Discard changes' and 'Apply changes' as editing actions. Template browsing never changes draft; explicit Use Engineering fills it; Apply changes is the only persistent save. No autosave claims, no scores, no chat test, no duplicate state labels.

STATE: TEMPLATE INSERTED AND USER CUSTOMIZED THE DRAFT.
No modal or dimming. Preserve exact empty reference page header, margins, sidebar, textarea geometry. Replace the muted placeholder with the following exact dark actual editable content, same-size plain sans text, comfortable 25px line height and paragraph breaks:
You are a software engineering assistant.
Be practical, precise, and candid.

Communication
- Lead with the answer. Keep replies concise.
- Explain trade-offs and recommend one option.

Working principles
- Read the relevant code before making changes.
- Verify assumptions and run focused checks.
- Ask when essential information is missing.
- Ask before adding a new dependency.
The last line is the user's added custom requirement. Put a subtle text caret at the end of that line. Do not highlight the entire paragraph, show no tooltip, badge, toast or Template added banner. There is no extra template status or Undo.
Below editor use the same aligned action row: on left neutral small dot and 'Unsaved changes', second line 'Changes apply from the next turn.' On right a neutral secondary button 'Discard changes' and flat violet primary 'Apply changes'. All fit within viewport. No sticky full-width bar, no character count, no preview switch. The only highlighted action is Apply changes.

```

### 05: Changes applied

```text
Use case: ui-mockup.
Edit target: attached OpenTag EMPTY Soul page. Create ONE full desktop screenshot for the same app, same 1600x1000 landscape proportions, exact same left navigation and regular-page geometry, warm cream #fffcf7 canvas, white inputs, dark #171719 text, secondary gray #4c4d5c, flat violet #5638d8 actions and pale lavender selection. Modern Manrope-like sans font, readable 14-16px body, 28px page title, flat 8px control corners and 16px modal corners, restrained precise spacing. Front-on product UI, no device frame, perspective, decorations, step numbers, annotations or multi-screen boards.
Keep All Agents; agent opentag-slack-2; Overview, Tasks, Soul selected, Memory, Skills, Connectors, Usage; bottom hao xiong. Main page title Soul, subtitle 'Define how this agent responds and works.', field label Instructions, secondary 'Browse templates'. Do not add new navigation.
Product simplicity rule: NO Undo action or undo/revert-template text anywhere. Editable dirty page has ONLY 'Discard changes' and 'Apply changes' as editing actions. Template browsing never changes draft; explicit Use Engineering fills it; Apply changes is the only persistent save. No autosave claims, no scores, no chat test, no duplicate state labels.

STATE: APPLICATION SUCCEEDED.
No modal, no dimming. Preserve exact reference page layout and editor geometry. Fill editor with EXACT SAME actual plain text as the user's customized draft:
You are a software engineering assistant.
Be practical, precise, and candid.

Communication
- Lead with the answer. Keep replies concise.
- Explain trade-offs and recommend one option.

Working principles
- Read the relevant code before making changes.
- Verify assumptions and run focused checks.
- Ask when essential information is missing.
- Ask before adding a new dependency.
No caret or text selection. Below editor, remove all dirty-state labels and remove Discard changes / Apply changes buttons. Show ONE quiet inline success feedback: small green outline check-circle, dark text 'Changes saved', secondary line 'Applies from the next turn.' No green banner or toast elsewhere. Browse templates remains in its regular upper-right position. Editor remains editable. This saved state must have the added dependency requirement exactly as in the prior draft.

```

### 03: Optional full instructions

```text
Use case: ui-mockup.
Edit target: attached OpenTag template chooser OVERVIEW screenshot. This is the OPTIONAL EXPANDED FULL-INSTRUCTIONS state of the EXACT SAME chooser. Preserve the complete screenshot dimensions, left app navigation, empty dimmed Soul page in background, modal position and size, modal title 'Choose a starting point', left template list with Engineering selected and all icons/descriptors, bottom footer and buttons 'Cancel' and 'Use Engineering', and exact warm white/violet/gray aesthetic.
Change ONLY the right details pane to show the 'View full instructions' accordion EXPANDED. The entire right details pane is a single scrollable document region with one subtle scrollbar at its far right edge; NO nested textarea, no internal scroll box, no resize handle, no inner bordered card. Keep header/footer fixed. Show a scroll position where the top title 'Engineering' and fit sentence remain visible at top, then compact existing Instruction focus bullets, existing Example task, then divider and expanded disclosure row with DOWNWARD chevron labeled 'Full instructions'. Below that row show the actual read-only instruction text naturally typeset as same-size document text on white with clear paragraph spacing:
You are a software engineering assistant.
Be practical, precise, and candid.

Communication
- Lead with the answer. Keep replies concise.
- Explain trade-offs and recommend one option.

Working principles
- Read the relevant code before making changes.
- Verify assumptions and run focused checks.
- Ask when essential information is missing.
The right body may scroll if text exceeds available height; display as much readable original text as fits, with bottom cutoff through natural scrolling. Do not cram by shrinking typography. It is acceptable for the final lines to continue below the visible body. The footer with Use Engineering stays fully visible. No new modal, no back button, no chat, no score, no copy button, NO Undo or template-revert action. Keep this clearly the same browsing step as overview, simply expanded for users who want to inspect actual text. Full instruction content is READ-ONLY here; applying the template is a separate button in the footer. Generate ONE full app screenshot, not a board.

```

