# Skill reader browser evidence

Reader and historical import/discovery screenshots were captured on 2026-10-10 in headed Chrome through Playwright, using the production `SkillsPage` and reader components
under React StrictMode. A temporary Vite entry outside the repository supplied synthetic in-memory API responses.
These screenshots validate the real UI, not a static mockup. They do not claim a live PostgreSQL/storage end-to-end run.
The server contract is separately covered with authenticated route/service tests and real tar.gz fixtures.
The historical import-only and discovery/import screenshots below were captured in the Codex in-app browser with the same fixture entry. Earlier
reader screenshots retain the previous action labels. Historical discovery screenshots show an entry that is now hidden.

## Direct deletion (2026-10-22)

The list now uses a persistent delete icon beside the switch. Downloads remain in the reader. The right action
group reserves separate pointer targets with an 8px gap, and keyboard switch focus uses the shared slate token.
See [direct-deletion acceptance](delete-actions/README.md) for current screenshots, keyboard/focus behavior,
responsive measurements and accessibility scans. Earlier screenshots below retain the historical More menu.

## Centered row actions (2026-10-16)

On wide content containers, the switch and More menu are vertically centered against the entire name-and-description
group, with the existing horizontal gap and right inset. Compact containers keep the controls centered in the name
track and the single-line description below it, so long names and descriptions cannot overlap the controls.

The production component preview was reused with the current module styles. Browser measurements at 320px, 390px,
768px and 1440px confirmed the respective center alignment, separate text/action areas and no page overflow. The
switch and More menu remained independent; Enter opened details and Escape closed it. Axe scans of the 320px and
1440px lists reported no violations. No reusable component, theme value or CSS exception was added.

## Compact list descriptions (2026-10-16)

Skill rows retain a single-line description at every width. The description tooltip and native name title are removed;
hover or keyboard focus reveals a chevron inside the existing details target. The reader shows the full description
above the file content in the scrolling reading region. Each row isolates its stacking context so its independent
switch and More menu cannot paint over the reader dialog.

These screenshots use production components and the OpenTag theme in a disposable built preview with synthetic
in-memory API responses in the Codex in-app browser. Checks at 320px, 390px, 768px and 1440px found no horizontal
overflow; descriptions remained one line. Coordinate clicks on the description opened details, while the switch
and More menu stayed independent. Shift+Tab revealed the focused details target and chevron; Enter opened the reader
and closing returned focus. No new axe scan, reusable block, theme value or CSS exception was added.

## Empty state refinement (2026-10-12)

The empty Skills list now sits directly on the page background, with a 32px document icon, an 18px semantic
heading and 14px import guidance. The wording and single header import menu retain their existing behavior.
The screenshots use production components and theme in a disposable built preview with synthetic in-memory
API responses; they do not claim live storage or provider validation.

Browser checks covered 320px, 390px, 768px and 1440px with no horizontal overflow. Tab and Enter opened the
import menu and URL dialog; Escape closed the dialog and restored focus to Import skill. The populated list
and storage-unavailable disabled import state were also checked. No new axe scan, reusable block, theme value
or CSS exception was added.

## Screenshots

| View | Viewport | Evidence |
| --- | --- | --- |
| Centered actions, desktop | 1440 × 900 | [Current desktop](./controls-centered-desktop.png) |
| Centered actions, tablet | 768 × 844 | [Current tablet](./controls-centered-768.png) |
| Name-track actions, mobile | 390 × 844 | [Current mobile](./controls-centered-390.png) |
| Name-track actions, narrow mobile | 320 × 844 | [Current narrow mobile](./controls-centered-320.png) |
| Single-line descriptions, keyboard focus | 1440 × 900 | [Current desktop](./list-single-line-desktop.jpg) |
| Single-line descriptions, mobile | 390 × 844 | [Current mobile](./list-single-line-390.jpg) |
| Single-line descriptions, narrow mobile | 320 × 844 | [Current narrow mobile](./list-single-line-320.jpg) |
| Full description above the file content | 1440 × 900 | [Current reader](./reader-full-description.jpg) |
| Borderless empty state, desktop | 1440 × 900 | [Current desktop](./empty-refined-desktop.png) |
| Borderless empty state, narrow mobile | 320 × 640 | [Current empty state](./empty-refined-320.png) |
| Borderless Chinese empty state, narrow mobile | 320 × 640 | [Current Chinese empty state](./empty-refined-zh-320.png) |
| Historical import-only header | 1280 × 720 | [Previous desktop](./import-only-desktop.jpg) |
| Historical empty state, narrow mobile | 320 × 844 | [Previous empty state](./import-empty-320.jpg) |
| Historical Chinese import menu, narrow mobile | 320 × 844 | [Previous Chinese menu](./import-only-zh-320.jpg) |
| Historical discovery and import entries | 1280 × 720 | [Desktop entries](./discovery-import-desktop.jpg) |
| Discovery and import entries, narrow mobile | 320 × 844 | [English entries](./discovery-import-320.jpg) |
| Chinese import menu, narrow mobile | 320 × 844 | [Chinese entries](./discovery-import-zh-320.jpg) |
| Larger details entry, desktop hover | 1440 × 1000 | [Entry](./content-area-desktop-hover.png) |
| Larger details entry, mobile | 390 × 844 | [Mobile entry](./content-area-390.png) |
| Larger details entry, narrow mobile | 320 × 844 | [Narrow entry](./content-area-320.png) |
| Clipped description, mobile tooltip | 320 × 844 | [Tooltip](./content-area-clipped-tooltip.png) |
| Desktop Markdown and file navigation | 1440 × 1000 | [Desktop](./reader-1440.png) |
| Tablet | 768 × 1000 | [Tablet](./reader-768.png) |
| Mobile file selector | 390 × 844 | [Mobile](./reader-390.png) |
| Narrow mobile | 320 × 844 | [Narrow mobile](./reader-320.png) |
| Read-only script | 1440 × 1000 | [Script](./reader-code-desktop.png) |
| Single-file Skill, navigation omitted | 1440 × 1000 | [Single file](./reader-single-file.png) |
| Transient failure and retry | 1440 × 1000 | [Failure](./reader-failure.png) |

## Checks performed

- The name, description and content whitespace open details through one native button. Real coordinate clicks on the
  description and the far corner of the content area passed; the switch and More menu operated without opening details.
  Enter and Space opened the reader, Escape restored trigger focus, and 320px/390px entries remained within the viewport.
- Names render at 16px/600, descriptions at 14px. Controls center against the name-and-description group at
  1440px/768px and against the name at 390px/320px and in a narrow desktop content container. Mobile descriptions
  span the full content width below the name and controls.
- Historical tooltip validation, before 2026-10-16: description tooltips appeared only when the actual text was clipped. A long description showed a tooltip at 320px;
  widening the viewport to 1440px removed it while hovered, and an untruncated description stayed quiet.
  ResizeObserver and font-loading events keep the measurement current.
- Explore skills is temporarily absent from the header and empty state while discovery is being designed. One outlined
  Import skill menu offers Install from URL and Upload file. The empty state explains these methods without another
  action. The English and Chinese menus, URL dialog entry and 320px empty layout were checked in the in-app browser;
  the document remained 320px wide. The catalog component and API remain for future integration.

- At all four viewport widths, axe reported no violations; document width stayed within the viewport and the dialog
  bounds remained fully visible. Narrow viewports use the file selector rather than a cramped sidebar.
- Opened the complete Markdown document, Frontmatter and Source; reached content beyond the initial reading viewport.
  PageDown scrolled the focused document in the single-file reader.
- Switched to a supporting Markdown file and followed its package-relative link back to `SKILL.md`; the new reading
  region received focus. Selected a script and confirmed it remained literal source, including script-looking text.
- Checked the binary and oversized preview explanations, mobile file switching and the transient-error retry state.
- Escape closed the dialog and restored focus to the Skill-details trigger. Enter reopened it; twenty successive Tab
  presses kept focus inside the dialog. Folder disclosures and file buttons retained normal keyboard semantics.

## Implementation review

The reader integrates with the management list merged in PR #820. Its content area opens details; management controls
remain independent. The design rationale and API boundaries are in
[the design note](../../../docs/system/web/skill-details-reader.md), with its synchronized Chinese mirror.
