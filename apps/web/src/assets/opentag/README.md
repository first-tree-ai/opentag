# OpenTag artwork

The product follows the [OpenTag homepage](https://opentag.build/). Source assets and brand styling are pinned to
[first-tree-ai/opentag-site, commit dfe9d13355109a7d8f573c4c494ce2f9d63ac178](https://github.com/first-tree-ai/opentag-site/tree/dfe9d13355109a7d8f573c4c494ce2f9d63ac178),
verified against the live homepage and a read-only checkout of that commit on 2026-09-11.

- `logo-light-transparent.svg` copies the artwork from `public/assets/opentag-logo.svg` in that repository. Its paths
  are byte-identical to the homepage light mark; only a nonvisual `OpenTag` title is added.
- `logo-dark-transparent.svg` is the matching white-outline variant: the same paths with the body outline and a face
  stroke in white, supplied in `OpenTag-SVG-Essentials-2/opentag_svg` on 2026-09-11. Its paths and colors are unchanged.
- `ui/opentag-logo.tsx` composes the mark with real OpenTag text, matching the homepage `public/index.html` `.brand`
  lockup: Sora 700 lettering at 19px with -0.02em letter spacing, a 26px mark, and a 9px gap. Sora is already
  self-hosted by the app. The wordmark variant renders the same lettering without the mark; the mark variant displays
  the icon alone. Earlier separate lockup and wordmark SVGs used different lettering and were removed.
- The app's namespaced `data-opentag-mode` selects the light or dark mark and the semantic `var(--fg)` or
  `var(--on-dark)` text color, including locally themed surfaces. Decorative artwork is hidden from assistive technology and labeled uses
  expose the supplied label once.

Browser icons in `apps/web/public/icons/` copy `public/assets/icon/favicon.svg`, `favicon.ico`,
`favicon-16.png`, `favicon-32.png`, and `apple-touch-icon.png` from the same homepage commit. The ICO is also available
at `apps/web/public/favicon.ico` for clients that request the conventional root path. `apps/web/index.html` declares
local icon URLs; the SVG favicon retains the homepage's `prefers-color-scheme` adaptation for dark tab strips. No
runtime asset request goes to the homepage. The SVG favicon adds only a nonvisual `OpenTag` title to satisfy the
repository accessibility check; all paths, colors, proportions, and the media query remain unchanged. The binary icons
are byte-identical to the source files.
