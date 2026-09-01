# OpenTag Kumo UI

OpenTag uses Kumo `2.12.0` with Tailwind CSS v4. `src/app.css` is the only
application stylesheet entry: it registers Kumo's distribution as a Tailwind
source, imports Kumo's Tailwind styles before Tailwind itself, then loads the
generated OpenTag theme and the small application boundary stylesheet.
The authenticated application shell keeps its navigation and scroll viewport
fluid. Its route outlet sits inside a centered `max-w-5xl` content frame, so
Application pages share one 1024px maximum width while still filling the available
space on smaller screens. The frame is also the named `content` container;
page grids respond to its available width instead of the viewport width that
still includes the Sidebar. Login and onboarding live outside that shell and
keep their task-specific layouts. Horizontal overflow belongs to the nearest
table, code, or log surface rather than the application scroll viewport.

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
existing green direction for brand emphasis while Kumo success, warning,
danger, and info tokens remain independent. Generic recessed, tint, table-row,
disabled, and hover surfaces stay in one warm-neutral family; `--brand-soft` is
reserved for explicit selected and current states. Kumo lightens emphasis
buttons at runtime, so the adapter replaces that mix with reviewed primary and
danger gradients. The theme contrast test verifies every rendered gradient
endpoint for normal-text WCAG AA, not only the source accent.

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
