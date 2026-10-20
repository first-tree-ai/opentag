# openTag design guide

This is the single design guide for this repository's marketing website and local product previews. It records the approved brand and UX redesign. Update it alongside implemented design changes; use the code and tokens below for exact values.

## Scope and source of truth

| Source | Responsibility |
| --- | --- |
| [public/tokens.css](public/tokens.css) | Semantic colours, typography, spacing, geometry, and motion values |
| [public/ui-kit.css](public/ui-kit.css) | Shared preview controls and their interaction states |
| [src/styles.css](src/styles.css) | Marketing composition, illustrations, and responsive layouts |
| [src/walkthrough.css](src/walkthrough.css) | Styles scoped to the animated product walkthrough |
| [src/components/ui/select.tsx](src/components/ui/select.tsx) | Real shadcn/ui and Radix Select component |
| [src/preview-ui.tsx](src/preview-ui.tsx) | Shared controls mounted into the preview pages |

The marketing stylesheet contains some legacy hard-coded values; unused palette/outline experiments, removed developer-menu styles, and selectors with no source consumers have been pruned. The active layout is the standard, semantic-palette, split-channel design. Tokens are the contract for new work; this is not a claim that every existing marketing rule has been migrated. Change relevant rules in place rather than adding duplicate override chains or doing an unrelated global cleanup.

The live openTag app is maintained separately. The local app previews demonstrate proposed controls and illustrative data; they do not establish or modify the production app's theme, accounts, or functionality.

## Character and identity

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
| Keyboard focus | `--ring` | `#697586`; shared controls use a 2px outline with 3px offset |
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

| Surface | Treatment |
| --- | --- |
| Slack | Purple top bar `#6f3a82`, search `#8d619c`, sidebar `#894b94`, lilac selection `#caa3d2`, selected text `#44005c`; fine monochrome grain inside the frame |
| Lark | Sidebar `#f7f7fa`, selection `#e2edfe`, avatar `#d4d9e2`, selected avatar `#c9daf2` |

Do not recolour vendor logos or demonstrations with the primary brand palette.

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

Use `--agent-circle-size`: 144px above 1000px and 128px at or below 1000px. The lower main circles sit `sqrt(3)/2` diameters below Codex. Upcoming-agent circles are 0.4 times the main diameter; preserve their derived tangent placement so circles touch without overlapping. Logos retain accessible names even though visible labels are removed.

The Codex mascot is [lounge-cat-arc-v1.webp](public/assets/agent-scene/lounge-cat-arc-v1.webp), the 640 × 427px wrapped calico. Its width and reserved clearance use `--agent-lounge-width` (1.35 times the circle diameter) and `--agent-cat-clearance` (0.6 times the diameter). Preserve its optical offset and 0.37-diameter overlap so the artwork follows the circle.

The FAQ uses [cat-complete-v3.svg](public/assets/faq-scene/cat-complete-v3.svg), at 128px desktop and 96px at or below 800px. Its offset compensates for transparent padding so visible artwork rests on the rule. The comparison uses the blue [lounge-cat-v8.svg](public/assets/agent-scene/lounge-cat-v8.svg), at 176px wide; it is hidden at or below 1000px to preserve heading clearance.

Retain all four new SVG variants from the October 19 design snapshot, including alternatives not currently displayed: `agent-scene/lounge-cat-v7.svg`, `agent-scene/lounge-cat-v8.svg`, `comparison-scene/lounge-cat-v5.svg`, and `comparison-scene/lounge-cat-v6.svg`. Also retain the wrapped WebP and previous `comparison-scene/arched-cat-v4.svg`. These are intentional artwork-library assets, not unused files to remove during cleanup.

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

## Shared Select component

Use the real [shadcn/ui New York Select](src/components/ui/select.tsx), built on Radix, in the product preview and component gallery. Keep React/TypeScript and plain CSS; Tailwind is not installed. Reuse this component rather than introducing a native select or visual imitation.

The [vendored registry source](docs/vendor/shadcn-select.registry.json) and [MIT licence](docs/vendor/shadcn-LICENSE.txt) record its provenance. Preserve the forwarded refs, Radix Portal, keyboard/typeahead behaviour, focus return, disabled-option skipping, scrolling, and collision handling. Installed versions are specified in [package.json](package.json) and pinned in [pnpm-lock.yaml](pnpm-lock.yaml).

| Select role | Mapping |
| --- | --- |
| Trigger and popup | `--card`, `--popover`, `--foreground`, `--input`, `--border` |
| Highlight and selection | `--surface-selected`, `--text-selected`; dark text and checkmark |
| Focus | `--ring` |
| Disabled and error | `--disabled-opacity`, `--muted`, `--destructive` |
| Shape and density | Control-height, radius, and spacing tokens |
| Elevation | `--shadow-panel` |

Set `aria-invalid` and connect explanatory help with `aria-describedby` for errors. Root `disabled` disables the whole control. Empty lists explain that no options are available rather than offering a fake selectable item. Keep an accessible label and preserve selected styling on hover. `--accent` is a status/badge role, not a green navigation or Select highlight.

[src/preview-ui.tsx](src/preview-ui.tsx) demonstrates default, unselected, disabled, error, empty, and 40-option scrolling states. The publisher bundles this entry as `/js/preview-ui.js`; production preview HTML must not load raw TSX.

## Icons and licensing

Shared product controls use Lucide. Reuse `ChevronDown` for Select and agent switchers, normally at 16px with `--space-4`; the general `--icon-size` role is 18px. Use `currentColor`, consistent stroke weight, and semantic text colours. Decorative icons use `aria-hidden`; icon-only actions still need accessible names.

Lucide is available under ISC, with some inherited Feather portions under MIT. Preserve both applicable notices. A visible attribution is not required. Brand marks, mascot artwork, vendor logos, and existing marketing/sidebar assets are separate; do not silently replace them with generic control icons. Keep the shadcn MIT notice as well.

## Development and validation

Use Node 24 and the pnpm version pinned by `package.json`. Source is tracked at the repository root.

```sh
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1
pnpm check
pnpm build
pnpm preview --host 127.0.0.1
```

Use the Vite workflow for previews; the obsolete machine-specific preview helper has been removed.

For a design change, check affected components at 390px and 1440px, extend to intermediate widths when relevant, and verify keyboard focus, hover/selection, disabled behaviour, readable labels, logo proportions, reduced motion, and no unintended overflow. Inspect rendered screenshots, not only source values. Preserve approved composition and product terminology.

[tools/verify-select.cjs](tools/verify-select.cjs) provides focused checks for the built product and component previews, including pointer and keyboard selection, focus return, disabled options/root, empty/error states, long-list scrolling, and page errors. With a local preview and Playwright available:

```sh
PREVIEW_URL=http://127.0.0.1:4173 node tools/verify-select.cjs
```

`PLAYWRIGHT_MODULE` and `CHROME_PATH` can select an installed runtime. Screenshots go into ignored `.shots/`.

The initial JavaScript budget is 300,000 bytes, including eagerly preloaded modules. The walkthrough logo sprite lives in `public/assets/walkthrough-symbols.svg` and is fetched by the deferred scenes that use it; do not embed the full sprite in the initial JavaScript. Reuse the active copy module rather than bundling an unused context default. The hero performance checks describe the current channel demonstration. Run the full test suite before pushing; passing lint and a build alone does not confirm CI passes. The preview Select bundle is separate from the homepage.
