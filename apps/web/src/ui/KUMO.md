# OpenTag Kumo UI

OpenTag uses Kumo `2.12.0` in standalone mode. The standalone stylesheet is
imported exactly once from `src/main.tsx`, followed by the generated OpenTag
theme and the small application boundary stylesheet.

## Component boundary

`design-system.tsx` is the semantic adapter used by product pages. It maps the
existing product vocabulary to Kumo primitives:

- `Button` maps `danger` to Kumo `destructive`, `compact` to `sm`, and `inline`
  to `ghost`.
- `Field` delegates label, description, and error rendering to Kumo Field.
- `StatusIndicator` uses Kumo Badge dot appearance. Informational status uses
  the neutral semantic token; brand green is not used for operational state.
- `Dialog` uses a permanently mounted Kumo compound dialog with controlled
  `open` state. Busy dialogs reject outside, Escape, and close-button dismissal.
- `Icon` uses the Phosphor registry. Icon-only controls must have an accessible
  name or title.
- `PageHeader` is the owned Kumo block in `src/components/kumo/page-header`.
  It uses Kumo `Text` for semantic `h1` titles and secondary descriptions, and
  keeps page actions in the header row when tabs are not present.
- `Tabs`, `SettingsList`, and `SettingsRow` retain their semantic API while
  emitting Kumo tabs and semantic utility classes.

Use Kumo `Input`, `InputArea`, `Select`, `Checkbox`, `Switch`, `Table`,
`LayerCard`, `Surface`, `Banner`, `Empty`, `Meter`, `Loader`, and `SkeletonLine`
for new controls. The only native control exception is the hidden file input
required by the browser file picker.

## Theme

`kumo-theme.tokens.ts` is the source configuration. `kumo-theme.css` is its
generated output and only overrides Kumo semantic variables. OpenTag keeps the
existing green direction (`#385a04`, `#4e7a06`, and `#90de14`) while Kumo
success, warning, danger, and info tokens remain independent. Dark hover uses
`#a8ec45`, which is a lightness adjustment on the same green direction. The
theme contrast test verifies normal-text WCAG AA against the relevant light and
dark foregrounds.

The theme uses explicit `data-theme="opentag"` and `data-mode="light|dark"`
attributes. Brand values were chosen for readable text and button contrast in
both modes; do not add raw colour literals to page components.

## Router links and overlays

`app.tsx` installs a Kumo `LinkProvider`. It maps internal `href` values to
React Router and leaves external URLs on native navigation. Product code can
still use React Router `Link` when route state is required. Keep dialogs mounted
and drive visibility with `open`/`onOpenChange`; this preserves Base UI focus
management and Escape behaviour.

## Verification

Run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm typecheck
pnpm test
```

Static contract tests reject legacy stylesheet imports, legacy token and class
names, tracking utility classes, `font-bold`, application-level interactive
HTML controls, and page-level CSS. Browser visual and accessibility checks must
use local fixtures and must not call public services.
