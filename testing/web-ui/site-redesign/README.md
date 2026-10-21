# Website-aligned app redesign

**Current decision:** match the actual site app preview pages as closely as
possible. The subsequent approved avatar refresh replaces all six cats while
preserving their existing filenames; see [avatar validation](avatar-concepts/IMPLEMENTATION.md).
The [implementation plan](PLAN.md) supersedes the generated concepts and the
earlier implementation outline below. The images remain exploration history,
not visual acceptance targets.

Design exploration and implementation acceptance plan, grounded in the
[Web UI contract](../../../docs/system/web/web-ui-contract.md).
The theme, shared controls, responsive shell and representative screens are now
implemented. [Design QA](design-qa.md) records the tested result and its limits.
The exploration sections below preserve the earlier proposal.

The [README artwork validation](readme/README.md) records the refreshed logo and
website walkthrough GIF used by both root README languages.

## Reference and scope

- Website reference: [opentag-site PR 14](https://github.com/first-tree-ai/opentag-site/pull/14),
  revision `ba05d490dde707febdc1cd3b4c62e813d648ff43`.
- The current design authority is the website's `codex/design-token-refresh`
  branch at `4f63d20383045861ca5cd93be8196829f0974e5f`, inspected in its clean local
  worktree. It supersedes the PR's original token palette.
- The [design guide](../../../docs/system/web/design.md) carries the refreshed branch's visual guidance
  in Context Tree format. Its website source links explicitly target the website repository.
  Website-specific development and component instructions are reference material;
  they do not replace OpenTag's repository instructions or require adopting shadcn.
- The previous app guide is preserved as
  [app-design-before.md](references/app-design-before.md) for comparison. Its relative
  links originally resolved from the repository root. It is historical evidence.
- The website's hidden `/agents-preview.html`, `/product-preview.html`,
  `/product-preview.html#Soul`, and `/design-system.html` were inspected in a local
  preview of the pinned source.
- Screenshots: [website](references/website.png),
  [styleguide](references/styleguide.png), [agent roster](references/agents-preview.png),
  [agent overview](references/product-overview.png), [Soul editor](references/soul-preview.png).
- Refreshed branch evidence: [styleguide](references/refresh-styleguide.png),
  [controls and statuses](references/refresh-controls.png),
  [product overview](references/refresh-product-overview.png), and an exact
  [token snapshot](references/refresh-tokens.css).
- Preserve all current cat avatar assets in `apps/web/public/bot-avatars/v1/`.
  The website's replacement avatar set is outside this redesign.
- Image concepts are illustrative UI, with mock data. They do not change routes,
  copy, API behavior, or production state.

## Visual direction

Use the website's light neutral product canvas, teal actions, blue links,
cool charcoal text, Manrope, quiet borders, and neutral navigation selection.
Keep product density and the existing
72px workspace rail / 240px Agent sidebar. The website preview already follows
these navigation dimensions, so a new navigation model is unnecessary.

| Role | Current app | Refreshed website alignment |
| --- | --- | --- |
| Canvas | Warm cream `#fffcf7` | Product grey `#fafafa` |
| Surface | White | White |
| Primary text | `#171719` | Cool charcoal `#25282d` |
| Supporting text | `#4c4d5c` | `#6b6e75` |
| Primary action | Violet `#5638d8`, white label | Teal `#00cbb4`, charcoal `#25282d` label |
| Links | Violet | Supporting blue `#2563e0` |
| Supporting hint | No equivalent dedicated role | Blue `#2563e0` on `#edf5ff`, border `#c9dffc` |
| Navigation selection | Lilac `#f1ebff` | Neutral `#eef0f3`, dark label/icon |
| Hover | Warm neutral `#f5f1eb` | Neutral `#f4f5f7` |
| Secondary surface | Warm recessed `#f4f0e9` | Cool neutral `#f4f5f7` |
| Structural border | `#e5e0db` | `#e9ebef` |
| Control / surface radius | 8px / 12px | 10px / 16px |
| Body / control size | Manrope, 14px / 40px | Retain; use 16px where reading benefits |

The branch also changes warning and destructive colours to `#e5502e`, retaining
separate semantic tokens and explicit labels. Success remains `#007f70`; keyboard
focus remains `#697586`. Use orange-red for warning indicators and charcoal for
small warning labels until contrast has been checked. Idle is neutral, while
Working uses informational blue.

The refreshed Slack/comparison purples and marketing mascot placements are
website-specific. They do not become app navigation colours or replace existing
Agent portraits. Supporting blue is purposeful: apply it to real links and
informational states, without inventing decorative tags to show off the palette.

Do not carry the marketing site's large headings or section spacing into routine
app pages. Use lavender only where it has a specific role, not as navigation or
primary action colour. Keep readiness, task activity, warning, and error semantics
independent of brand colours. Integration logos retain their own colours.

The fine website border is a structural separator, not sufficient by itself to
identify every input. Preserve accessible control boundaries and verify contrast
before settling final control tokens. Separate primary-button foreground from
inverse text: a global change from white inverse text to dark text would damage
danger buttons and other existing fills.

## Refreshed screen concepts

1. **[All Agents](concepts/all-agents-v2.webp):** the preview's single divided roster, existing cat portraits,
   messaging identity, separate readiness/activity, and setup continuation. One
   New Agent action; usage totals remain within the Agent.
2. **[Agent overview](concepts/agent-overview-v2.webp):** identity first, paired usage and connection sections, then a
   readable task list. Existing schedules, capabilities, repair paths, and settings
   remain available even when outside the initial concept's visible area.
3. **[Soul](concepts/soul-editor-v2.webp):** the preview's spacious editor adapted to the real app's draft state,
   Apply changes / Discard changes controls, and next-response notice. Keep
   presets, unsaved-change protection, and error recovery in implementation.

The initial concepts remain as `all-agents.webp`, `agent-overview.webp`, and
`soul-editor.webp` for comparison. Both image sets are superseded by direct matching
to the site preview pages, as specified in [PLAN.md](PLAN.md).
The image-edit prompts preserve each screen's content and hierarchy while applying
the branch's token changes. The roster changes setup links to blue, warning dots
to orange-red, success dots to semantic green, and Idle to neutral grey. Overview
changes the All Tasks link and informational dots to supporting blue. Soul uses
the refreshed foreground, secondary button, warning indicator, and shared shell.

Image generation uses the built-in image tool with actual reference screenshots
and existing cat PNGs. Generated artwork is a layout reference; implementation
must reuse the source avatar assets byte-for-byte rather than extract generated
approximations. Mock labels and statistics do not authorize copy or data changes.

The generated images have minor differences in sidebar proportions, icon shapes,
and brand-lockup placement. Normalize these through the existing shared shell
during implementation. Use source tokens for flat fills and exact measurements;
generated edge softness or shading is not a new visual rule.

## Implementation sequence after visual review

1. **Foundation:** map the approved palette and geometry into
   `apps/web/src/ui/design.tokens.ts`, generate `theme.css`, and update shared
   recipes and the Kumo adapter. Retain Kumo and the current architecture. Resolve
   primary foreground, link, selected, hover, control border, and focus roles
   independently. Reconcile the imported brand guide with app-specific ownership
   documentation before implementation ships.
2. **Shell and representative screens:** implement the rail/sidebar and All
   Agents, overview, and Soul compositions. Keep route components thin, typed
   links, Paraglide wording, and mounted editor state. Use existing brand exports
   for any approved lockup update; do not recreate artwork.
3. **Remaining screen families:** apply the same controls and spacing to Tasks and
   task detail, Usage, Memory, Skills, Connectors and their dialogs, Agent settings,
   Account and Computers, login, and setup/repair. Preserve source, attachment,
   retry, cancellation, pagination, and provider-specific flows.
4. **State and responsive review:** verify loading, empty, partial, error,
   disabled, busy, selected, and success states; check English and Chinese at
   320, 390, 768, and 1440px. Revisit the three visual references with matching
   screenshots before expanding the redesign.

## Acceptance

- Existing avatar assets remain unchanged.
- Teal actions have dark readable labels; neutral selected states remain selected
  on hover. Status is conveyed with text as well as colour.
- Body text meets 4.5:1 contrast; meaningful control boundaries and keyboard
  focus meet 3:1. Keyboard navigation, Escape, focus return, reduced motion, and
  representative axe checks pass.
- No page overflow at supported widths; tables/logs scroll locally. Unsaved Soul
  content survives responsive and navigation-shell changes.
- Relevant theme/adapter, shell, Agent, Soul, and affected feature tests pass.
- Before a PR, run the repository-required install, check, build, typecheck, unit
  tests, agent-runtime coverage, and server integration commands.

## Original exploration validation

Both the original website source and the refreshed branch were previewed locally
and screenshots were inspected. The copied guide and token snapshot were compared
byte-for-byte to the clean refreshed branch. No app runtime code or avatar files
were changed during that exploration. Subsequent implementation validation is
recorded in [design QA](design-qa.md).

## Local implementation preview

Run `pnpm --filter @opentag/web build`, then
`node scripts/e2e/site-redesign-preview.mjs` from the repository root.
Open <http://127.0.0.1:4317/agents>. This serves the real built app with isolated
fixture data. It supports the representative screens and Soul saves in memory;
it is not a replacement for the server or an end-to-end integration environment.
Restarting the fixture resets saves. Append `?qa=1` to a route to expose the
fixture-only axe checker.

The eight exploration images use lossless WebP: 9,302,919 source PNG bytes become
5,040,358 bytes with identical decoded RGBA pixels. Production avatar filenames and
the approved high-resolution README animation remain unchanged.
