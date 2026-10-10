# Skill 阅读器浏览器验证

[English](README.md)

同步日期：2026-10-10。

通过 Playwright 在有界面的 Chrome 中验证，使用生产代码中的 `SkillsPage` 和阅读器组件，启用 React StrictMode。
临时 Vite 入口提供内存中的模拟 API 响应，截图后已删除。截图来自实际交互界面，不是静态设计图；它们不代表连接真实
PostgreSQL 和存储服务的端到端测试。后端另有认证路由、服务测试和真实 tar.gz 测试包验证。

## 截图

| 场景 | 视口 | 证据 |
| --- | --- | --- |
| 桌面 Markdown 和文件导航 | 1440 × 1000 | [桌面](reader-1440.png) |
| 平板 | 768 × 1000 | [平板](reader-768.png) |
| 手机文件选择器 | 390 × 844 | [手机](reader-390.png) |
| 窄屏手机 | 320 × 844 | [窄屏](reader-320.png) |
| 只读脚本 | 1440 × 1000 | [脚本](reader-code-desktop.png) |
| 单文件 Skill，省略文件导航 | 1440 × 1000 | [单文件](reader-single-file.png) |
| 临时失败与重试 | 1440 × 1000 | [失败](reader-failure.png) |

## 已执行的检查

- 四种视口宽度的 axe 检查均无违规；页面没有横向溢出，弹窗完全位于视口内。手机使用文件选择器。
- 阅读完整 Markdown、Frontmatter 和 Source，访问首屏之后的正文。单文件阅读器中，聚焦正文后 PageDown 能滚动。
- 打开参考 Markdown，通过包内相对链接返回 `SKILL.md`，焦点移至新正文区域。脚本始终作为字面文本展示，包括类似
  script 标签的内容。
- 检查二进制文件、超大文件提示、手机文件切换和临时失败时的重试状态。
- Escape 关闭并将焦点返回 Skill 名称按钮；Enter 重新打开。连续二十次 Tab 始终保持在弹窗内。文件夹和文件按钮采用
  常规键盘操作。

## 实现审查

本改动基于 main，仅在现有管理列表增加阅读器入口，不复制或依赖 PR #820。
[设计说明](../../../../../docs/zh-CN/design/skill-details-reader.md)记录了交互与 API 边界，并与英文版本同步。
