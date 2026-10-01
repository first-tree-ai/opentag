# 商标与素材来源

[English](../trademarks.md)

> 权威来源：[docs/trademarks.md](../trademarks.md) · 同步日期：2026-10-01

OpenTag 会连接其它公司的产品。为了在界面里指明这些产品，我们展示各自权利人发布的官方标识。

## 归属

下列每一个标识都属于其权利人，不属于本项目。OpenTag 仅以未经修改、指示性的方式使用第三方标识，
用于识别其所代表的产品与集成。它们的出现并不意味着任何权利人赞助、认可 OpenTag，或与 OpenTag
存在关联。

OpenTag 自己的名称与标识属于本项目，但**不**在仓库 [LICENSE](../../LICENSE) 的授权范围内：Apache-2.0
第 6 条明确不授予商标权利，代码许可证也没有涉及我们的名称或标识。使用它们的许可是另一回事，本文
并不构成该许可——请联系项目所有者。

本文同样不授予任何他人标识的权利。第三方标识及其素材文件**不以 Apache-2.0 许可证提供**。记录一个
文件的来源只是确立了出处，而不是许可：其使用由权利人的条款及适用的商标法律规范，本文无法扩大
这些权利。

## 仓库中携带的素材

SVG 文件的开头用注释记录来源和获取日期，位图的来源记录在下方。
这些由发布方控制的文件仅为界面识别已支持或预览中的集成而随仓库携带。所有文件均未被重绘、改色或改样式，
仓库许可证也不会把它们重新授权。

| 文件 | 标识 | 权利人 |
| --- | --- | --- |
| `apps/web/src/assets/slack.svg` | Slack | Slack Technologies, LLC（Salesforce 旗下） |
| `apps/web/src/assets/feishu.svg` | 飞书 / Lark | 北京飞书科技有限公司 |
| `apps/web/src/assets/claude.svg` | Claude | Anthropic PBC |
| `apps/web/src/assets/openai-blossom-black.svg` | OpenAI Blossom（黑色） | OpenAI, L.L.C. |
| `apps/web/src/assets/openai-blossom-white.svg` | OpenAI Blossom（白色） | OpenAI, L.L.C. |
| `apps/web/src/assets/google-g.png` | Google G | Google LLC |
| `apps/web/src/assets/pi.svg` | Pi | Pi（pi.dev） |

## 我们遵守的条件

- **Slack。** "Add to Slack" 按钮**直接引用 Slack 自己的 URL**（Slack 开发者文档就是这样嵌入的），
  而不是把文件复制进本仓库。未经修改、按其发布比例展示，符合
  [Slack 品牌规范](https://slack.com/media-kit)的要求，不重新配色、不改样式、不用我们自己的组件重做。
- **Codex。** 界面使用 OpenAI 官方[标识素材包](https://cdn.openai.com/brand/openai-logos.zip)中未经修改的
  OpenAI Blossom 文件，并遵守 OpenAI 的[品牌规范与标识使用条款](https://openai.com/brand/)。该标识只用于说明
  Codex 是 OpenAI 服务，紧邻明确的“Codex / OpenAI”文字，并且视觉层级低于 OpenTag 自有品牌。浅色和深色模式
  分别使用官方发布的黑色、白色版本，无需重新着色。
- **Google。** 登录按钮遵循
  [Google 身份标识规范](https://developers.google.com/identity/branding-guidelines)。未经修改的 G 标识于 2026-09-07
  获取自 [Google 官方素材](https://developers.google.com/static/identity/images/g-logo.png)，按钮文案为本地化 HTML 文本。
- **飞书 / Lark。** 未经修改的应用标识于 2026-08-24 获取自
  [飞书官方图标](https://www.feishu.cn/favicon.ico)，来源已记录在 SVG 文件头中。它仅用于识别飞书 / Lark 集成，
  不暗示认可或关联关系；其使用受发布方现行条款约束。
- **Claude。** 未经修改的应用标识于 2026-08-29 获取自
  [Claude 官方图标](https://claude.ai/favicon.ico)，来源已记录在 SVG 文件头中。它仅用于识别 Claude 集成，
  不暗示认可或关联关系；其使用受发布方现行条款约束。
- **Pi。** 官方 Pi 标识由 [PR #683](https://github.com/first-tree-ai/opentag/pull/683) 的提交
  `d6e7fd0f105befd616df30f7ef7df42524d4ea00` 于 2026-09-21 从
  [Pi 官方 Logo](https://pi.dev/logo-auto.svg) 获取，来源已记录在 SVG 文件头中。它未经修改，仅用于识别 Pi runtime；
  其使用受发布方现行条款约束，本文不暗示认可或关联关系。
- **所有标识。** 按原生比例展示，不作改动；视觉层级低于 OpenTag 自身标识，也不以任何暗示合作或
  认可关系的方式使用。

## 新增一个标识时

使用来自发布方品牌素材包、媒体素材包或发布方控制网站的文件，并保持其可见图稿不变。把它放进
`apps/web/src/assets/`，在 SVG 文件开头的注释里记录来源与获取日期；位图则在本文中记录。并在上表中加一行。可以添加来源注释或进行
不影响渲染的 XML 规范化，但几何形状、颜色、比例和外观必须保持不变。确认展示方式真实、仅限于指明产品
或集成，并符合权利人的现行规范。如果相关条款禁止仓库携带该文件，则在适当情况下引用权利人托管的素材，
或不展示该标识。不得重绘、改色、添加动画，也不得与 OpenTag 自身标识组合。
