# Contributing to OpenTag

[简体中文](./CONTRIBUTING.zh-CN.md)

OpenTag is pre-alpha. Please keep changes focused, explain the user or contributor problem they solve, and avoid adding
product capabilities without an agreed design.

## Workflow

1. Create a branch with one of these prefixes: `feat/`, `fix/`, `refactor/`, `test/`, `docs/`, `chore/`, or `merge/`.
2. Install dependencies with `pnpm install`. This also installs the Git hooks that lint and format staged files before a
   commit and re-check the repository before a push, described in
   [DEVELOPMENT.md](./DEVELOPMENT.md#git-hooks-and-worktrees).
3. Make the smallest coherent change and update relevant tests and documentation.
4. Run `pnpm check`, `pnpm build`, `pnpm typecheck`, and `pnpm test`.
5. Open a pull request using the repository template.

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, for example:

```text
feat: add an integration contract
fix: classify client connection failures
```

## Pull requests

Pull requests should describe the change, its validation, any breaking behavior, and important non-goals. Keep unrelated
refactors out of the same pull request. CI must pass before merge.

All code, code comments, GitHub templates, and technical documentation use English as the canonical source. When a
canonical document has a Chinese mirror, update both in the same pull request and refresh the mirror's sync date.

Never commit credentials, local environment files, generated build output, or vulnerability details. Report security
issues through the private process in [SECURITY.md](./SECURITY.md).

Maintainers must use the repository release workflows described in [docs/releasing.md](./docs/releasing.md). Local npm
publishing, production tags outside the protected release process, and token-based fallback publishing are not accepted.
