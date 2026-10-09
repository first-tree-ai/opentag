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
| `microsoft-365.svg` | [Microsoft Fluent UI product icons](https://developer.microsoft.com/en-us/fluentui#/styles/web/m365-product-icons) | [Microsoft 365 48px product mark on Microsoft's Office CDN](https://res-1.cdn.office.net/files/fabric-cdn-prod_20230815.002/assets/brand-icons/product/svg/m365_48x1.svg) |
| `asana.png` | [Asana brand guidelines](https://asana.com/brand) | [Official website favicon](https://asana.com/assets/img/brand/asana-logo-favicon.ico), losslessly decoded to PNG at its original 100×100 size |
| `monday.png` | [monday.com press kit](https://monday.com/p/news/press-kit/) | [Official website 192px product mark](https://monday.com/p/wp-content/themes/monday-news/images/favicons/favicon-monday5-192.png) |
| `hubspot.png` | [HubSpot website](https://www.hubspot.com/csol) | [Official orange sprocket product mark](https://www.hubspot.com/hs-fs/hubfs/HubSpot-sprocket-color-Aug-03-2022-04-23-39-02-PM.png?width=180&height=181&name=HubSpot-sprocket-color-Aug-03-2022-04-23-39-02-PM.png) |
| `figma.svg` | [Figma brand guidelines](https://www.figma.com/using-the-figma-brand/) | [Official website SVG product mark](https://static.figma.com/app/icon/2/favicon.svg) |
| `canva.png` | [Canva website](https://www.canva.com/) | [Official website favicon](https://static.canva.com/domain-assets/canva/static/images/favicon-1.ico), losslessly decoded to PNG at its original 32×32 size |
| `tavily.svg` | [Tavily brand guidelines](https://www.tavily.com/brand) | [Official black product mark](https://www.tavily.com/logos/tavily-mark-black.svg) |
| `firecrawl.svg` | [Firecrawl press and brand kit](https://www.firecrawl.dev/press-brand) | `firecrawl-logo.svg` from the [official brand archive](https://www.firecrawl.dev/brand/brand-assets.zip) |
| `zapier.png` | [Zapier website](https://zapier.com/press) | [Official website favicon](https://zapier.com/favicon.ico), losslessly decoded to PNG using its original 192×192 frame |
| `atlassian.svg` | [Atlassian Design logos](https://atlassian.design/foundations/logos/) | `Atlassian/Atlassian Mark/SVG/Atlassian mark brand RGB.svg` from the [official logo archive](https://atlassian.design/assets/5f37a2b999c5/logos/atlassian_logo.zip) |
| `airtable.png` | [Airtable website](https://www.airtable.com/) | [Official 48px website favicon](https://www.airtable.com/favicon.ico); the response is already PNG, retained without conversion |
| `supabase.svg` | [Supabase brand assets](https://supabase.com/brand-assets) | `brand-assets/supabase-logo-icon.svg` from the [official brand archive](https://supabase.com/brand-assets.zip) |
| `amplitude.png` | [Amplitude website](https://amplitude.com/) | [Official website Apple touch icon](https://amplitude.com/nextjs-public/favicon/apple-touch-icon.png) |
| `stripe.svg` | [Stripe website](https://stripe.com/) | [Official website SVG product mark](https://images.stripeassets.com/fzn2n1nzq965/1hgcBNd12BfT9VLgbId7By/01d91920114b124fb4cf6d448f9f06eb/favicon.svg) |

The People API documentation does not identify a separate product mark. Its catalog entry keeps the neutral connection icon instead of borrowing the Google Contacts logo.

Only catalog endpoints with `iconIsOfficial: true` receive a product mark. Leave this flag absent until the asset is verified against an official source. Unknown services and unavailable images use the shared neutral connection icon. Do not infer a brand from a user-defined Server name or fetch arbitrary favicons.

Downloaded SVGs and PNGs remain unmodified vendor files. Asana, Canva, and Zapier are format-only ICO-to-PNG conversions with unchanged pixels and dimensions. No mark is redrawn, recolored, or cropped. The scoped Biome override leaves their accessibility metadata intact; `McpServiceIcon` renders them as decorative images with an empty `alt` beside the visible service name.
