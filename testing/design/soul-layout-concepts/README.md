# Soul layout concepts

Three desktop image concepts for design review, generated with the built-in image generation tool. These are visual proposals, not implemented screens or acceptance evidence.

## Observed problems

- Empty-state examples resemble saved instruction text.
- Template choices appear after the editor, reversing the starting workflow.
- Very wide text lines and large unused space weaken the editing hierarchy.
- Save/discard controls and next-turn behavior deserve a stable, visible location while editing.

The existing implementation already supports save/discard feedback, preset undo, and next-turn application; the proposals improve their presentation rather than introducing those behaviors.

## Alternatives

| Concept | Main interaction | Implementation implication |
| --- | --- | --- |
| A: Document editor | One focused editor, compact template entry, persistent draft actions | Closest to existing behavior; adds a proposed rendered preview and reorganizes guidance |
| B: Editor and test | Draft editor beside a test conversation | Requires a new draft-testing workflow, including execution, loading, error, and usage handling |
| C: Guided configuration | Role, communication, and working-principle inputs with compiled preview | Requires a structured authoring model and an explicit policy for arbitrary Markdown round trips |

Recommended starting point: A. Consider B as a later capability if users need to verify instructions. C is useful for onboarding but should preserve unrestricted Markdown editing without losing existing text.

## Images

- [A: Document editor](a-document-editor.png)
- [B: Editor and test](b-editor-and-test.png)
- [C: Guided configuration](c-guided-configuration.png)

The images use English to match the reference screenshot. Displayed conversations, instruction contents, character counts, and draft states are illustrative. They are not measurements or execution results. Inspect the actual responsive layout, keyboard flow, contrast, and localization during implementation.

## Complete generation prompts

### A: Document editor

```text
Use case: ui-mockup.
Create ONE high-fidelity desktop web application screenshot for OpenTag's agent Soul settings, flat front-on, landscape 16:10 approximately 1600x1000, razor-sharp legible interface, full screen fills the image. This is a serious working application, not a landing page or mood board; no device frame, no perspective, no shadows around screenshot, no decorative illustration, no external annotations.
Existing product design foundation: warm cream #fffcf7 canvas, white surfaces, #171719 primary text, #4c4d5c secondary text, violet #5638d8 primary actions and lavender #f1ebff selection, warm gray #e5e0db borders. Manrope-like modern sans typography, page title 28px, body 14-16px, 8px control radii, restrained flat surfaces. High contrast text, subtle dividers, line icons, generous but purposeful spacing. Do not use nested cards or metric cards or large blank lower half. English UI copy matching the existing application language.
Keep a 224px wide full-height left navigation: top home icon and 'All Agents', agent switcher with circular 'OS' avatar and 'opentag-slack-2', then line-icon rows 'Overview', 'Tasks', 'Soul', 'Memory', 'Skills', 'Connectors', 'Usage'. Soul is selected with a pale lilac row and violet text. A subtle divider separates the sidebar. Bottom user 'hao xiong' with small 'HX' avatar. Main layout uses the full remaining width with disciplined readable max-width and modest margins. Do not add fake usage stats, scores or decorative robots.
Maintain the conceptual truth that Soul is editable natural-language instructions for how the Agent responds and works; saved changes take effect from the next turn. Make example guidance distinct from editable actual draft text. Include explicit meaningful save/discard affordances for the shown unsaved draft. Avoid an anonymous giant textarea with placeholder masquerading as content.

CONCEPT A — DOCUMENT EDITOR. A calm focused writing surface, one main column; absolutely no right sidebar or test panel. Make it look polished and practical in a 1440px laptop viewport.
Main content begins 56px from sidebar, max width 1000px. Header: 'Soul', underneath 'Define how opentag-slack-2 responds and works.' A small quiet text 'Unsaved changes' right aligned in header.
Below header a compact horizontal toolbar: left label 'Starting point' and bordered dropdown 'Engineering' with small code icon and chevron, then text-button 'Browse templates'; right link 'Writing tips' with help icon. A small explanatory line 'Templates replace your draft. You can undo the change.' below the toolbar.
Below 20px gap ONE large white document editor with subtle border, 12px radius, approx 1000px wide and 510px tall. Its top thin toolbar has 'Instructions' left and compact 'Edit' selected / 'Preview' switch right. Main text field is populated actual black text, comfortably spaced, with simple markdown syntax, not placeholder gray:
'# Role'
'You are a software engineering assistant.'
'Be practical, precise, and candid.'
blank
'# Communication'
'- Lead with the answer. Keep replies concise.'
'- Explain trade-offs and recommend a clear path.'
blank
'# Working principles'
'- Read the relevant code before making changes.'
'- Verify assumptions and run focused checks.'
'- Ask when essential information is missing.'
At editor bottom an understated divider and small metadata 'Markdown supported' left, '618 characters' right.
Below editor a minimal inline expandable row 'How to write useful instructions' with chevron. No extra cards.
At bottom of MAIN area an aligned sticky action bar on cream, separated with top hairline. Left status neutral small dot 'Unsaved changes' and smaller 'Changes apply from the next turn.' Right ghost button 'Discard' and solid violet button 'Apply changes'. Keep it visually connected to the editor, 48px from image bottom. Entire interface is clean, calm, with useful line length, no excessive dead space. This is the most conservative immediately implementable redesign.

```

### B: Editor and test

```text
Use case: ui-mockup.
Create ONE high-fidelity desktop web application screenshot for OpenTag's agent Soul settings, flat front-on, landscape 16:10 approximately 1600x1000, razor-sharp legible interface, full screen fills the image. This is a serious working application, not a landing page or mood board; no device frame, no perspective, no shadows around screenshot, no decorative illustration, no external annotations.
Existing product design foundation: warm cream #fffcf7 canvas, white surfaces, #171719 primary text, #4c4d5c secondary text, violet #5638d8 primary actions and lavender #f1ebff selection, warm gray #e5e0db borders. Manrope-like modern sans typography, page title 28px, body 14-16px, 8px control radii, restrained flat surfaces. High contrast text, subtle dividers, line icons, generous but purposeful spacing. Do not use nested cards or metric cards or large blank lower half. English UI copy matching the existing application language.
Keep a 224px wide full-height left navigation: top home icon and 'All Agents', agent switcher with circular 'OS' avatar and 'opentag-slack-2', then line-icon rows 'Overview', 'Tasks', 'Soul', 'Memory', 'Skills', 'Connectors', 'Usage'. Soul is selected with a pale lilac row and violet text. A subtle divider separates the sidebar. Bottom user 'hao xiong' with small 'HX' avatar. Main layout uses the full remaining width with disciplined readable max-width and modest margins. Do not add fake usage stats, scores or decorative robots.
Maintain the conceptual truth that Soul is editable natural-language instructions for how the Agent responds and works; saved changes take effect from the next turn. Make example guidance distinct from editable actual draft text. Include explicit meaningful save/discard affordances for the shown unsaved draft. Avoid an anonymous giant textarea with placeholder masquerading as content.

CONCEPT B — EDIT AND TEST SPLIT WORKSPACE. A substantive new interaction model. Main area header 'Soul', subtitle 'Write instructions, then try them before applying.' Beneath header small icon label 'Draft workspace'. A quiet bordered header button 'Browse templates' near upper right.
Below header a large split workspace with a thin vertical divider: left editor about 58% width, right testing panel about 42% width. Use space efficiently without tiny typography.
Left header 'Instructions', small outlined dropdown 'Engineering' on right. Under header a plain white editor, no nesting, with actual black natural-language Markdown:
'# Role'
'You are a software engineering assistant.'
'Be practical, precise, and candid.'
blank
'# Communication'
'- Lead with the answer.'
'- Explain trade-offs and recommend one option.'
blank
'# Working principles'
'- Read the code before making changes.'
'- Separate facts from assumptions.'
'- Verify changes with focused checks.'
Editor small bottom label 'Markdown supported'.
Right has white testing pane, header 'Try your instructions', small neutral chip 'Draft', helper text 'Test replies use your current draft.' A compact row 'Example prompt' and text-link 'Reset'.
A realistic sparse test conversation, no avatar cartoon:
small label 'You', light neutral rounded user message 'Should I use a queue or a cron job for sending emails?'
small label 'opentag-slack-2', assistant response dark text directly on white 'Use a queue for user-triggered emails.' followed by 'It gives you retries, per-message status, and better control over bursts.' then 'A cron job is simpler for scheduled digests.' then 'How many emails do you send, and how quickly must they arrive?'
At bottom of test pane a well outlined input composer with hint 'Try another prompt...' and violet circular send arrow; below small 'Test replies do not change your saved Soul.' Use realistic spacing and small line icons.
Main workspace height around 610px, clear panel edges, split line. Bottom sticky save bar aligned to full main content, left 'Unsaved changes' and supporting 'Changes apply from the next turn.', right 'Discard' secondary and violet 'Apply changes'. Keep a crisp working-tool aesthetic, not a chat app landing page. All essential content visible within screen.

```

### C: Guided configuration

```text
Use case: ui-mockup.
Create ONE high-fidelity desktop web application screenshot for OpenTag's agent Soul settings, flat front-on, landscape 16:10 approximately 1600x1000, razor-sharp legible interface, full screen fills the image. This is a serious working application, not a landing page or mood board; no device frame, no perspective, no shadows around screenshot, no decorative illustration, no external annotations.
Existing product design foundation: warm cream #fffcf7 canvas, white surfaces, #171719 primary text, #4c4d5c secondary text, violet #5638d8 primary actions and lavender #f1ebff selection, warm gray #e5e0db borders. Manrope-like modern sans typography, page title 28px, body 14-16px, 8px control radii, restrained flat surfaces. High contrast text, subtle dividers, line icons, generous but purposeful spacing. Do not use nested cards or metric cards or large blank lower half. English UI copy matching the existing application language.
Keep a 224px wide full-height left navigation: top home icon and 'All Agents', agent switcher with circular 'OS' avatar and 'opentag-slack-2', then line-icon rows 'Overview', 'Tasks', 'Soul', 'Memory', 'Skills', 'Connectors', 'Usage'. Soul is selected with a pale lilac row and violet text. A subtle divider separates the sidebar. Bottom user 'hao xiong' with small 'HX' avatar. Main layout uses the full remaining width with disciplined readable max-width and modest margins. Do not add fake usage stats, scores or decorative robots.
Maintain the conceptual truth that Soul is editable natural-language instructions for how the Agent responds and works; saved changes take effect from the next turn. Make example guidance distinct from editable actual draft text. Include explicit meaningful save/discard affordances for the shown unsaved draft. Avoid an anonymous giant textarea with placeholder masquerading as content.

CONCEPT C — GUIDED STRUCTURED COMPOSITION. A distinct approachable configuration interface with a structured writing mode and a compact compiled-text inspector on the right. This is not a stepper wizard and not a template gallery. New proposed interface; keep natural-language instructions as the result.
Header 'Soul', subtitle 'Shape your agent’s role, voice, and working habits.' Right small label 'Unsaved changes'.
Below header a 2-tab understated underline control 'Guided' selected violet, 'Markdown' inactive, right a compact bordered dropdown 'Start from: Engineering'.
Main area below uses a 65/35 split. LEFT is an airy white flat form, with three numbered section labels on white and subtle horizontal separators; do not wrap every section in cards. RIGHT is a warm neutral inspector pane with thin border and title 'Instructions preview', helper 'Compiled from your settings' and monospaced readable natural-language output.
Left section '01  Role', helper 'What should this agent do?', one large labeled textarea containing 'A software engineering assistant who helps ship reliable, maintainable software.' with clear real text, not placeholder.
Section '02  Communication', helper 'Describe how it should sound.', short editable multiline field containing 'Practical, precise, and candid. Lead with the answer and keep replies concise.' Below field a quiet line 'Examples: concise, thoughtful, direct.' Do not use arbitrary numerical sliders or personality scores.
Section '03  Working principles', helper 'Add specific behaviors the agent should follow.', three flat editable rule rows, each with simple drag handle, text and remove x:
'Read the relevant code before making changes.'
'Explain trade-offs and recommend one option.'
'Run focused checks before calling work complete.'
Below small plus-button 'Add a principle'.
Right inspector contains compact black/gray monospaced text with readable wrapping and soft line spacing:
'# Role'
'A software engineering assistant who helps ship reliable, maintainable software.'
'# Communication'
'Practical, precise, and candid.'
'Lead with the answer and keep replies concise.'
'# Working principles'
'- Read the relevant code before making changes.'
'- Explain trade-offs and recommend one option.'
'- Run focused checks before calling work complete.'
Right pane below compiled text has subtle divider and small caption 'Saved as one instruction document.' No AI magic or scores.
Bottom sticky full main save bar separated by hairline. Left 'Unsaved changes', below 'Changes apply from the next turn.' Right ghost 'Discard' then violet 'Apply changes'. Use warm editorial restraint and clear hierarchy. All fields and save controls visible on laptop. Three numbered blocks are the central visual structure; this is clearly different from a single document editor.

```

