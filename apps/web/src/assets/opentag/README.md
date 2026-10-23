# openTag artwork

The application uses the website's supplied artwork:

- `site-brand-mark.png` copies `public/assets/icon/brand-mark.png`, the mark rendered by the website Agents preview.
- `site-lockup.svg` copies `public/assets/opentag-lockup-green.svg`, the official lockup used on branded app surfaces.
- The mark is byte-identical; the lockup adds only a nonvisual accessibility title. Both are exports from `first-tree-ai/opentag-site` commit
  `4f63d20383045861ca5cd93be8196829f0974e5f` (`codex/design-token-refresh`).
- `ui/opentag-logo.tsx` chooses the supplied mark or lockup and exposes one accessible label. It does not redraw the
  wordmark. Dark-mode compatibility uses the same teal mark; light mode is the supported product theme.
- Cat artwork in `public/bot-avatars/v1/` uses the website's four Lark avatar exports plus two approved
  generated additions. Every existing `.png` and `.svg` filename remains available; PNGs are 512 × 512.
  Custom avatars and fallback behavior are unchanged.

| Stable filename stem | Artwork |
| --- | --- |
| `developer` | Website Engineering |
| `engineer` | Website General |
| `artist` | Website Design |
| `sales` | Website Growth |
| `architect` | Approved rose/cream Product cat |
| `businessman` | Approved teal/mint Operations cat |

The four site SVGs retain their drawing paths and add an accessibility title; PNGs are rasterized
from them. The two generated additions are resized from the approved images in
`testing/web-ui/site-redesign/avatar-concepts/`. Their SVGs embed the same PNG bytes to preserve
the existing SVG URLs without approximating or redrawing the approved artwork. They are raster-backed
SVGs, not editable vector masters. Source concepts and generation prompts are preserved in that directory.

Browser icons are derived from `site-brand-mark.png`: transparent 16px and 32px PNGs, identical multi-size ICOs
(16px, 32px, and 48px) at `public/favicon.ico` and `public/icons/favicon.ico`, and a 180px Apple touch icon with
the 156px mark centred on white. These local assets replace the deprecated cat logos and SVG favicon.
The icon links include a version query so browsers refresh previously cached cat artwork. No runtime artwork
request goes to the website. The README marks in `docs/.assets/` also use the current teal artwork.
