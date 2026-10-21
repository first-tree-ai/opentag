# Match the website app previews

Implementation and acceptance plan supporting the
[Web UI contract](../../../docs/system/web/web-ui-contract.md).
The implementation now covers the shared theme, controls, responsive shell,
roster, overview and Soul compositions. See [design QA](design-qa.md) for
rendered comparisons, validation, production adaptations and remaining test scope.

## Target and authority

Match the actual app preview pages in `opentag-site` as closely as possible.
The initial pass retained existing cat avatars. The subsequent approved
[avatar refresh](avatar-concepts/IMPLEMENTATION.md) replaces the artwork under
the same six filenames.
The generated concepts are exploration history, not implementation targets.

Source: `codex/design-token-refresh`, pinned to
`4f63d20383045861ca5cd93be8196829f0974e5f`, inspected in the clean worktree at
`/Users/gabriel/.codex/worktrees/brand-ux-preview/opentag-site`.

| Source | Authority |
| --- | --- |
| `public/agents-preview.html` | Workspace rail, roster, count, header, mobile roster |
| `public/product-preview.html` | Agent shell, overview, Soul, usage and empty-state compositions |
| `public/tokens.css` | Exact semantic colours, type, spacing, radii and dimensions |
| `public/ui-kit.css` | Buttons, inputs, cards, navigation, badges and Select states |
| `public/product-sidebar-icons.json` | Exact sidebar icon shapes and assignments |
| `src/preview-ui.tsx` | Real preview controls and Select behavior |

The [design guide](../../../docs/system/web/design.md) carries the visual guidance
from this branch. Its website source links target the site repository. Site-specific shadcn/build instructions do not
replace OpenTag's Kumo architecture or repository instructions.

Production data and working controls must remain real. Dummy zero statistics,
demo notices, session-only saving, and absent functions in a preview are not
instructions to remove production behavior. Necessary production states use the
same visual system without introducing another aesthetic.

## 1. Capture measurable reference states

Before editing UI, capture the pinned previews at 1440, 950, 768, 640, 390 and
320px: overview, roster, blank/populated Soul, usage, empty states, Select,
hover, selection and keyboard focus. Use Chinese for direct source comparisons
and verify equivalent English layouts separately.

Prepare deterministic app fixtures matching the preview: two Agents, incomplete
setup, zero usage, no schedules and no tasks. Also test populated, working,
failed and disconnected states. Compare identical viewport, locale and data
state; cat artwork is the expected artwork difference.

## 2. Port the visual foundation through shared components

| Role | Target |
| --- | --- |
| Product canvas / cards | `#fafafa` / `#ffffff` |
| Foreground / supporting text | `#25282d` / `#6b6e75` |
| Primary fill / label / hover | `#00cbb4` / `#25282d` / `#00b69f` |
| Links / supporting hints | `#2563e0`; hint background `#edf5ff`, border `#c9dffc` |
| Secondary / hover / selected | `#f4f5f7` / `#f4f5f7` / `#eef0f3` |
| Structural border / input border | `#e9ebef` / `#c6cbd1` |
| Focus | `#697586`, 2px outline with 3px offset |
| Success / warning / destructive | `#007f70` / `#e5502e` / `#e5502e`, separate semantic roles |
| Controls / cards | 40px control height, 10px control corners, 16px card corners |
| Type | Manrope; 14px body, 16px reading text, 12px metadata, 20px card headings |

Separate primary-button foreground, links, focus, selection and status tokens.
Several currently share `actionText` / `--brand-ink`; one replacement value cannot
reproduce the source. Preserve white inverse text where required.

Match primary, secondary, outline, link, disabled, selected and focus recipes.
Keep flat card boundaries and reserve elevation for transient menus. Do not copy
the site's global reset or demo markup into app feature modules.

Files: `apps/web/src/ui/design.tokens.ts`, `scripts/generate-web-theme.mjs`,
generated `apps/web/src/ui/theme.css`, `ui/primitives.css`, `ui/design-system.tsx`
and `components/kumo/page-header/page-header.tsx`.

Retain Kumo refs, labels, keyboard behavior, portals and busy states. Matching a
shadcn-based preview visually does not require a component-library migration.

## 3. Match shell, brand and navigation

| Element | Required change |
| --- | --- |
| Workspace rail | 72px desktop, 56px at or below 640px; 32px source brand mark |
| Agent sidebar | 240px desktop, 200px at or below 950px; white, right border, 20px/8px padding |
| Sidebar header | Home icon and All Agents link; no added wordmark above it |
| Agent switcher | 28px/16px/24px margins, 12px gap, 32px avatar and 16px chevron |
| Navigation | Overview, Tasks, Soul, Memory, MCP/Connectors, Skills, Usage; 6px row gaps |
| Active row | Neutral background, dark semibold text/icon, preserved on hover |
| Account | Source bottom divider, neutral letter avatar and spacing; keep the real menu |
| Icons | Source sidebar assignments and geometry, not generated-image substitutes |
| Brand assets | Reuse official site exports where the preview uses them |
| Agent avatars | Preserve existing cat assets, custom avatars, fallbacks and selection behavior |

Below 641px, follow the source's inline Agent navigation with horizontal scrolling.
The current drawer is not the primary target. Retain Agent switching and account
access through compact existing controls; the dummy hides these without providing
production alternatives. Keep route content mounted and drafts intact.

Use current localized wording and preserve string assertions. The preview's MCP
destination maps to the app's existing Connectors page; this visual work does not
require a terminology migration.

Files under `apps/web/src`: `features/shell/app-shell.tsx`, `agent-shell.tsx`,
`account-menu.tsx`, `shell-main.tsx`, `app.css`, `ui/opentag-logo.tsx`,
`ui/navigation-icons.tsx` and the icon registry in `ui/design-system.tsx`.

## 4. Match the page compositions

### All Agents

- Replace the universal 1024px frame with the source roster frame: maximum outer
  width 1280px and 40px/32px vertical/horizontal padding.
- Match the 32px desktop title, 32px header bottom spacing, 16px count-to-list gap,
  and New Agent button placement.
- Use one divided list with 20px row padding, 40px avatars, 12px identity gap,
  right-aligned compact state badge and setup link. Avoid generated-image avatar,
  text and row enlargement.
- Match mobile 56px rail, 24px/16px content padding, 20px title and 16px rows.
- Preserve stable ordering, provider identity, readiness/activity, row navigation
  and independently reachable setup actions. Do not add a decorative trailing
  chevron where the source does not render one.

Primary file: `features/agents/agents-page.tsx`.

### Agent overview

- Match maximum outer width 1400px and `40px clamp(24px, 5vw, 100px)` content
  padding; avoid adding padding outside the measured maximum width.
- Use the 44px avatar, 16px identity gap, 32px title, 6px subtitle gap, outlined
  Settings action and 24px header bottom spacing.
- Two equal columns, 24px gap: usage left, Computer/Messaging rows right.
  Cards use 24px padding and 16px corners.
- Match label-above-number usage layout, 20px numbers and central divider.
  Remove generated concepts' oversized metrics.
- Dependency labels stay left; status/actions align right. No invented
  “Connections” heading or large circular computer/vendor icons.
- Keep schedules above tasks, each in a full-width section with 24px gaps.
  Match empty-state spacing before reviewing populated content.
- Preserve repair paths, paused/readiness notices, conditional handle/creator
  information, cloud progress, actual usage windows, schedules and task actions.

Primary files: `features/agents/agent-detail-page.tsx`,
`features/agent-usage.tsx`, `features/agents/agent-schedules-section.tsx`,
and `features/tasks-page.tsx`.

### Soul

- Match title/subtitle spacing and one textarea: 10px corners, input border,
  24px padding, 16px desktop text and line-height 2.
- Match the Example badge and example prose; hide the badge when content exists.
  Placeholder guidance must never become saved content.
- Start from source height 56vh, minimum 420px, maximum 800px; keep resizing.
  Match narrower mobile padding and 440px minimum while checking accessible text
  size and actual viewport fit.
- Retain presets, preset undo, Apply/Discard, revision checking, save failure
  recovery, next-response notice and unsaved-navigation guard below the editor
  using the same visual recipes. Do not copy sessionStorage-only persistence.
- Do not add the generated concept's always-visible unsaved-status footer.
  Keep actions conditional and account for the real footer in height calculations.

Primary files: `features/agents/agent-settings/soul-editor.tsx`,
`use-soul-editor-height.ts`, `soul-preset-selector.tsx`, `soul-footer.tsx`,
`runtime-configuration.tsx` and `settings-layout.tsx`.

### Other screens

Apply source header/card/control/usage/empty-state recipes to Tasks, Usage,
Memory, Connectors, Skills, settings, Account/Computers, login and setup.
The preview does not define their complete populated workflows; preserve current
information architecture and functions and apply the same visual rules.

## 5. Reconcile production requirements explicitly

Two measured source-token issues require review during implementation:

- Orange-red `#e5502e` on white is approximately 3.81:1, below the app's 4.5:1
  normal-text requirement. Follow the overview's charcoal labels plus coloured
  dots. The gallery's small coloured error text needs an accessible treatment.
- Input border `#c6cbd1` on white is approximately 1.63:1. Where that boundary is
  required to identify the control, reconcile it with the app's 3:1 requirement.

Do not silently change the reference palette or drop accessibility checks.
Flag unavoidable accessibility corrections separately for review; these are not
permission for aesthetic divergence.

No API, database or route migration is required. Preserve typed links and
localized copy. Do not import fake account data, debug notes or dummy actions.

## 6. Delivery sequence and acceptance

1. Capture source fixtures and confirm measurements.
2. Implement tokens, shared controls, source brand assets and shell geometry.
3. Match All Agents, overview and Soul directly against the source screenshots.
4. Extend shared treatments to other screens, dialogs and transient states.
5. Reconcile documentation: preserve website source provenance, document app
   ownership separately, and update `ui/KUMO.md` and the Web UI contract's obsolete
   violet, spacing and mobile-shell rules.
6. Verify fidelity and working behavior together.

Acceptance:

- Compare source and app side by side at identical viewport, locale and state.
  Check geometry, type, icons, borders, radii, hover, selection, focus and wrapping.
  Existing cats are the intentional artwork difference; generated images are not
  acceptance baselines.
- Check 320, 390, 640, 768, 950 and 1440px in both languages. Allow local scrolling
  for wide tables/logs and navigation, never page-level horizontal overflow.
- Exercise account access, Agent switching, all navigation, Select keyboard and
  typeahead, Escape/focus return, Soul presets/apply/discard/error/leave, setup and
  recovery. Verify drafts survive responsive changes.
- Verify loading, empty, partial, busy, disabled, success and error states,
  representative axe checks, contrast, keyboard use and reduced motion.
- Run affected theme, adapter, shell, roster/overview, Soul, usage and feature
  tests. Add behavior coverage for mobile navigation and targeted visual fixtures.
- Before a PR run `pnpm install`, `pnpm check`, `pnpm build`, `pnpm typecheck`,
  `pnpm test`, `pnpm --filter @opentag/client test:agent-runtime:coverage`, and
  `pnpm --filter @opentag/server test:integration`.

## Planning evidence

This plan uses the pinned site source, inspected screenshots, and current app
theme, shell, roster, overview, usage and Soul implementations. No runtime files
or cat assets were edited in this planning pass. Existing generated concepts
remain available as superseded exploration.
