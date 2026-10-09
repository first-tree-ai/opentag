# MCP product logos

These original assets identify third-party services in the MCP list and Discover catalog. They are bundled locally; rendering does not contact the provider. Each mark belongs to its respective owner and retains its official colors and proportions.

Retrieved on 2026-10-09:

| Asset | Official source | Download |
| --- | --- | --- |
| `linear.svg` | [Linear brand guidelines](https://linear.app/brand) | `logo-dark.svg` from [brand assets](https://static.linear.app/design-assets/Linear-Brand-Assets.zip) |
| `notion.png` | [Notion website](https://www.notion.com) | [512px website logo](https://www.notion.so/images/logo-ios.png) |
| `sentry.svg` | [Sentry logo generator](https://sentry.io/branding/) | Dark glyph, transparent background, fit to logo, clear space included |
| `exa.svg` | [Exa brand guidelines](https://exa.ai/brand) | `Exa Logomark Blue.svg` from [brand assets](https://exa.ai/assets/Exa%20Brand%20Assets.zip) |
| `gmail.svg` | [Google Workspace website](https://workspace.google.com/) | [Official gmail_2026 product mark](https://www.gstatic.com/images/branding/productlogos/gmail_2026/v2/web/192px.svg) |
| `google-drive.svg` | [Google Workspace website](https://workspace.google.com/) | [Official drive_2026 product mark](https://www.gstatic.com/images/branding/productlogos/drive_2026/v2/web/192px.svg) |
| `google-docs.svg` | [Google Workspace website](https://workspace.google.com/) | [Official docs_2026 product mark](https://www.gstatic.com/images/branding/productlogos/docs_2026/v2/web/192px.svg) |
| `google-sheets.svg` | [Google Workspace website](https://workspace.google.com/) | [Official sheets_2026q3 product mark](https://www.gstatic.com/images/branding/productlogos/sheets_2026q3/v1/web/192px.svg) |
| `google-slides.svg` | [Google Workspace website](https://workspace.google.com/) | [Official slides_2026 product mark](https://www.gstatic.com/images/branding/productlogos/slides_2026/v2/web/192px.svg) |
| `google-calendar.svg` | [Google Workspace website](https://workspace.google.com/) | [Official calendar_2026 product mark](https://www.gstatic.com/images/branding/productlogos/calendar_2026/v2/web/192px.svg) |
| `google-chat.svg` | [Google Workspace website](https://workspace.google.com/) | [Official chat_2026 product mark](https://www.gstatic.com/images/branding/productlogos/chat_2026/v2/web/192px.svg) |

The People API documentation does not identify a separate product mark. Its catalog entry keeps the neutral connection icon instead of borrowing the Google Contacts logo.

Only catalog endpoints with `iconIsOfficial: true` receive a product mark. Leave this flag absent until the asset is verified against an official source. Unknown services and unavailable images use the shared neutral connection icon. Do not infer a brand from a user-defined Server name or fetch arbitrary favicons.

The SVGs remain unmodified vendor files. The scoped Biome override leaves their accessibility metadata intact; `McpServiceIcon` renders them as decorative images with an empty `alt` beside the visible service name.
