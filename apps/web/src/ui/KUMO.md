# openTag Kumo UI

The canonical product composition and acceptance rules live in
[`docs/system/web/web-ui-contract.md`](../../../../docs/system/web/web-ui-contract.md). This document records the Kumo-specific
implementation choices behind that interface.

openTag uses Kumo `2.13.1` with Tailwind CSS v4. `src/app.css` is the only
application stylesheet entry: it registers Kumo's distribution as a Tailwind
source, imports Kumo's Tailwind styles before Tailwind itself, then loads the
generated openTag theme and shared primitive recipes. The small shell/browser boundary follows in app.css.
The authenticated shell keeps one mounted route outlet and scroll viewport. The named `content` container sits inside
an outer frame capped at 1400px for Agent pages (40px vertical padding, horizontal padding clamped between 24px and
100px at 5vw) and 1280px for workspace pages (40px/32px padding). At 950px and below Agent content uses 28px/24px;
at 640px and below both frames use 24px/16px. Login and onboarding retain their task-specific layouts. Horizontal
overflow belongs to the nearest table, code, log, or navigation region.

The workspace rail is 72px, or 56px at 640px and below. Agent navigation is 240px, becomes 200px between 641px and
950px, and moves above the page with horizontally scrolling links at 640px and below. Agent switching and the account
menu remain reachable in the compact top row. CSS changes layout without remounting the route or its unsaved drafts.
`SidebarProvider` uses `collapsible="none"`; there is no mobile drawer or modal focus trap on the inline navigation.

## Component boundary

Product pages use two parallel seams: `design-system.tsx` for semantic primitives
and `src/components/kumo` for deeper owned blocks. The semantic adapter maps the
existing product vocabulary to Kumo primitives:

- `Button` maps `danger` to Kumo `destructive`, `compact` to `sm`, and `inline`
  to `ghost`.
- `Button` maps `filter` to Kumo `ghost` with the shared neutral-grey selected recipe.
  Direct choices use `aria-pressed`; a menu trigger representing a selected choice uses `data-selected`.
- `OverflowFilter` is an owned block that measures available width, retains a fixed visible prefix,
  and puts trailing choices into a Kumo radio menu. It reserves selected-label space so selection
  does not shift peers, and recalculates after container or font changes. Callers own copy and order.
- `Field` delegates label, description, and error rendering to Kumo Field.
- `StatusIndicator` uses Kumo Badge dot appearance. Informational status uses
  the neutral semantic token; brand teal is not used for operational state.
- `Switch` and `Switch.Item` use brand teal when checked and neutral colors when
  unchecked. The adapter replaces Kumo's fixed track colors with semantic tokens while
  preserving Kumo sizing, shape, motion, focus, disabled, and busy behavior. Color variants
  are not exposed to callers; operational status text keeps its own semantics.
- `Dialog` uses a permanently mounted Kumo compound dialog with controlled
  `open` state. Busy dialogs reject outside, Escape, and close-button dismissal.
  Its non-landmark header exposes `data-ui="dialog-header"` for module layout and browser geometry checks.
- `Icon` uses the Phosphor registry. Icon-only controls must have an accessible
  name or title.
- `PageHeader` is the owned Kumo block in `src/components/kumo/page-header`.
  It uses the adapter’s semantic `Text` for semantic `h1` titles and secondary descriptions, and
  keeps page actions in the header row when tabs are not present.
  Its `title-actions` layout places actions beside the title and gives the description a separate
  full-width row; the default layout retains its bounded description and content-level alignment.
- `Tabs`, `SettingsList`, and `SettingsRow` retain their semantic API while
  emitting Kumo tabs and semantic utility classes.
- `Text` keeps document heading levels independent of visual size through `headingSize` (`page`, `section` or `body`).
  These choices reuse existing page, section and body sizes. A Task detail keeps its `h1` while using
  16px medium body typography; other callers retain their existing defaults.

Use Kumo `Input`, `InputArea`, `Select`, `Checkbox`, `Switch`, `Table`,
`LayerCard`, `Surface`, `Banner`, `Empty`, `Meter`, `Loader`, and `SkeletonLine`
for new controls. The only native control exception is the hidden file input
required by the browser file picker.

Feature modules do not import `@cloudflare/kumo` directly. Direct imports belong
to application provider wiring, `design-system.tsx`, and owned blocks under
`src/components/kumo`; tests may provide their own provider wiring. Add an owned
block only when it hides meaningful shared behavior, not merely to forward Kumo
props or utility classes. Owned-block interfaces use openTag types and do not
expose Kumo-specific types or composition to callers.

## Theme

[design guide](../../../../docs/system/web/design.md) is the visual specification. `design.tokens.ts` is the canonical palette and measurement
source; `pnpm theme:generate` produces `theme.css`. The repository check rejects stale output. `primitives.css`
applies the shared Manrope hierarchy, control sizing, flat button fills, and surface radii through adapter classes.
Primary actions use teal with charcoal labels; links use blue; selected rows use neutral grey with charcoal text.
Input, InputArea, Select and Soul share a 1px idle boundary using `--border-strong`, preserving the
3:1 contrast contract. Pointer focus and an expanded Select use the slate focus token on that same
1px boundary, without an additional ring or shadow. Keyboard navigation uses one 2px contour at the
existing boundary. The App tracks pointer input and keyboard navigation, actions and shortcuts at
the document level, including body-mounted popups; typing in a pointer-focused field does not thicken
its border. Isolated components fall back to keyboard focus. Actions retain keyboard focus-visible.
Filled primary and danger actions use contrasting inset indicators. Invalid controls retain danger focus,
and forced-colors mode uses the system highlight. The Soul editor follows the
same boundary without changing its editing or save behavior. Success, warning, danger, and info
retain independent semantic roles.
Generic recessed, tint, table-row, disabled, and hover surfaces stay neutral; `--brand-soft` is reserved for explicit
selected/current states. The button adapter assigns the same reviewed fill to Kumo's gradient endpoints and ring,
removing the decorative treatment. Tests verify normal text, action fills, active boundaries, and keyboard focus.

The theme uses explicit `data-opentag-theme="opentag"` and `data-opentag-mode="light|dark"`
attributes, set statically on `<html>` in `index.html`. The namespacing keeps third-party code
that rewrites the generic `data-theme` or `data-mode` attributes from detaching openTag's
selectors from the document, and tokens stay on the root element so body-mounted Dialog, Select,
and Tooltip portals inherit them. Emphasis buttons additionally carry literal light-palette
fallbacks inside their `var(--opentag-button-…, …)` overrides — in `buttonClassName` they must be
static strings for Tailwind scanning — so an emphasis surface stays accessible even when no
ancestor resolves the openTag tokens. The product currently ships light mode; dark values remain
available for compatibility and future completion, not as a supported product theme.
Brand values were chosen for readable text and button contrast in both modes;
do not add raw colour literals to page components.

`src/features/theme-integrity-notice.tsx` watches the same four theme attributes on the root
element only — initial state plus later mutations, including a value changed and restored within
one mutation batch — and shows one dismissible, localized warning per App mount when they drift
from the shipped scaffold. It is deliberately read-only: it never rewrites a root attribute, and
it does not attempt to detect arbitrary injected styles or other DOM modifications exhaustively.
Kumo status tokens are not part of the notice's local theme scope, so the wrapper additionally
pins the banner's warning text and tint through component-local Tailwind arbitrary properties
(with `color-scheme: light`) on existing Kumo/Tailwind light palette primitives — otherwise a
generic dark mode written onto the root re-themes the banner into poor contrast over the light page.

## Router links and overlays

`app.tsx` installs a Kumo `LinkProvider`. It maps internal `href` values to
TanStack Router and leaves external URLs on native navigation. Product code can
still use TanStack Router `Link` when route state is required. Keep dialogs mounted
and drive visibility with `open`/`onOpenChange`; this preserves Base UI focus
management and Escape behaviour.

## Select and dependency compatibility

Select remains Kumo/Base UI behind the semantic adapter. Its trigger uses the website chevron and control recipe;
options use neutral selection and slate keyboard focus. The adapter preserves numeric and empty-string values,
multiple selection, field validation, labels, and caller-provided trigger rendering. No shadcn dependency is required
for these recipes. Shared Tailwind type sizes override Kumo's smaller defaults (14px small, 16px reading text).

The existing Kumo dependency patch retains its `collapsible` context memo correction for other callers. The current
shell keeps navigation inline at every breakpoint and does not switch that property in response to media queries.

## Website reference and accessibility

The design guide includes website references. Its website framework instructions apply to the site
repository; this document and the Web UI contract define application ownership and behavior. Production data, recovery,
presets, save/discard, and unsaved-navigation protection remain functional. Cat assets and custom-avatar behavior are
unchanged. Official website artwork is documented in `src/assets/opentag/README.md`.

The reference's pale input boundary is strengthened to `#8a8e95` for a 3:1 control boundary. Supporting body text uses
`#696c73`; the lighter decorative muted token is not used for normal text. Selected rows use foreground text; supporting text also meets 4.5:1 on the selected surface.
Orange-red `#e5502e` is reserved for warning dots, with `#a63f22` warning text. Danger dots, text, and buttons use `#b42318`. Selection indicators and progress markers use the slate focus token.
Primary-button foreground has its own token; inverse text elsewhere remains white. These are accessibility treatments,
not a second visual direction. The light palette contrast tests cover text, buttons, boundaries, and focus.
