# 为 OpenTag 贡献

> Canonical source: [CONTRIBUTING.md](./CONTRIBUTING.md)
> Last synced with: 2026-09-02

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

## 代码所有权

[.github/CODEOWNERS](./.github/CODEOWNERS) 按路径指定 owner。ownership-gate 必需状态检查会逐个比对变更文件，
并在 Pull Request 上给出一个红或绿的信号。该检查不会代替任何人批准；当它为红时，其 summary 会指出哪些文件仍需谁的批准。
每条规则都在 [.github/ownership-modes.json](./.github/ownership-modes.json) 中声明一个 mode；未声明 mode 的规则
按 `gate` 处理，因此漏声明会安全失败。

- `gate`：交叉评审。必须由作者以外的 owner 批准，作者没有自我豁免。这是默认值，因此未被显式豁免的路径都受 gate 约束，
  包括未来新增的任何目录。
- `territory`：如果作者是该规则的 owner 之一，可在 CI 通过后无需批准直接合并；其他作者需要其中一位 owner 的批准。
- `exempt`：该规则刻意不列出任何 owner。匹配的文件无需批准，也不会自动请求 reviewer。

`apps/web` 为 exempt。任何有写权限的人提交的 web 改动，在 CI 通过后即可合并，无需批准，也不会自动请求 reviewer。
按 commit 数量计算，这覆盖了仓库的大部分改动，也就是说对成员而言，大部分代码面没有人工评审要求。这是为迭代速度做出的
有意取舍，支撑它的是 CI 和事后评审。

`apps/web` 之外的 Markdown 为 territory，owner 范围更宽，包括 yuezengwu、bestony、Gandy2025 和 liuchao-001，
但根目录的策略与 agent 指令文件除外：`AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING.md`、`SECURITY.md` 以及后两者的中文镜像。
这些文件被拉回 gate，因为 agent 指令文件会改变本仓库中 agent 的行为，属于行为而非文档，而 `CONTRIBUTING.md` 正是本策略
自身的载体。四个例行杂务路径为 territory：`pnpm-lock.yaml`、`.editorconfig`、`.gitignore` 和 `LICENSE`。
`packages/server/drizzle/` 带有一个防御性的 gate pin，使不可逆的 migration 始终经过交叉评审。其余一切都受 gate 约束：
各 package、`apps/cli`、`.github`、`scripts`、`e2e`、根目录的构建与质量门禁配置，以及未来新增的任何目录。

在逐文件结果之上还有两条规则。当 Pull Request 作者对仓库没有写权限时——外部贡献者、来自 fork，或包括 dependabot 在内的
bot——无论改动了哪些文件，该 Pull Request 都还需要 `.github/CODEOWNERS` 中列出的任意一位 owner 的批准；`apps/web`
的豁免只适用于有写权限的人。此外，新的 push 不会撤销已有批准，因此在后续 push 之前获得的批准仍然有效，ownership gate
也不会弥补这一缺口。不要假设该检查覆盖了这一点。

放宽该策略需要对 `.github/CODEOWNERS` 做一次经过评审的改动，而该文件本身受 gate 约束。owner 由变更历史推导得出，
每月重新计算一次。
