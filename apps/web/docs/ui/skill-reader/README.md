# Skill reader browser evidence

[简体中文](README.zh-CN.md)

Captured on 2026-10-10 in headed Chrome through Playwright, using the production `SkillsPage` and reader components
under React StrictMode. A temporary Vite entry outside the repository supplied synthetic in-memory API responses.
These screenshots validate the real UI, not a static mockup. They do not claim a live PostgreSQL/storage end-to-end run.
The server contract is separately covered with authenticated route/service tests and real tar.gz fixtures.

## Screenshots

| View | Viewport | Evidence |
| --- | --- | --- |
| Larger details entry, desktop hover | 1440 × 1000 | [Entry](content-area-desktop-hover.png) |
| Larger details entry, mobile | 390 × 844 | [Mobile entry](content-area-390.png) |
| Larger details entry, narrow mobile | 320 × 844 | [Narrow entry](content-area-320.png) |
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
