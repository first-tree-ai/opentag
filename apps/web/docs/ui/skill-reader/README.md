# Skill reader browser evidence

[简体中文](README.zh-CN.md)

Captured on 2026-10-10 in headed Chrome through Playwright, using the production `SkillsPage` and reader components
under React StrictMode. A temporary Vite entry supplied synthetic in-memory API responses; it was removed after capture.
These screenshots validate the real UI, not a static mockup. They do not claim a live PostgreSQL/storage end-to-end run.
The server contract is separately covered with authenticated route/service tests and real tar.gz fixtures.

## Screenshots

| View | Viewport | Evidence |
| --- | --- | --- |
| Desktop Markdown and file navigation | 1440 × 1000 | [Desktop](reader-1440.png) |
| Tablet | 768 × 1000 | [Tablet](reader-768.png) |
| Mobile file selector | 390 × 844 | [Mobile](reader-390.png) |
| Narrow mobile | 320 × 844 | [Narrow mobile](reader-320.png) |
| Read-only script | 1440 × 1000 | [Script](reader-code-desktop.png) |
| Single-file Skill, navigation omitted | 1440 × 1000 | [Single file](reader-single-file.png) |
| Transient failure and retry | 1440 × 1000 | [Failure](reader-failure.png) |

## Checks performed

- At all four viewport widths, axe reported no violations; document width stayed within the viewport and the dialog
  bounds remained fully visible. Narrow viewports use the file selector rather than a cramped sidebar.
- Opened the complete Markdown document, Frontmatter and Source; reached content beyond the initial reading viewport.
  PageDown scrolled the focused document in the single-file reader.
- Switched to a supporting Markdown file and followed its package-relative link back to `SKILL.md`; the new reading
  region received focus. Selected a script and confirmed it remained literal source, including script-looking text.
- Checked the binary and oversized preview explanations, mobile file switching and the transient-error retry state.
- Escape closed the dialog and restored focus to the Skill-name button. Enter reopened it; twenty successive Tab
  presses kept focus inside the dialog. Folder disclosures and file buttons retained normal keyboard semantics.

## Implementation review

The change starts from main and only adds the reader entry to the existing management list. It does not copy or depend
on PR #820. The design rationale and API boundaries are in
[the design note](../../../../../docs/design/skill-details-reader.md), with its synchronized Chinese mirror.
