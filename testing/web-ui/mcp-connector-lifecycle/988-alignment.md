# Removal action alignment with PR 988

Validated on 2026-10-22 against the Skill list removal recipe in
[PR 988](https://github.com/first-tree-ai/opentag/pull/988).

The connector list uses the same compact square ghost button and Phosphor trash glyph:

| State | Verified result |
| --- | --- |
| Desktop target / icon | 32 × 32 px / 16 px |
| Idle icon | `rgb(105, 108, 115)` |
| Hover | `rgb(180, 35, 24)` icon over `rgb(244, 245, 247)` shared neutral surface |
| Keyboard focus | Shared 2px slate outline, danger icon, no extra background fill |
| Mobile target | 44 × 44 px in both languages at 320px |

The localized Tooltip and connector-specific accessible name remain. The Tooltip owns its trigger
ID; focus lookup uses the row and `data-ui` marker without overriding that internal ID. This keeps
both hover and focus tooltips working. Removal remains independent of the left identity's hover
and management entry.

The confirmation now uses a ghost Cancel button, initially focused. Cancel/Escape return focus to
the same removal button. After successful removal, focus moves to the next available removal button,
then the preceding one if needed, or the named Connectors page when no available button remains.
Busy and disconnected targets are skipped. A regression covers a busy next row. The connector copy
continues to say Remove rather than inheriting the Skill archive's irreversible-delete wording.

Validation after alignment:

- MCP page and removal tests: **2 files, 32 tests passed**. This includes the new concurrent-row
  focus regression. The earlier complete MCP run remains recorded separately; it was not repeated
  for this bounded UI refinement.
- Web typecheck, normal production build, `pnpm check`, and `git diff --check` passed.
- Playwright on the full production Web application with the same local HTTP fixture verified idle,
  hover, Tooltip, keyboard focus, confirmation, cancellation, next-control focus, empty-page focus,
  and English/Chinese 320px targets and confirmations. Server/provider limitations are unchanged.
- No shared switch/dialog changes from the separate PR were copied into this branch.

Current captures supersede the earlier removal appearance/focus captures:

- [Hover and Tooltip](./mcp-988-hover-1440.png)
- [Keyboard focus and Tooltip](./mcp-988-keyboard-1440.png)
- [English mobile confirmation](./mcp-988-confirm-en-320.png)
- [Chinese mobile confirmation](./mcp-988-confirm-zh-320.png)
