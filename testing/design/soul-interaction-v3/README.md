# Soul interaction structure: revised visual journey

These four desktop concepts reflect the agreed interaction structure. They were generated using the built-in image generation tool with the prior editor concept as the edit target. They are visual proposals, not implemented product screens.

## Current decisions

- One Soul editing page and one template chooser.
- Page header: Soul, a concise explanation, and Browse templates.
- Remove the redundant standalone Instructions heading.
- Template chooser: task-oriented names and descriptions on the left, the selected template's complete body on the right.
- Display full content by default; no independent Instruction focus, example task, or disclosure toggle.
- The template document can contain its own readable section headings.
- Preview is read-only. Use template fills the editor without saving.
- The editor has only Discard changes and Apply changes for pending edits. There is no separate Undo action.
- Applied changes are confirmed with a next-turn notice.
- Template quantity, names, descriptions, and the demonstration body shown here remain illustrative. This iteration settles interaction structure only.

## Screens

1. [Entry](01-entry.png): empty editor; direct writing and template browsing are both possible.
2. [Browse templates](02-browse-templates.png): select and read full text before choosing Use template.
3. [Edit draft](03-edit-draft.png): the user has added a request to ask before introducing a dependency; the draft is not yet saved.
4. [Applied](04-applied.png): identical customized content has been saved and will apply from the next turn.

Cancel or close the chooser preserves the draft that existed before opening. Discard changes restores the most recently saved content; in this first-visit example that is the empty Entry state. Save failure must preserve the draft and expose an actionable message; busy state must prevent duplicate submission. Those runtime states and responsive/keyboard acceptance remain implementation work.

## Demonstration template

This draft text is authored for visual review, not imported from a third-party repository and not an approved product preset.

```text
Role and goal
Help the team ship reliable, maintainable software. Support implementation, debugging, code review, and technical decisions. Work toward the user's actual goal and respect existing project constraints.

Working approach
Read relevant code, documentation, and tests before proposing changes. Investigate failures with evidence and distinguish facts from assumptions. Prefer focused changes that solve the underlying problem. Explain meaningful trade-offs and recommend a path. Ask when missing information changes the solution; otherwise proceed with a stated assumption.

Deliverables
Complete the requested work and run appropriate checks. Report what changed, what was verified, and any remaining limitations. For reviews, prioritize actionable findings and explain their impact. Describe results accurately when verification is unavailable.

Communication
Lead with the answer and use plain language. Keep straightforward requests concise. Structure complex work into clear steps, with enough detail for the user to judge progress and make decisions. Be candid about uncertainty and revise your view when evidence changes.
```

## Complete generation prompts

### 01: Entry

```text
Use case: ui-mockup.
Edit target: supplied OpenTag Soul screenshot. Produce ONE polished, readable, flat desktop screenshot at landscape 16:10 approximately 1600x1000. Preserve the application's left sidebar and brand: warm cream #fffcf7 canvas, white textarea and dialog, dark #171719 text, secondary #4c4d5c, neutral warm borders, violet #5638d8 buttons, lavender #f1ebff selected navigation, Manrope-like sans. App is a calm practical working tool, no device mockup, no browser frame, no decorative artwork, no diagram labels or step numbers, no multi-screen collage.
Left sidebar retains existing agent switcher opentag-slack-2, All Agents, Overview, Tasks, Soul selected, Memory, Skills, Connectors, Usage and bottom hao xiong. Main content is one readable column with aligned margins.
MANDATORY CURRENT INTERACTION DESIGN: remove the standalone field heading 'Instructions' COMPLETELY. Also remove all 'Full instructions', 'Instruction focus', 'Example task', 'View full instructions', 'Edit', 'Preview', character count and Undo UI. A section called 'Working approach' INSIDE the actual document is allowed. Only the main page title 'Soul' remains, followed by one explanatory sentence 'Define this agent’s role, communication style, and working principles.' Place the ONE secondary action 'Browse templates' at the TOP RIGHT of the page header, aligned with the Soul title. Do not leave a second empty toolbar row above the editor.
The editor starts 32px below the header description. It is one plain white textarea with visible fine neutral outline, 8px radius, 24px padding, approximately 540px height, comfortable readable 15-16px plain sans body with 23px line height. It may naturally scroll when content requires, never shrink text to cram content. No embedded toolbar, labels, footer or formatting controls. A native small resize grip is fine for this actual editable textarea. Page actions sit DIRECTLY below the editor aligned to its edges, never a full-width viewport-bottom sticky bar. Keep one primary action per context.

STATE: EMPTY CLEAN EDITOR.
Keep the editor empty except for this clearly muted placeholder at top left: 'Describe how you want your agent to work.' Do not show any example role or bullet list pretending to be existing content. Beneath editor one small quiet helper 'No custom instructions yet.' No unsaved status, no Discard changes and no Apply changes, no success messages. Header Browse templates remains the clear secondary entry. This is the first-visit state.

```

### 02: Template selection

```text
Use case: ui-mockup.
Edit target: supplied OpenTag Soul screenshot. Produce ONE polished, readable, flat desktop screenshot at landscape 16:10 approximately 1600x1000. Preserve the application's left sidebar and brand: warm cream #fffcf7 canvas, white textarea and dialog, dark #171719 text, secondary #4c4d5c, neutral warm borders, violet #5638d8 buttons, lavender #f1ebff selected navigation, Manrope-like sans. App is a calm practical working tool, no device mockup, no browser frame, no decorative artwork, no diagram labels or step numbers, no multi-screen collage.
Left sidebar retains existing agent switcher opentag-slack-2, All Agents, Overview, Tasks, Soul selected, Memory, Skills, Connectors, Usage and bottom hao xiong. Main content is one readable column with aligned margins.
MANDATORY CURRENT INTERACTION DESIGN: remove the standalone field heading 'Instructions' COMPLETELY. Also remove all 'Full instructions', 'Instruction focus', 'Example task', 'View full instructions', 'Edit', 'Preview', character count and Undo UI. A section called 'Working approach' INSIDE the actual document is allowed. Only the main page title 'Soul' remains, followed by one explanatory sentence 'Define this agent’s role, communication style, and working principles.' Place the ONE secondary action 'Browse templates' at the TOP RIGHT of the page header, aligned with the Soul title. Do not leave a second empty toolbar row above the editor.
The editor starts 32px below the header description. It is one plain white textarea with visible fine neutral outline, 8px radius, 24px padding, approximately 540px height, comfortable readable 15-16px plain sans body with 23px line height. It may naturally scroll when content requires, never shrink text to cram content. No embedded toolbar, labels, footer or formatting controls. A native small resize grip is fine for this actual editable textarea. Page actions sit DIRECTLY below the editor aligned to its edges, never a full-width viewport-bottom sticky bar. Keep one primary action per context.

STATE: TEMPLATE CHOOSER OVER EMPTY CLEAN EDITOR.
The background is the newly revised EMPTY Soul page: no Instructions field heading anywhere, Browse templates button in the page header top right, empty textarea with faint placeholder, no dirty actions. Apply a light neutral dimming scrim.
Centered white dialog, approximately 1050px wide and 780px tall. Modal top header title 'Choose a template', close X top right. No marketing subtitle. Footer fixed with thin divider, left 'You can edit this before applying changes.', right secondary 'Cancel' and solid violet primary 'Use template'. Modal body has 220px left template list, thin divider and generous right reader.
LEFT list five illustrative categories with small simple line icons, each a name and a short scope description; all visible, Engineering selected lavender:
Engineering / Build, debug, and review code
Design / Shape interfaces and experiences
Product / Clarify needs and priorities
Growth / Plan experiments and campaigns
Operations / Coordinate workflows and delivery
Do not show badges, recommendation scores, search or filters.
RIGHT reader title 'Engineering', then the FULL template document DEFAULT EXPANDED immediately underneath. No additional summary, no Instruction focus or Full instructions heading, no collapse control. Read-only document styling, small semibold internal section headings, regular sans body 14-16px, comfortable spacing. The right reader is the ONLY scrolling body region; do not put the document in an inner textarea, card, separate scrolling box, or editable control. A fine scrollbar at the far right is allowed. Keep the use/cancel buttons visible even with long text.
Document exactly:
Role and goal
Help the team ship reliable, maintainable software. Support implementation, debugging, code review, and technical decisions. Work toward the user's actual goal and respect existing project constraints.

Working approach
Read relevant code, documentation, and tests before proposing changes. Investigate failures with evidence and distinguish facts from assumptions. Prefer focused changes that solve the underlying problem. Explain meaningful trade-offs and recommend a path. Ask when missing information changes the solution; otherwise proceed with a stated assumption.

Deliverables
Complete the requested work and run appropriate checks. Report what changed, what was verified, and any remaining limitations. For reviews, prioritize actionable findings and explain their impact. Describe results accurately when verification is unavailable.

Communication
Lead with the answer and use plain language. Keep straightforward requests concise. Structure complex work into clear steps, with enough detail for the user to judge progress and make decisions. Be candid about uncertainty and revise your view when evidence changes.
Use readable typography even if the end of the final paragraph requires scrolling. No fake tool test results. Clicking a category in this interface only changes preview; the only confirmation is Use template.

```

### 03: Customized draft

```text
Use case: ui-mockup.
Edit target: supplied OpenTag Soul screenshot. Produce ONE polished, readable, flat desktop screenshot at landscape 16:10 approximately 1600x1000. Preserve the application's left sidebar and brand: warm cream #fffcf7 canvas, white textarea and dialog, dark #171719 text, secondary #4c4d5c, neutral warm borders, violet #5638d8 buttons, lavender #f1ebff selected navigation, Manrope-like sans. App is a calm practical working tool, no device mockup, no browser frame, no decorative artwork, no diagram labels or step numbers, no multi-screen collage.
Left sidebar retains existing agent switcher opentag-slack-2, All Agents, Overview, Tasks, Soul selected, Memory, Skills, Connectors, Usage and bottom hao xiong. Main content is one readable column with aligned margins.
MANDATORY CURRENT INTERACTION DESIGN: remove the standalone field heading 'Instructions' COMPLETELY. Also remove all 'Full instructions', 'Instruction focus', 'Example task', 'View full instructions', 'Edit', 'Preview', character count and Undo UI. A section called 'Working approach' INSIDE the actual document is allowed. Only the main page title 'Soul' remains, followed by one explanatory sentence 'Define this agent’s role, communication style, and working principles.' Place the ONE secondary action 'Browse templates' at the TOP RIGHT of the page header, aligned with the Soul title. Do not leave a second empty toolbar row above the editor.
The editor starts 32px below the header description. It is one plain white textarea with visible fine neutral outline, 8px radius, 24px padding, approximately 540px height, comfortable readable 15-16px plain sans body with 23px line height. It may naturally scroll when content requires, never shrink text to cram content. No embedded toolbar, labels, footer or formatting controls. A native small resize grip is fine for this actual editable textarea. Page actions sit DIRECTLY below the editor aligned to its edges, never a full-width viewport-bottom sticky bar. Keep one primary action per context.

STATE: USER HAS USED A TEMPLATE AND EDITED THE DRAFT.
No modal. Actual editable dark plain-text content in the textarea is exactly:
Role and goal
Help the team ship reliable, maintainable software. Support implementation, debugging, code review, and technical decisions. Work toward the user's actual goal and respect existing project constraints.

Working approach
Read relevant code, documentation, and tests before proposing changes. Investigate failures with evidence and distinguish facts from assumptions. Prefer focused changes that solve the underlying problem. Explain meaningful trade-offs and recommend a path. Ask when missing information changes the solution; otherwise proceed with a stated assumption. Ask before adding a new dependency.

Deliverables
Complete the requested work and run appropriate checks. Report what changed, what was verified, and any remaining limitations. For reviews, prioritize actionable findings and explain their impact. Describe results accurately when verification is unavailable.

Communication
Lead with the answer and use plain language. Keep straightforward requests concise. Structure complex work into clear steps, with enough detail for the user to judge progress and make decisions. Be candid about uncertainty and revise your view when evidence changes.
The headings inside the textarea use the SAME size and weight as the text because this is a plain text field, not a rich-text preview. Preserve paragraph breaks. A subtle text caret can appear after the sentence 'Ask before adding a new dependency.' The user added this sentence; do not highlight it with a colored box, badge, toast, or annotation.
Below textarea: left small neutral dot and 'Unsaved changes', supporting 'Changes apply from the next turn.' Right secondary button 'Discard changes' and primary violet button 'Apply changes'. No independent Undo or Template added feedback; no field label Instructions. Main header right Browse templates. No success check yet. Use a subtle editor scrollbar if needed, but all primary actions remain within viewport.

```

### 04: Saved

```text
Use case: ui-mockup.
Edit target: supplied OpenTag Soul screenshot. Produce ONE polished, readable, flat desktop screenshot at landscape 16:10 approximately 1600x1000. Preserve the application's left sidebar and brand: warm cream #fffcf7 canvas, white textarea and dialog, dark #171719 text, secondary #4c4d5c, neutral warm borders, violet #5638d8 buttons, lavender #f1ebff selected navigation, Manrope-like sans. App is a calm practical working tool, no device mockup, no browser frame, no decorative artwork, no diagram labels or step numbers, no multi-screen collage.
Left sidebar retains existing agent switcher opentag-slack-2, All Agents, Overview, Tasks, Soul selected, Memory, Skills, Connectors, Usage and bottom hao xiong. Main content is one readable column with aligned margins.
MANDATORY CURRENT INTERACTION DESIGN: remove the standalone field heading 'Instructions' COMPLETELY. Also remove all 'Full instructions', 'Instruction focus', 'Example task', 'View full instructions', 'Edit', 'Preview', character count and Undo UI. A section called 'Working approach' INSIDE the actual document is allowed. Only the main page title 'Soul' remains, followed by one explanatory sentence 'Define this agent’s role, communication style, and working principles.' Place the ONE secondary action 'Browse templates' at the TOP RIGHT of the page header, aligned with the Soul title. Do not leave a second empty toolbar row above the editor.
The editor starts 32px below the header description. It is one plain white textarea with visible fine neutral outline, 8px radius, 24px padding, approximately 540px height, comfortable readable 15-16px plain sans body with 23px line height. It may naturally scroll when content requires, never shrink text to cram content. No embedded toolbar, labels, footer or formatting controls. A native small resize grip is fine for this actual editable textarea. Page actions sit DIRECTLY below the editor aligned to its edges, never a full-width viewport-bottom sticky bar. Keep one primary action per context.

STATE: THE CUSTOMIZED DRAFT WAS SUCCESSFULLY SAVED.
No modal. Actual editable dark plain-text content is exactly:
Role and goal
Help the team ship reliable, maintainable software. Support implementation, debugging, code review, and technical decisions. Work toward the user's actual goal and respect existing project constraints.

Working approach
Read relevant code, documentation, and tests before proposing changes. Investigate failures with evidence and distinguish facts from assumptions. Prefer focused changes that solve the underlying problem. Explain meaningful trade-offs and recommend a path. Ask when missing information changes the solution; otherwise proceed with a stated assumption. Ask before adding a new dependency.

Deliverables
Complete the requested work and run appropriate checks. Report what changed, what was verified, and any remaining limitations. For reviews, prioritize actionable findings and explain their impact. Describe results accurately when verification is unavailable.

Communication
Lead with the answer and use plain language. Keep straightforward requests concise. Structure complex work into clear steps, with enough detail for the user to judge progress and make decisions. Be candid about uncertainty and revise your view when evidence changes.
All internal document headings are plain text, same size and weight as body. No text caret, no selection.
Below textarea show one quiet feedback result: small green outlined check-circle, dark 'Changes saved', secondary sentence 'Applies from the next turn.' REMOVE Discard changes and Apply changes buttons and remove unsaved status because contents are now saved. Header Browse templates remains. No duplicate top status, no large green banner, no toast. Do not claim the agent has executed the instructions. Keep the same regular page geometry and textarea size as empty/draft states; use natural editor scrolling if necessary.

```

