# 商标

[English](./TRADEMARKS.md)

OpenTag 会连接其它公司的产品。为了在界面里指明这些产品，我们展示各自权利人发布的官方标识。

## 归属

下列每一个标识都属于其权利人，不属于本项目。OpenTag 仅以未经修改、指示性的方式使用第三方标识，
用于识别其所代表的产品与集成。它们的出现并不意味着任何权利人赞助、认可 OpenTag，或与 OpenTag
存在关联。

OpenTag 自己的名称与标识属于本项目，但**不**在仓库 [LICENSE](./LICENSE) 的授权范围内：Apache-2.0
第 6 条明确不授予商标权利，代码许可证也没有涉及我们的名称或标识。使用它们的许可是另一回事，本文
并不构成该许可——请联系项目所有者。

本文同样不授予任何他人标识的权利。第三方标识及其素材文件**不以 Apache-2.0 许可证提供**。记录一个
文件的来源只是确立了出处，而不是许可：其使用由权利人的条款及适用的商标法律规范，本文无法扩大
这些权利。

## 仓库中携带的素材

每个文件的开头都用注释记录了它的来源和获取日期。这些由发布方控制的文件仅为界面识别已支持或预览中
的集成而随仓库携带。所有文件均未被重绘、改色或改样式，仓库许可证也不会把它们重新授权。

| 文件 | 标识 | 权利人 |
| --- | --- | --- |
| `apps/web/src/assets/slack.svg` | Slack | Slack Technologies, LLC（Salesforce 旗下） |
| `apps/web/src/assets/feishu.svg` | 飞书 / Lark | 北京飞书科技有限公司 |
| `apps/web/src/assets/claude.svg` | Claude | Anthropic PBC |
| `apps/web/src/assets/google-sign-in-light@2x.png` | Sign in with Google | Google LLC |
| `apps/web/src/assets/integration-github.svg` | GitHub | GitHub, Inc. |
| `apps/web/src/assets/integration-google-drive.svg` | Google Drive | Google LLC |
| `apps/web/src/assets/integration-linear.svg` | Linear | Linear Orbit, Inc. |
| `apps/web/src/assets/integration-notion.svg` | Notion | Notion Labs, Inc. |
| `apps/web/src/assets/integration-sentry.svg` | Sentry | Functional Software, Inc. |
| `apps/web/src/assets/integration-figma.svg` | Figma | Figma, Inc. |

## 我们遵守的条件

- **Slack。** "Add to Slack" 按钮**直接引用 Slack 自己的 URL**（Slack 开发者文档就是这样嵌入的），
  而不是把文件复制进本仓库。未经修改、按其发布比例展示，符合
  [Slack 品牌规范](https://slack.com/media-kit)的要求，不重新配色、不改样式、不用我们自己的组件重做。
- **Codex。** 仓库中不携带该素材。openai.com 对直接取素材一律返回 403；而从已安装的应用里把图标抠出来，
  只能确立字节的来源，不能确立在此再分发的许可。在拿到条款覆盖此用途的官方素材之前，它显示为中性标记。
- **GitHub。** 该标识用于识别与 GitHub 的集成，这属于
  [GitHub 标识规范](https://brand.github.com/foundations/logo)所说明的用途。它的视觉层级低于 OpenTag，
  且不暗示关联关系。
- **Google。** 登录按钮遵循
  [Google 身份标识规范](https://developers.google.com/identity/branding-guidelines)。Google Drive 标识用于
  识别该集成，并遵循
  [Google Drive 品牌规范](https://developers.google.com/workspace/drive/api/guides/branding)。
- **Linear。** 在紧凑的集成列表中使用仅含标识的版本，并遵循
  [Linear 品牌规范](https://linear.app/brand)。
- **Notion。** 该标识来自 Notion 控制的官方应用素材，仅用于识别 Notion 集成。Notion 也发布了官方
  [媒体素材包](https://notion.notion.site/Media-Kit-205535b1d9c4440497a3d7a2ac096286)。
- **Sentry。** 该标识来自 Sentry 控制的官方网页素材，仅用于识别 Sentry 集成。
- **Figma。** 该标识用于说明与 Figma 的兼容关系，并遵循
  [Figma 品牌规范](https://www.figma.com/using-the-figma-brand/)。
- **所有标识。** 按原生比例展示，不作改动；视觉层级低于 OpenTag 自身标识，也不以任何暗示合作或
  认可关系的方式使用。

## 新增一个标识时

使用来自发布方品牌素材包、媒体素材包或发布方控制网站的文件，并保持其可见图稿不变。把它放进
`apps/web/src/assets/`，在文件开头的注释里记录来源与获取日期，并在上表中加一行。可以添加来源注释或进行
不影响渲染的 XML 规范化，但几何形状、颜色、比例和外观必须保持不变。确认展示方式真实、仅限于指明产品
或集成，并符合权利人的现行规范。如果相关条款禁止仓库携带该文件，则在适当情况下引用权利人托管的素材，
或不展示该标识。不得重绘、改色、添加动画，也不得与 OpenTag 自身标识组合。
