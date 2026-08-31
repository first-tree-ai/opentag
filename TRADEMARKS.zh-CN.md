# 商标

[English](./TRADEMARKS.md)

OpenTag 会连接其它公司的产品。为了在界面里指明这些产品，我们展示各自权利人发布的官方标识。

## 归属

下列每一个标识都属于其权利人，不属于本项目。这里使用它们，仅仅是为了指明它所代表的那个产品
——这正是商标权利人所预期和允许的用法。它们的出现并不意味着任何权利人赞助、认可 OpenTag，或与
OpenTag 存在关联。

OpenTag 自己的名称与标识属于本项目，但**不**在仓库 [LICENSE](./LICENSE) 的授权范围内：Apache-2.0
第 6 条明确不授予商标权利，代码许可证也没有涉及我们的名称或标识。使用它们的许可是另一回事，本文
并不构成该许可——请联系项目所有者。

本文同样不授予任何他人标识的权利。记录一个文件的来源只是确立了出处，而不是许可：如何使用该文件
由权利人自己的条款决定，本文无法扩大这些条款。

## 仓库中携带的素材

每个文件的开头都用注释记录了它的来源和获取日期。所有文件都**没有**被重绘或改样式：重画一个商标
既不准确，处境也比直接使用官方文件更糟。

| 文件 | 标识 | 权利人 |
| --- | --- | --- |
| `apps/web/src/assets/slack.svg` | Slack | Slack Technologies, LLC（Salesforce 旗下） |
| `apps/web/src/assets/feishu.svg` | 飞书 / Lark | 北京飞书科技有限公司 |
| `apps/web/src/assets/claude.svg` | Claude | Anthropic PBC |
| `apps/web/src/assets/openai-blossom-black.svg` | OpenAI Blossom（黑色） | OpenAI, L.L.C. |
| `apps/web/src/assets/openai-blossom-white.svg` | OpenAI Blossom（白色） | OpenAI, L.L.C. |
| `apps/web/src/assets/google-sign-in-light@2x.png` | Sign in with Google | Google LLC |

## 我们遵守的条件

- **Slack。** "Add to Slack" 按钮**直接引用 Slack 自己的 URL**（Slack 开发者文档就是这样嵌入的），
  而不是把文件复制进本仓库。未经修改、按其发布比例展示，符合
  [Slack 品牌规范](https://slack.com/media-kit)的要求，不重新配色、不改样式、不用我们自己的组件重做。
- **Codex。** 界面使用 OpenAI 官方[标识素材包](https://cdn.openai.com/brand/openai-logos.zip)中未经修改的
  OpenAI Blossom 文件，并遵守 OpenAI 的[品牌规范与标识使用条款](https://openai.com/brand/)。该标识只用于说明
  Codex 是 OpenAI 服务，紧邻明确的“Codex / OpenAI”文字，并且视觉层级低于 OpenTag 自有品牌。浅色和深色模式
  分别使用官方发布的黑色、白色版本，无需重新着色。
- **Google。** 登录按钮遵循
  [Google 品牌规范](https://developers.google.com/identity/branding-guidelines)。
- **所有标识。** 按各自比例展示，不作改动，也不以任何暗示合作关系的方式使用。

## 新增一个标识时

把权利人发布的原始文件放进 `apps/web/src/assets/`，在文件开头的注释里记录来源与日期，并在上表中加一行。
在此之前，先确认权利人的条款确实允许在本许可证下的公开仓库中再分发该文件——**有出处不等于有许可**。
不要重绘标识。
