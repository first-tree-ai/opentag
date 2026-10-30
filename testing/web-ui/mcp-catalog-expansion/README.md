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
