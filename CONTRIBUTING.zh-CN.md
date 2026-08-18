# 为 OpenTag 贡献

> Canonical source: [CONTRIBUTING.md](./CONTRIBUTING.md)
> Last synced with: 2026-08-17

OpenTag 处于 pre-alpha 阶段。请保持改动聚焦，说明其解决的用户或贡献者问题，并避免在没有既定设计时增加产品能力。

## 工作流

1. 使用以下前缀创建分支：`feat/`、`fix/`、`refactor/`、`test/`、`docs/`、`chore/` 或 `merge/`。
2. 运行 `pnpm install` 安装依赖。
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

代码、代码注释、GitHub 模板和技术文档以英文为 canonical source。英文文档存在中文镜像时，应在同一个 Pull Request
中同步更新，并刷新镜像的同步日期。

请勿提交 credentials、本地环境文件、构建产物或漏洞详情。安全问题请按 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md)
中的私密流程报告。

维护者必须使用 [docs/zh-CN/releasing.md](./docs/zh-CN/releasing.md) 中说明的仓库 release workflow。禁止本地
npm 发布、绕开受保护流程创建 production tag，以及回退到 token 发布。
