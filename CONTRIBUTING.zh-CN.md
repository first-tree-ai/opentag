# 为 OpenTag 贡献

> Canonical source: [CONTRIBUTING.md](./CONTRIBUTING.md)
> Last synced with: 2026-09-01

OpenTag 处于 pre-alpha 阶段。请保持改动聚焦，说明其解决的用户或贡献者问题，并避免在没有既定设计时增加产品能力。

## 工作流

1. 使用以下前缀创建分支：`feat/`、`fix/`、`refactor/`、`test/`、`docs/`、`chore/` 或 `merge/`。
2. 运行 `pnpm install` 安装依赖。该命令同时会安装 Git hooks：commit 前对暂存文件执行 lint 与格式化，push 前重新检查
   整个仓库，详见 [DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md#git-hooks-与-worktree)。
3. 完成最小且完整的改动，并更新相关测试和文档。
4. 运行 `pnpm check`、`pnpm build`、`pnpm typecheck` 和 `pnpm test`。
5. 使用仓库模板创建 Pull Request。

Commit message 遵循 [Conventional Commits](https://www.conventionalcommits.org/)，例如：

```text
feat: add an integration contract
fix: classify client connection failures
```

## Pull Request

Pull Request 应说明改动、验证方式、破坏性行为和重要非目标。无关重构不要混入同一个 Pull Request，合并前 CI 必须通过。

`Stale Pull Requests` workflow 每天巡检所有开放的 Pull Request。静默五天的 Pull Request 会收到一条评论，@ 其作者与
reviewer；若静默满七天，且距该评论已过至少两天，bot 会将其关闭。推送 commit、发表评论或提交 review 都会重置计时。
草稿 Pull Request 不在巡检范围内，`keep-open` 标签可永久豁免。关闭是可逆的：分支不受影响，任何有写权限的人都可以重新打开。

代码、代码注释、GitHub 模板和技术文档以英文为 canonical source。英文文档存在中文镜像时，应在同一个 Pull Request
中同步更新，并刷新镜像的同步日期。

请勿提交 credentials、本地环境文件、构建产物或漏洞详情。安全问题请按 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md)
中的私密流程报告。

维护者必须使用 [docs/zh-CN/releasing.md](./docs/zh-CN/releasing.md) 中说明的仓库 release workflow。禁止本地
npm 发布、绕开受保护流程创建 production tag，以及回退到 token 发布。
