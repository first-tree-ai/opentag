# Skill reader browser evidence

[简体中文](README.zh-CN.md)

Captured on 2026-10-10 in headed Chrome through Playwright, using the production `SkillsPage` and reader components
under React StrictMode. A temporary Vite entry outside the repository supplied synthetic in-memory API responses.
These screenshots validate the real UI, not a static mockup. They do not claim a live PostgreSQL/storage end-to-end run.
The server contract is separately covered with authenticated route/service tests and real tar.gz fixtures.
The current import-only and historical discovery/import screenshots below were captured in the Codex in-app browser with the same fixture entry. Earlier
reader screenshots retain the previous action labels. Historical discovery screenshots show an entry that is now hidden.

## Screenshots

| View | Viewport | Evidence |
| --- | --- | --- |
| Import-only header | 1280 × 720 | [Current desktop](import-only-desktop.jpg) |
| Empty state, narrow mobile | 320 × 844 | [Current empty state](import-empty-320.jpg) |
| Chinese import menu, narrow mobile | 320 × 844 | [Current Chinese menu](import-only-zh-320.jpg) |
| Historical discovery and import entries | 1280 × 720 | [Desktop entries](discovery-import-desktop.jpg) |
| Discovery and import entries, narrow mobile | 320 × 844 | [English entries](discovery-import-320.jpg) |
| Chinese import menu, narrow mobile | 320 × 844 | [Chinese entries](discovery-import-zh-320.jpg) |
| Larger details entry, desktop hover | 1440 × 1000 | [Entry](content-area-desktop-hover.png) |
| Larger details entry, mobile | 390 × 844 | [Mobile entry](content-area-390.png) |
| Larger details entry, narrow mobile | 320 × 844 | [Narrow entry](content-area-320.png) |
| Clipped description, mobile tooltip | 320 × 844 | [Tooltip](content-area-clipped-tooltip.png) |
| Desktop Markdown and file navigation | 1440 × 1000 | [Desktop](reader-1440.png) |
| Tablet | 768 × 1000 | [Tablet](reader-768.png) |
| Mobile file selector | 390 × 844 | [Mobile](reader-390.png) |
| Narrow mobile | 320 × 844 | [Narrow mobile](reader-320.png) |
| Read-only script | 1440 × 1000 | [Script](reader-code-desktop.png) |
| Single-file Skill, navigation omitted | 1440 × 1000 | [Single file](reader-single-file.png) |
| Transient failure and retry | 1440 × 1000 | [Failure](reader-failure.png) |

## Checks performed

- The name, description and content whitespace open details through one native button. Real coordinate clicks on the
  description and the far corner of the content area passed; the switch and More menu operated without opening details.
  Enter and Space opened the reader, Escape restored trigger focus, and 320px/390px entries remained within the viewport.
- Names render at 16px/600, descriptions at 14px. Controls align with the name at 1440px/768px/390px/320px and in a
  narrow desktop content container. Mobile descriptions span the full content width below the name and controls.
- Description tooltips appear only when the actual text is clipped. A long description showed a tooltip at 320px;
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
[the design note](../../../../../docs/design/skill-details-reader.md), with its synchronized Chinese mirror.
