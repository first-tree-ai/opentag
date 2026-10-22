# MCP category filter evidence

Supports the [MCP directory contract](../../../docs/system/capabilities/mcp-server-integration.md#the-marketplace-catalog)
and the [Web design guide](../../../docs/system/web/design.md).

These captures render the production `McpDiscoverSource` inside the production `Dialog`, with
the shipped catalog, Kumo adapter, bundled Manrope fonts, and application styles. The isolated
preview was production-bundled before browser inspection. Add and close callbacks are inert;
no authenticated application, database, provider, or connection flow is exercised.

## Captures

- [English desktop, 1440px](desktop-en-1440.png)
- [English More selection and menu, 768px](desktop-more-en-768.png)
- [Chinese desktop, 768px](desktop-zh-768.png)
- [English mobile, 320px](mobile-en-320.png)
- [Chinese mobile, 390px](mobile-zh-390.png)
- [Browser observations](browser-checks.json)

## Browser checks

Chromium checked English and Chinese at 320, 390, 768, and 1440px:

- No page or dialog horizontal overflow.
- Desktop category controls occupy one row; the visible prefix and the More suffix preserve
  catalog order. The Chinese 1440px case fits every category and has no More trigger.
- Selecting a hidden category changes the trigger label and marks its menu item without shifting
  the direct choices. Escape closes More and restores focus to its trigger.
- Searching clears the desktop category highlight; choosing All clears the search.
- Mobile keeps the production Kumo Select, in the same order, with 44px controls.
- Axe found no WCAG 2 A/AA, 2.1 AA, or 2.2 AA violations in these states, including open More menus.
- No uncaught browser errors in the production-bundled preview.

The Vite development preview could not load because the existing shared distribution chunk
imports `node:crypto`. Both the application production build and this isolated production preview
tree-shake that unused import successfully. This change does not modify shared packaging.

## Local validation

- `pnpm check`
- Web and MCP preset package type checks
- Seven owned-block interaction tests for overflow, stable ordering, resizing, localization,
  selection, search state, and busy state
- Existing MCP surface, semantic adapter, theme identity, and Kumo contract tests
- MCP preset package tests (80 cases)
- Shared/MCP preset builds required by package exports, and the Web production build

Database integration, full repository unit tests, and authenticated application E2E were not run:
this change concerns category data, a Web control, and its shared visual recipe.
