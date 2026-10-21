# Soul template journey

Four visual states of one Soul page and one template chooser dialog. Generated with the built-in image generation tool, using the refined document editor concept as a reference. These are proposed desktop UI mockups, not implemented screens or test evidence.

## Core flow

1. [Entry](01-entry.png): empty editor with a short placeholder and a Browse templates entry. No examples masquerade as saved content.
2. [Browse and decide](02-browse-and-decide.png): a modal contains task-oriented template summaries, intended use, working preferences, and read-only full instructions. Selecting a list row changes the preview only. Use Engineering inserts the chosen text.
3. [Template draft](03-template-draft.png): the dialog closes, the text becomes editable, and Undo restores the previous draft immediately after insertion. Applying a template is distinct from saving it. The shown draft has not yet been further edited.
4. [Saved](04-saved.png): successful persistence removes dirty actions and confirms next-turn application. The editor remains editable.

There is no four-step wizard and no required template selection: users can write instructions directly on the initial page.

## Interaction details for implementation

- Cancel and close dismiss the chooser without changing the draft.
- The template summaries help users choose by work scope, rather than by title alone.
- Intended use and working preferences describe the template's instructions; they do not guarantee model behavior or show a tested response.
- When a draft already exists, the chooser must explain replacement before insertion, and preserve the existing preset Undo behavior.
- The shown Undo is relevant immediately after insertion; existing behavior only exposes it while the draft still matches the inserted preset.
- Apply changes persists the draft. It must preserve user input on error and prevent duplicate submissions while busy.
- The success message describes saved instructions taking effect from the next turn.
- Template contents and summaries here are illustrative design copy. Implementation must use the actual presets as the source of truth.
- Responsive layout, keyboard modal behavior, accessibility, errors, and localization remain implementation acceptance work.

## Complete generation prompts

### 01: Entry

```text
Use case: ui-mockup.
Edit target: the attached refined OpenTag Soul desktop screenshot. This image is one state in a coherent four-screen user journey. Preserve the exact app identity, left navigation structure, typography, warm cream canvas, white textarea, flat violet primary buttons, gentle neutral borders, subtle lavender current navigation, alignment and restrained visual language. Flat front-on app screenshot, full landscape canvas roughly 1600x1000 (16:10). No browser chrome, device frame, perspective, decorative artwork, step numbers, annotations or presentation board. Generate ONE full-size screen only. Keep text crisp and readable in English.
Preserve navigation labels: All Agents; switcher opentag-slack-2; Overview, Tasks, Soul selected, Memory, Skills, Connectors, Usage; bottom account hao xiong.
All regular page states use the same form position and dimensions as reference: title Soul and subtitle 'Define how this agent responds and works.'; one field label Instructions; upper-right secondary button NOW RENAMED to 'Browse templates' (no dropdown chevron; it opens a dialog); one generously padded plain editable textarea, aligned action row immediately below, no full-width sticky footer. No Edit/Preview switch, no character counts, no extra panels, no duplicate save status. Regular textarea text is plain same-size sans text, no rendered Markdown styling.

Use this EXACT engineering instruction text whenever showing populated instructions:
You are a software engineering assistant.
Be practical, precise, and candid.

Communication
- Lead with the answer. Keep replies concise.
- Explain trade-offs and recommend one option.

Working principles
- Read the relevant code before making changes.
- Verify assumptions and run focused checks.
- Ask when essential information is missing.

Preserve the subtle control radii and calm hierarchy of the reference. Each screen should feel like the same working product at the same viewport size.

STATE 1: FIRST VISIT, EMPTY INSTRUCTIONS.
Keep page header and Browse templates secondary button. The textarea contains ONLY a short muted placeholder near its top left: 'Describe the agent’s role, communication style, and working principles.' It must clearly look like a placeholder, with no sample role, no bullets and no example content masquerading as saved instructions. Below textarea show quiet small neutral helper 'No custom instructions yet.' There are NO unsaved indicators, NO Discard or Apply changes controls in this clean empty state, NO success alert and NO extra onboarding cards. The visible Browse templates button is the clear way to explore available starting points; the user can also type freely. Keep otherwise exact reference spacing and shell.

```

### 02: Browse and decide

```text
Use case: ui-mockup.
Edit target: the attached refined OpenTag Soul desktop screenshot. This image is one state in a coherent four-screen user journey. Preserve the exact app identity, left navigation structure, typography, warm cream canvas, white textarea, flat violet primary buttons, gentle neutral borders, subtle lavender current navigation, alignment and restrained visual language. Flat front-on app screenshot, full landscape canvas roughly 1600x1000 (16:10). No browser chrome, device frame, perspective, decorative artwork, step numbers, annotations or presentation board. Generate ONE full-size screen only. Keep text crisp and readable in English.
Preserve navigation labels: All Agents; switcher opentag-slack-2; Overview, Tasks, Soul selected, Memory, Skills, Connectors, Usage; bottom account hao xiong.
All regular page states use the same form position and dimensions as reference: title Soul and subtitle 'Define how this agent responds and works.'; one field label Instructions; upper-right secondary button NOW RENAMED to 'Browse templates' (no dropdown chevron; it opens a dialog); one generously padded plain editable textarea, aligned action row immediately below, no full-width sticky footer. No Edit/Preview switch, no character counts, no extra panels, no duplicate save status. Regular textarea text is plain same-size sans text, no rendered Markdown styling.

Use this EXACT engineering instruction text whenever showing populated instructions:
You are a software engineering assistant.
Be practical, precise, and candid.

Communication
- Lead with the answer. Keep replies concise.
- Explain trade-offs and recommend one option.

Working principles
- Read the relevant code before making changes.
- Verify assumptions and run focused checks.
- Ask when essential information is missing.

Preserve the subtle control radii and calm hierarchy of the reference. Each screen should feel like the same working product at the same viewport size.

STATE 2: BROWSE AND DECIDE BEFORE CHANGING ANYTHING.
A large elegant centered modal overlays the EMPTY Soul page. Background page and sidebar remain visible under a subtle translucent dark neutral scrim, never deeply black. Background textarea remains empty, with no unsaved status. The modal is the central focus, about 1020px wide x 730px tall at a 1600x1000 viewport, white, 16px corners and modest shadow. High legibility, no tiny body text.
Modal header at top: title 'Choose a starting point' (24px), subtitle 'Browse a template before adding it to your draft.' and close X top right.
Below header the body has a narrow 235px left navigation and one main preview pane separated by a hairline.
Left column consists of FIVE tidy template rows, each name semibold followed by one muted descriptor. Engineering selected pale lavender with dark violet title. EXACT rows:
'Engineering' / 'Build, debug, and review code'
'Design' / 'Shape interfaces and experiences'
'Product' / 'Clarify needs and priorities'
'Growth' / 'Plan experiments and campaigns'
'Operations' / 'Coordinate workflows and delivery'
No additional category headings, no search, no arbitrary recommendation badge, no cards nested in cards.
Right preview pane about 700px wide with 28px padding:
Title 'Engineering' (22px).
One clear fit description: 'For implementing features, debugging issues, and reviewing code.'
Then heading 'How it works' (14px semibold), followed by three compact lines with simple neutral bullets:
'Reads relevant code before proposing changes'
'Explains trade-offs and recommends a path'
'Checks the result before calling work complete'
Then heading 'Full instructions'. Under that show a readable scrollable neutral-white text area containing the EXACT engineering text supplied above; at this viewport the content should be readable with a slim right scrollbar. This is a read-only preview, no cursor, no input toolbar. Behavioral summaries are illustrative template guidance, not execution results.
Modal bottom footer separated by a single hairline. Left helper 'You can edit these instructions before saving.' Right secondary 'Cancel' and violet primary 'Use Engineering'. The main page is UNCHANGED while browsing. The only primary action is in the modal. No Apply changes action in this modal. No chat test or fake scores.

```

### 03: Template draft

```text
Use case: ui-mockup.
Edit target: the attached refined OpenTag Soul desktop screenshot. This image is one state in a coherent four-screen user journey. Preserve the exact app identity, left navigation structure, typography, warm cream canvas, white textarea, flat violet primary buttons, gentle neutral borders, subtle lavender current navigation, alignment and restrained visual language. Flat front-on app screenshot, full landscape canvas roughly 1600x1000 (16:10). No browser chrome, device frame, perspective, decorative artwork, step numbers, annotations or presentation board. Generate ONE full-size screen only. Keep text crisp and readable in English.
Preserve navigation labels: All Agents; switcher opentag-slack-2; Overview, Tasks, Soul selected, Memory, Skills, Connectors, Usage; bottom account hao xiong.
All regular page states use the same form position and dimensions as reference: title Soul and subtitle 'Define how this agent responds and works.'; one field label Instructions; upper-right secondary button NOW RENAMED to 'Browse templates' (no dropdown chevron; it opens a dialog); one generously padded plain editable textarea, aligned action row immediately below, no full-width sticky footer. No Edit/Preview switch, no character counts, no extra panels, no duplicate save status. Regular textarea text is plain same-size sans text, no rendered Markdown styling.

Use this EXACT engineering instruction text whenever showing populated instructions:
You are a software engineering assistant.
Be practical, precise, and candid.

Communication
- Lead with the answer. Keep replies concise.
- Explain trade-offs and recommend one option.

Working principles
- Read the relevant code before making changes.
- Verify assumptions and run focused checks.
- Ask when essential information is missing.

Preserve the subtle control radii and calm hierarchy of the reference. Each screen should feel like the same working product at the same viewport size.

STATE 3: THE USER HAS CLICKED USE ENGINEERING; TEMPLATE IS A DRAFT.
Modal is closed. Preserve exact page structure and reference textarea size. Populate the plain textarea with the exact engineering instruction text supplied above, not placeholder text. Above the textarea, BETWEEN the Instructions/Browse templates row and the editor border, insert just ONE compact transient feedback line: 'Template added.' followed by violet text action 'Undo'. This is a quiet inline text row, no colored banner or large card. It indicates the reversible insertion, not a saved result. Leave enough room for the populated editor; avoid changing the form's alignment.
Below editor, left shows one neutral small dot and 'Unsaved changes' with smaller second line 'Changes apply from the next turn.' Right shows secondary 'Discard' and primary violet 'Apply changes'. The textarea remains freely editable. Do not show Engineering as an active binding dropdown: Browse templates remains the only template button. Do not show green check or Saved label. User may edit this draft before applying; the screenshot depicts the immediately inserted draft before further typing.

```

### 04: Saved

```text
Use case: ui-mockup.
Edit target: the attached refined OpenTag Soul desktop screenshot. This image is one state in a coherent four-screen user journey. Preserve the exact app identity, left navigation structure, typography, warm cream canvas, white textarea, flat violet primary buttons, gentle neutral borders, subtle lavender current navigation, alignment and restrained visual language. Flat front-on app screenshot, full landscape canvas roughly 1600x1000 (16:10). No browser chrome, device frame, perspective, decorative artwork, step numbers, annotations or presentation board. Generate ONE full-size screen only. Keep text crisp and readable in English.
Preserve navigation labels: All Agents; switcher opentag-slack-2; Overview, Tasks, Soul selected, Memory, Skills, Connectors, Usage; bottom account hao xiong.
All regular page states use the same form position and dimensions as reference: title Soul and subtitle 'Define how this agent responds and works.'; one field label Instructions; upper-right secondary button NOW RENAMED to 'Browse templates' (no dropdown chevron; it opens a dialog); one generously padded plain editable textarea, aligned action row immediately below, no full-width sticky footer. No Edit/Preview switch, no character counts, no extra panels, no duplicate save status. Regular textarea text is plain same-size sans text, no rendered Markdown styling.

Use this EXACT engineering instruction text whenever showing populated instructions:
You are a software engineering assistant.
Be practical, precise, and candid.

Communication
- Lead with the answer. Keep replies concise.
- Explain trade-offs and recommend one option.

Working principles
- Read the relevant code before making changes.
- Verify assumptions and run focused checks.
- Ask when essential information is missing.

Preserve the subtle control radii and calm hierarchy of the reference. Each screen should feel like the same working product at the same viewport size.

STATE 4: SAVE SUCCEEDED.
The modal is closed. Preserve exact regular page layout, header, Browse templates button and editor geometry. Populate editor with the EXACT same engineering text supplied above, still dark and freely editable. Remove the temporary 'Template added / Undo' row. Remove all Unsaved changes labels and discard/apply actions because the saved document is clean.
Immediately beneath the editor show one subtle inline success result aligned left: small green outlined check-circle, text 'Changes saved' in dark ink, and smaller secondary sentence beneath 'Applies from the next turn.' Use a gentle real success green only for the small icon; not violet, not a full green banner. No success toast far from the editor, no duplicate top status, no claim that an agent has already executed anything. No Continue, no Done, no new workflow; user remains on the editable Soul page.

```

### Precision correction to screen 02

```text
Edit target: attached OpenTag template chooser screenshot. Make ONLY two small precision corrections; preserve EVERYTHING else exactly, including all modal geometry, copy, template rows, current Engineering preview, white/cream/violet visual style, font, sidebar, background dimming, and full screenshot dimensions.
1. Behind the modal, at lower right of background Soul page, remove the visible violet 'Apply changes' button completely and restore the continuous dimmed cream background. This is the first-visit empty page with no unsaved draft; there must be NO background save button or draft action. Keep the modal footer's 'Use Engineering' button unchanged.
2. In the modal's Full instructions read-only preview box, remove the tiny native textarea diagonal resize grip at its bottom-right. Keep the preview text and vertical scrollbar unchanged. This preview is a document reader, not an editable field.
No new elements, no other text changes, no crop, no decorative effects. Output one complete flat screenshot.
```

