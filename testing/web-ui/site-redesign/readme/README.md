# README artwork validation

The English and Chinese root READMEs use the website's refreshed brand mark and
an animation captured from its actual **How it works** section.

## Source and export

- Source repository: `first-tree-ai/opentag-site`, branch
  `codex/design-token-refresh`, revision
  `4f63d20383045861ca5cd93be8196829f0974e5f`.
- Both `docs/.assets/opentag-logo.png` and
  `docs/.assets/opentag-logo-on-dark.png` are byte-for-byte copies of
  `public/assets/icon/brand-mark.png`. The transparent mark works on both
  backgrounds; existing README asset paths remain available.
- `docs/.assets/opentag-walkthrough.gif` is a browser capture of
  `src/Walkthrough.tsx`, its four English scene imports and `src/walkthrough.css`.
  It is illustrative website content, not a recording of a live customer account.
- Mounted the unchanged website `Walkthrough` component, English `siteContent`,
  and site styles in a temporary export page. Hid the section heading and moved
  the chapter controls outside the crop while retaining their animation clock.
  Rendered the 762px-wide stage at 2× CSS scale in an 1800×1300 viewport.
  The document-coordinate crop was x=48, y=48, width=1524, height=1164.
  Only the main animated window appears in the result.
- Selecting the first step restarted playback before recording its complete
  30.5-second cycle. Resampled timestamped captures to 10 fps without reducing
  their resolution. FFmpeg's `palettegen=stats_mode=full` and
  `paletteuse=dither=none:diff_mode=rectangle` preserve clean flat backgrounds
  with one shared palette and infinite looping.
- The GIF is 1524×1164, contains 305 frames, and is approximately 3.90 MiB.
  This is a fresh render at double pixel density, not an enlargement of the
  previous 1000×694 export.
- Both README languages use the same English animation, as before. Each has
  localized alternative text and links to its language's interactive walkthrough.

## Verification

- Inspected all three setup phases, chat, shared knowledge, and integrations:
  [scene contact sheet](walkthrough-scenes.png).
- Checked the 72px mark on GitHub-style light and dark backgrounds:
  [logo backgrounds](logo-backgrounds.png).
- Verified GIF dimensions, frame count, total duration, loop setting, and
  relative asset references in both READMEs.
- Inspected decoded GIF frames at full resolution and at README display size;
  the section title and left-hand chapter headings are excluded from every scene.
- No app runtime code changes are required for these README assets.
