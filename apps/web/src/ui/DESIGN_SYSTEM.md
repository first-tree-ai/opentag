# OpenTag Web Design System

This module is intentionally small. It owns repeated interaction and layout rules; product-specific cards and workflows stay with their pages.

## Page contract

- Workspace pages use one `1024px` outer frame with `32px` inline gutters, leaving `960px` of visible content.
- Only page shells own page-level width. Sections, lists, forms, and panels use `width: 100%` and do not introduce another max-width.
- Product pages keep the warm neutral canvas and olive brand treatment. Operational status uses the status palette, not the brand color.

## Geometry

- Dividers and surface borders are `1px`.
- Controls use `8px` radius and a `40px` minimum height.
- Panels and grouped settings use `12px` radius.
- Repeated spacing uses the semantic `--space-*` tokens in `design-system.css`; new one-off spacing steps should not be added.

## Modules

- `Button` / `buttonClassName`: button hierarchy and link-as-button styling.
- `Field`: accessible label, hint, and error relationships.
- `Tabs`: labelled top navigation with optional mobile collapse when a select fallback exists.
- `SettingsList` / `SettingsRow`: two-column settings geometry that collapses to one column on small screens.
- `StatusIndicator`: operational state, visually separate from brand intent.
- `Icon`: formal interaction icons instead of Unicode controls.
- `Dialog`: focus trapping, Escape handling, busy state, and focus return.

## Usage rules

- Reuse a module when its semantic contract matches; do not add a variant only to reproduce one page.
- Keep simple table selects as `ds-control` without wrapping them in `Field` or `SettingsRow`.
- Keep top-level destinations as separate pages; do not repeat the app-shell navigation as page-level `Tabs`.
- Keep domain modules such as Agent cards, messaging panels, runtime configuration, and invitation flows local to their page until at least two real call sites share the same behavior.
- New pages should compose these modules and existing page shells before adding CSS. If a new pattern is genuinely repeated, deepen the existing module instead of creating a parallel one.
