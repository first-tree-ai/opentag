---
title: "openTag design guide"
description: "Shared brand and visual rules, website product-preview references, and the boundary between website tooling and the openTag app implementation."
soft_links:
  - /product/trademarks.md
---

# openTag design guide

This guide records openTag's shared visual direction and the marketing website's
product-preview reference. Website-specific sections describe the separate
`first-tree-ai/opentag-site` repository; source links below point there.

The openTag app implements this visual direction through its existing Kumo/Base UI
adapter. The [Web UI contract](web-ui-contract.md) owns application semantics,
composition, accessibility, and acceptance criteria;
[`apps/web/src/ui/KUMO.md`](https://github.com/first-tree-ai/opentag/blob/main/apps/web/src/ui/KUMO.md) documents the
implementation seams. App values live in
[`design.tokens.ts`](https://github.com/first-tree-ai/opentag/blob/main/apps/web/src/ui/design.tokens.ts), with generated
`theme.css` and shared recipes. Website shadcn, routing, localization, and build
choices do not replace those app contracts. Update this guide alongside visual
changes, and use the appropriate repository's code and tokens for exact values.

The app currently supports light mode. The retained violet dark palette is compatibility-only,
not a supported alternative brand theme; a dark release requires its own reviewed specification.
The app strengthens supporting text to `#696c73` so it remains readable on selected grey surfaces.
Orange `#e5502e` is a warning indicator; warning body text uses `#a63f22`, and danger uses
`#b42318`. Selection outlines and progress markers use the slate focus token; links use blue.

Task screens use the existing application typography: the list retains the page-title scale,
while an individual Task title keeps its `h1` semantics and uses 16px medium text with a 24px
line height. Requests, sent replies and execution summaries use 14px regular text with a 21px line
height; authors use 14px medium and timestamps use 12px regular text. Message headings, emphasis
and code retain their content formatting. Operational notices remain at 14px. The Activity
section heading remains accessible without adding a visible label above the conversation.
List task titles and supporting values use 14px regular text, with 14px medium column headings.

Usage keeps the period selector beside the title and lets the concise description use the
available width, wrapping naturally on smaller screens. Daily UTC token totals use bars from
a zero baseline, with no interpolation between days. Totals and charts show recorded usage;
missing task reports remain explicit and do not imply zero actual usage. Agent totals combine
local IM reports with recorded cloud model calls, so the description does not exclude all
internal-session usage. The breakdown uses 16px medium quantities and 12px secondary percentages;
the Tokens column supplies the unit. Cached input is a subset of input and is explained once
below the table rather than repeated as an exclusion on the row.

Overview keeps Usage and dependency status above Schedules, followed by the Agent-scoped Tasks list.
The detail header presents the Agent identity without an availability or activity badge beside the name;
dependency status and lifecycle notices remain in the page content.
Schedules retain their card layout. Tasks preserve server paging and Load more; the full Tasks page
remains available through View all. Long Agent names, handles, and Computer identities wrap within
their available space rather than widening the page.

Soul keeps the page subtitle and Browse templates action. Saved content uses the same white document frame
and typography as editing, with a quiet Edit action below the document on the right. Editing exposes Cancel and
Save changes in that position; no persistent edit hint or prominent header action is added. Success feedback
briefly appears beside these actions, with its layout space retained when it disappears.

## Website reference sources

| Source | Responsibility |
| --- | --- |
| [public/tokens.css](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/public/tokens.css) | Semantic colours, typography, spacing, geometry, and motion values |
| [public/ui-kit.css](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/public/ui-kit.css) | Shared preview controls and their interaction states |
| [src/styles.css](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/src/styles.css) | Marketing composition, illustrations, and responsive layouts |
| [src/walkthrough.css](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/src/walkthrough.css) | Styles scoped to the animated product walkthrough |
| [src/components/ui/select.tsx](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/src/components/ui/select.tsx) | Real shadcn/ui and Radix Select component |
| [src/preview-ui.tsx](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/src/preview-ui.tsx) | Shared controls mounted into the preview pages |

The marketing stylesheet contains some legacy hard-coded values; unused palette/outline experiments, removed developer-menu styles, and selectors with no source consumers have been pruned. The active layout is the standard, semantic-palette, split-channel design. Tokens are the contract for new work; this is not a claim that every existing marketing rule has been migrated. Change relevant rules in place rather than adding duplicate override chains or doing an unrelated global cleanup.

The website's local app previews demonstrate visual composition and illustrative
data. The app follows their visual direction while preserving real accounts,
working controls, and the product behavior defined by the Web UI contract.

## Character and identity

Write the product name as **openTag** in headings, prose, UI copy, accessible
names, CLI help, and integration display names, in every language and at the
start of a sentence. Package names, commands, URLs, environment variables, HTTP
headers, stored paths, and public code identifiers retain their established
spelling for compatibility. Existing user-chosen Agent names are not renamed.

openTag feels capable, friendly, and direct. Confident headings, short explanations, and recognisable workflow examples lead the page. A white canvas, quiet neutral cards, teal actions, lavender accents, and occasional cats make technical content approachable.

Use the local openTag lockup in the header and footer. Preserve the mascot's M-shaped head, @ left eye, and < right eye. Prefer complete exported artwork, keep its proportions, and do not reconstruct or recolour official SVGs without an explicit visual requirement. Grain belongs inside illustration surfaces, never over text or brand marks.

Partner and integration logos retain their identity and proportions. Vendor demonstrations keep their own colour systems. Decorative mascots have empty alt text and are hidden from assistive technology; meaningful standalone logos have useful names.

## Colour and interaction roles

| Role | Token | Value / use |
| --- | --- | --- |
| Marketing canvas | `--surface-page` / `--background` | White, `#ffffff` |
| Product-preview canvas | `--surface-page` on the product surface | `#fafafa` |
| Main text | `--text-primary` / `--foreground` | `#25282d` |
| Supporting text | `--text-secondary` | `#6b6e75` |
| Primary action | `--primary` / `--primary-foreground` | `#00cbb4` with cool black `#25282d` text |
| Primary hover | `--primary-hover` | `#00b69f` |
| Small links | `--text-link` | Supporting blue, `#2563e0` |
| Static secondary surface | `--surface-subtle` / `--muted` | Cool neutral `#f4f5f7` |
| Neutral hover | `--surface-hover` | `#f4f5f7` |
| Neutral selection | `--surface-selected` / `--text-selected` | `#eef0f3` with dark text |
| Borders | `--border` | `#e9ebef` |
| Supporting accents | `--supporting` / `--supporting-subtle` / `--supporting-text` / `--supporting-border` | Blue `#2563e0`, pale blue `#edf5ff`, blue text `#2563e0`, border `#c9dffc` |
| Warning and error | `--warning` / `--destructive` | Orange-red `#e5502e`; retain separate semantic roles and descriptive labels/icons |
| Footer surface | `--surface-footer` | Cool gray `#eef0f3` |
| Table / FAQ borders | `--border-table` / `--border-subtle` | `#dce0e6` / `#e5e8ed` |
| Idle control boundary | `--border-strong` | `#8a8e95`; one 1px border shared by inputs, textareas, Select triggers, and the Soul editor, preserving 3:1 boundary contrast |
| Pointer focus / open Select | `--ring` | `#697586`; deepen the existing 1px boundary without a shadow or additional ring |
| Keyboard focus | `--ring` | `#697586`; Keyboard navigation uses one 2px contour at the existing boundary, without a separated outer ring |
| Comparison header | `--comparison-header` | Slack sidebar purple, `#894b94` |
| Featured comparison cell | `--comparison-header-featured` | Slack topbar purple, `#6f3a82` |
| Comparison header text | `--comparison-header-text` | White, `#ffffff` |
| Blog editorial surface | `--blog-surface` | Lavender, `#f1ebff`; independent of the darker table header |
| Company wordmarks | `--trust-ink` | Charcoal `#414147` |

The comparison header repeats the purple family of the hero's Slack demonstration. Primary actions remain green. Supporting blue is used for text links, tags, and feature hints; it does not replace neutral hover, selection, or focus roles. Marketing sections use the white canvas and restrained surfaces rather than the old large coral, yellow, or blue section blocks.

Use complete CSS colours as `var(--primary)`, never `hsl(var(--primary))`. Do not use bright brand green for small text on white. Warning, error, success, and disabled states have separate semantic roles.

Header language and login controls use neutral hover feedback; the brand logo keeps a transparent background. Product navigation and tabs use neutral selected backgrounds and retain them on hover. Do not use green-tinted hover or selection for neutral controls. Slack and Lark demonstrations are deliberate vendor exceptions.

Letter avatars use `--avatar-background` (`#dce1e8`), `--avatar-foreground` (`#344155`), and `--avatar-border` (`#cdd4de`), with enough contrast against white cards.

### Vendor demonstrations

Vendor frame palettes belong to the [website design guide](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/design.md).
Do not recolour vendor logos or demonstrations with the app palette.

## Typography, spacing, and geometry

Use self-hosted Manrope for Latin text, system Chinese fallbacks, and monospace for code. Shared body sizes are 14/16px, labels 12/14px, and section headings 32/42px. Body line-height is 1.5; the heading role is 1.2. The marketing hero uses its responsive `clamp(38px, 4vw, 58px)` composition. Some existing section headings retain artwork-specific sizing.

Use short, concrete headings and explanatory copy. Kicker labels remain hidden in the current marketing direction. Keep English and Chinese information and hierarchy equivalent; allow translated text to wrap without clipping. Chinese headings omit terminal full stops. Homepage copy and metadata live in the single typed `src/i18n.ts` module. The retired original/optimized variants have been consolidated without changing approved visible copy.

The base spacing scale is 4, 8, 12, 16, 20, 24, 32, 40, 48, and 64px. Marketing has these additional composition roles:

| Role | Above 800px | At or below 800px |
| --- | --- | --- |
| Major section spacing, `--space-section` | 96px | 64px |
| Heading-to-content spacing, `--space-section-heading` | 32px | 24px |
| Hero top spacing, `--space-hero-top` | 48px | 24px |
| Closing mascot width | 500px | 300px |
| Closing mascot stage height | 280px | 184px |

The 96/64px section rhythm also governs testimonials; the former 160/112px exception is obsolete. Individual compositions can reserve extra space for a mascot, as the FAQ does.

The marketing container is centred and capped at 1280px; comparison, testimonials, and FAQ use narrower content measures. Feature frames follow their content rather than preserving empty design-canvas space.

Shared controls use a 40px default height, with 32px and 48px variants. Radius roles are 6, 10, 12, and 16px, with full rounding for circles. Standard controls use 10px corners; outer product cards use 16px. Keep existing illustration geometry and documented marketing exceptions intact rather than rounding SVG coordinates to the UI scale.

In the expanded app sidebar, All Agents, the Agent switcher, navigation items, and the Account trigger share an icon column and text alignment. The Account trigger leaves space around its avatar inside the hover surface. Compact layouts keep the avatar centred and preserve touch targets. Repository dialogs align their title, description, filter, and list; the scrolling body leaves room for the filter's focus ring, and the footer follows the content without excess empty space.

## Page composition and artwork

| Section | Approved treatment |
| --- | --- |
| Header and hero | Logo and quiet navigation above a split layout: headline and actions on the left, interactive Slack/Lark channel demonstration on the right. The former cats-working hero scene is not the current hero. |
| Customer proof | “Used by engineers at” with legible charcoal company wordmarks. The caption is centred when stacked above the logos. |
| Value cards | “Your subscription”, “Your machine”, and “Your coworker” cards have centred illustrations and text at every breakpoint. |
| How it works | A centred heading and description introduce four steps: subscription/setup, chat, shared knowledge, and integrations. The active step has a vertical progress track. Preserve the real scene sequence and controls. |
| Supported agents | Three touching, non-overlapping circles form a triangle: Codex above Claude Code and Pi. The wrapped calico rests around the Codex arc. No visible agent-name labels. Five smaller grayscale circles appear below, with a shared “Coming soon” caption. |
| Connect your stack | Recognisable tool marks inside rotating gear silhouettes; marks and labels stay upright. The smaller lounging cat sits in the lower space beside Jira and beneath Figma. |
| Memory | File-based, git-backed team memory copy beside a file window and box cat. Keep all text readable and reserve separate room for the cat on phones. |
| Comparison | Centred heading, dark Slack-purple table header with white labels, and a darker openTag header cell. The blue crouching cat rests on the left table edge without covering the heading. |
| Testimonials | Quiet neutral cards with quote and attribution, three columns on wide screens, two on tablets, one on phones. The existing corner mascot is hidden at narrow widths. |
| FAQ | The heading sits alongside the original donut cat above the list’s top rule, using the comparison section’s heading-to-table rhythm. It is centred on desktop; on phones the heading reserves space to its left for the cat. The list container is centred and question text remains left-aligned. Native details/summary controls expand the answers. |
| Closing CTA | Centred “Just tag it” message and action, followed by the smaller outline cat with 32px clearance below the CTA. |

### Agent and mascot geometry

The marketing Agent-circle dimensions and placement belong to the [website design guide](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/design.md). They do not size avatars in the app. Logos retain accessible names even when visible labels are removed.

The Codex mascot is [lounge-cat-arc-v1.webp](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/public/assets/agent-scene/lounge-cat-arc-v1.webp), the 640 × 427px wrapped calico. Its width and reserved clearance use `--agent-lounge-width` (1.35 times the circle diameter) and `--agent-cat-clearance` (0.6 times the diameter). Preserve its optical offset and 0.37-diameter overlap so the artwork follows the circle.

The FAQ uses [cat-complete-v3.svg](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/public/assets/faq-scene/cat-complete-v3.svg), at 128px desktop and 96px at or below 800px. Its offset compensates for transparent padding so visible artwork rests on the rule. The comparison uses the blue [lounge-cat-v8.svg](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/public/assets/agent-scene/lounge-cat-v8.svg), at 176px wide; it is hidden at or below 1000px to preserve heading clearance.

Retain all four SVG artwork variants, including alternatives not currently displayed: `agent-scene/lounge-cat-v7.svg`, `agent-scene/lounge-cat-v8.svg`, `comparison-scene/lounge-cat-v5.svg`, and `comparison-scene/lounge-cat-v6.svg`. Also retain the wrapped WebP and previous `comparison-scene/arched-cat-v4.svg`. These are intentional artwork-library assets, not unused files to remove during cleanup.

## Responsive behaviour

- The hero stacks at or below 1050px. Its channel sidebar becomes a horizontally scrollable tab row at or below 700px. The mobile grid uses `minmax(0, 1fr)` so tabs cannot widen and clip the conversation; narrow metric cards must also shrink.
- Agent compatibility and feature sections become single-column at or below 800px. Keep the agent circles centred with clear space for the cat. Value-card artwork and copy remain centred when cards stack.
- Testimonials use two columns from 601–1000px and one below 601px. Phone cards follow their content instead of imposing excess empty height.
- Below 601px, the memory window uses the available width, its toolbar and code can wrap, and the box cat has reserved space below it.
- The comparison table may scroll horizontally inside its own container. Preserve its sticky capability column and keep the page itself free of horizontal overflow.
- Header brand, login, and menu must fit at 320px. Preserve readable wrapping, usable controls, artwork proportions, and clear separation between cats and copy.

Review desktop, tablet, and phone sizes, including 320, 390, 768, 1024, and 1440px where relevant. Check both languages when copy or layout changes affect them.

## Interaction, navigation, and accessibility

Use semantic headings, native links and buttons, and explicit button types. Every control needs an accessible name. Associate labels with actual inputs or rendered Select triggers; illustration captions are not form labels. Expose selection using appropriate ARIA state and provide visible keyboard focus. Do not rely on colour alone for status.

The header logo returns to `#top`. Login goes to `https://app.opentag.build/login`; primary signup actions go to `https://app.opentag.build/`. The existing production-only session script may update login to “Open app” for an authenticated visitor. Local previews must not query production account state.

The marketing site does not link into the dummy app or design-system pages. Keep `/agents-preview.html`, `/product-preview.html`, and `/design-system.html` available at direct URLs for review, with `noindex, follow` metadata so they do not appear as public product pages in search. Their local actions and zero-value statistics are illustrative, not backend operations.

The hero cycles channels every eight seconds; manual selection resets the cycle and the selected scene. Preserve its keyboard tab controls. The walkthrough's progress drives automatic advancement, selecting a step restarts its scene, and offscreen playback is paused. Respect `prefers-reduced-motion` in animated demos and artwork; show useful completed states where appropriate.

## Blog

The header links to `/blog` in English and `/zh/blog` in Chinese. Both the index and introductory post have English and Simplified Chinese versions. Language switches stay on the equivalent page. The index and `/blog/introducing-opentag` are pre-rendered as static HTML with directory aliases for saved trailing-slash URLs, with their own canonical URLs, social metadata, structured data, and sitemap entries. Canonical and internal URLs omit trailing slashes to match the hosting configuration. They reuse the marketing header and footer; header section links return to the homepage.

Use the white canvas, Manrope, and a restrained lavender index card with existing mascot artwork. Article pages use the `--blog-reading-width` (720px) measure, `--blog-leading` (1.8) for long-form body copy, and existing type/spacing tokens. `--blog-art-width` (280px) caps index artwork and halves on mobile. Post titles use plain text without an inline logo. The index opens with “Blog” and no introductory tagline. Use one clear title, descriptive subheadings, selective bold text, inline code for worker names, and a lavender callout for an example prompt. Do not invent publication dates or authors. Keep article prose left-aligned inside the centred reading column.

## Website preview Select component

Use the real [shadcn/ui New York Select](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/src/components/ui/select.tsx), built on Radix, in the product preview and component gallery. Keep React/TypeScript and plain CSS; Tailwind is not installed. Reuse this component rather than introducing a native select or visual imitation.

The [vendored registry source](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/docs/vendor/shadcn-select.registry.json) and [MIT licence](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/docs/vendor/shadcn-LICENSE.txt) record its provenance. Preserve the forwarded refs, Radix Portal, keyboard/typeahead behaviour, focus return, disabled-option skipping, scrolling, and collision handling. Installed versions are specified in [package.json](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/package.json) and pinned in [pnpm-lock.yaml](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/pnpm-lock.yaml).

| Select role | Mapping |
| --- | --- |
| Trigger and popup | `--card`, `--popover`, `--foreground`, `--input`, `--border` |
| Highlight and selection | `--surface-selected`, `--text-selected`; dark text and checkmark |
| Focus | `--ring` |
| Disabled and error | `--disabled-opacity`, `--muted`, `--destructive` |
| Shape and density | Control-height, radius, and spacing tokens |
| Elevation | `--shadow-panel` |

Set `aria-invalid` and connect explanatory help with `aria-describedby` for errors. Root `disabled` disables the whole control. Empty lists explain that no options are available rather than offering a fake selectable item. Keep an accessible label and preserve selected styling on hover. `--accent` is a status/badge role, not a green navigation or Select highlight.

[src/preview-ui.tsx](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/src/preview-ui.tsx) demonstrates default, unselected, disabled, error, empty, and 40-option scrolling states. The publisher bundles this entry as `/js/preview-ui.js`; production preview HTML must not load raw TSX.

## Icons and licensing

Shared product controls use Lucide. Reuse `ChevronDown` for Select and agent switchers, normally at 16px with `--space-4`; the general `--icon-size` role is 18px. Use `currentColor`, consistent stroke weight, and semantic text colours. Decorative icons use `aria-hidden`; icon-only actions still need accessible names.

Lucide is available under ISC, with some inherited Feather portions under MIT. Preserve both applicable notices. A visible attribution is not required. Brand marks, mascot artwork, vendor logos, and existing marketing/sidebar assets are separate; do not silently replace them with generic control icons. Keep the shadcn MIT notice as well.

## Website development and validation

These commands apply to the website repository. Use Node 24 and the pnpm version
pinned by its `package.json`; run them from that repository root. For app commands,
see the [openTag development guide](https://github.com/first-tree-ai/opentag/blob/main/DEVELOPMENT.md).

```sh
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1
pnpm check
pnpm build
pnpm preview --host 127.0.0.1
```

Use the Vite workflow for previews; the obsolete machine-specific preview helper has been removed.

For a design change, check affected components at 390px and 1440px, extend to intermediate widths when relevant, and verify keyboard focus, hover/selection, disabled behaviour, readable labels, logo proportions, reduced motion, and no unintended overflow. Inspect rendered screenshots, not only source values. Preserve approved composition and product terminology.

[tools/verify-select.cjs](https://github.com/first-tree-ai/opentag-site/blob/4f63d20383045861ca5cd93be8196829f0974e5f/tools/verify-select.cjs) provides focused checks for the built product and component previews, including pointer and keyboard selection, focus return, disabled options/root, empty/error states, long-list scrolling, and page errors. With a local preview and Playwright available:

```sh
PREVIEW_URL=http://127.0.0.1:4173 node tools/verify-select.cjs
```

`PLAYWRIGHT_MODULE` and `CHROME_PATH` can select an installed runtime. Screenshots go into ignored `.shots/`.

The initial JavaScript budget is 300,000 bytes, including eagerly preloaded modules. The walkthrough logo sprite lives in `public/assets/walkthrough-symbols.svg` and is fetched by the deferred scenes that use it; do not embed the full sprite in the initial JavaScript. Reuse the active copy module rather than bundling an unused context default. The hero performance checks describe the current channel demonstration. Run the full test suite before pushing; passing lint and a build alone does not confirm CI passes. The preview Select bundle is separate from the homepage.
