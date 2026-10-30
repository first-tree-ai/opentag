# MCP catalog expansion UI verification

Supports [MCP integration](../../../docs/system/capabilities/mcp-server-integration.md).

The production-build browser suite checks all 79 directory cards, the ten category labels and
fixed order (including More and the mobile selector), and English/Chinese layouts at 320, 390,
768, and 1440 pixels. Axe reports no violations and no page-level horizontal overflow is present.
The screenshots contain local test data only.

| Width | English | Chinese |
| --- | --- | --- |
| 320 | [Directory](catalog-en-320.png) | [Directory](catalog-zh-320.png) |
| 390 | [Directory](catalog-en-390.png) | [Directory](catalog-zh-390.png) |
| 768 | [Directory](catalog-en-768.png) | [Directory](catalog-zh-768.png) |
| 1440 | [Directory](catalog-en-1440.png) | [Directory](catalog-zh-1440.png) |

[Verification scope and provider-contract evidence](../../verification/mcp-catalog-expansion.md).

## Customer setup field feedback

English and Chinese setup forms mark required fields and positive integer IDs. Invalid fields
reference their own rendered error message; valid fields reference their hint. A valid address
stays unmarked when only an environment ID fails validation. Required/format errors clear as the
value is corrected. The browser checks include Axe, live description targets, and no horizontal
overflow at desktop and narrow mobile widths.

| Width | English | Chinese |
| --- | --- | --- |
| 320 | [Field error](setup-error-en-320.png) | [Field error](setup-error-zh-320.png) |
| 1440 | [Field error](setup-error-en-1440.png) | [Field error](setup-error-zh-1440.png) |
