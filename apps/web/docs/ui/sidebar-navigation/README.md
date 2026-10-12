# Sidebar navigation review

Updated: 2026-10-12.

[简体中文](README.zh-CN.md)

The navigation uses task checks, a fingerprint, a brain, offset skill modules, and a single connector plug.
Skills precedes Connectors in one continuous list. Section icons are 18px regular, rows are 44px,
and item gaps are 4px. All Agents, the Agent switcher, and the navigation share icon and text alignment,
with 16px between these three surfaces. Selection colors the icon and label together.

- [Desktop sidebar](desktop.png)
- [390px mobile drawer](mobile-390.png)

These captures render the production AppShell and Agent navigation with local fixture identities and
a minimal route outlet. They do not exercise authenticated APIs or provider connections.

English and Chinese layouts were checked at 320, 390, 768, and 1440px without horizontal page overflow.
Browser checks verified dimensions, alignment, item order, selection colors, Escape/focus return,
long Agent names, section preservation when switching Agents, and the unchanged `/mcp` destination.
The sidebar passed axe checks for WCAG 2.2 AA. The final mobile footer adjustment was rechecked at 390px
to confirm its full drawer width and avatar alignment.
