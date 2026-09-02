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

Open pull requests are swept daily by the `Stale Pull Requests` workflow. A pull request with no activity for five days
gets a comment naming its author and reviewers; if it is still untouched after seven days, and at least two days after
that comment, the bot closes it. Pushing a commit, leaving a comment, or submitting a review resets the clock. Drafts are
never swept, and the `keep-open` label exempts a pull request indefinitely. Closing is reversible: the branch survives
and anyone with write access can reopen the pull request.

All code, code comments, GitHub templates, and technical documentation use English as the canonical source. When a
canonical document has a Chinese mirror, update both in the same pull request and refresh the mirror's sync date.

Never commit credentials, local environment files, generated build output, or vulnerability details. Report security
issues through the private process in [SECURITY.md](./SECURITY.md).

Maintainers must use the repository release workflows described in [docs/releasing.md](./docs/releasing.md). Local npm
publishing, production tags outside the protected release process, and token-based fallback publishing are not accepted.

## Code ownership

[.github/CODEOWNERS](./.github/CODEOWNERS) assigns owners per path. An ownership-gate required status check evaluates
each changed file against it and reports one red-or-green signal on the pull request. The check never approves on
anyone's behalf; when it is red, its summary names which files still need whose approval. Every rule carries a mode
declared in [.github/ownership-modes.json](./.github/ownership-modes.json), and a rule with no mode entry is treated as
`gate`, so forgetting to declare a mode fails safe.

- `gate`: mutual review. An approval is required from an owner other than the author; there is no author
  self-exemption. This is the default, so any path not explicitly carved out is gated, including any directory added in
  the future.
- `territory`: if the author is one of the rule owners they may merge on green CI with no approval; any other author
  needs an approval from one of those owners.
- `exempt`: the rule deliberately lists no owners. Matching files require no approval and do not auto-request a
  reviewer.

`apps/web` is exempt. Web changes from anyone with write access merge on green CI with no approval and no automatic
reviewer request. That is roughly a quarter of the tracked files but the majority of the change volume — 173 of the
repository's first 290 commits touched `apps/web` — so in day-to-day terms most of what members write here carries no
human-review requirement. It is a deliberate trade for iteration speed, and CI plus after-the-fact review are what stand
behind it.

Markdown outside `apps/web` is `territory` with a wider owner pool of yuezengwu, bestony, Gandy2025, and liuchao-001,
except for the root policy and agent-instruction files: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, and
the Chinese mirrors of the last two. Those are pulled back into the gate, because agent-instruction files change what
agents in this repository do and are behavior rather than documentation, and `CONTRIBUTING.md` is where this policy
itself is written down. Four routine chore paths are `territory`: `pnpm-lock.yaml`, `.editorconfig`, `.gitignore`, and
`LICENSE`. `packages/server/drizzle/` carries a defensive `gate` pin so irreversible migrations stay mutually reviewed.
Everything else is gated: the packages, `apps/cli`, `.github`, `scripts`, `e2e`, root build and quality-gate
configuration, and any directory added in the future.

Two rules apply on top of the per-file result. When the pull request author has no write access to the repository, as
an outside contributor, from a fork, or as a bot including dependabot, the pull request additionally needs an approval
from at least one owner named anywhere in `.github/CODEOWNERS`, whatever files it touches; the `apps/web` exemption
applies only to people with write access. Approvals are also not dismissed on a new push, so an approval obtained before
a later push still counts, and the ownership gate does not close that gap either. Do not assume the check covers it.

Relaxing the policy requires a reviewed change to `.github/CODEOWNERS`, which is itself gated. Ownership is derived from
change history and recalculated monthly.
