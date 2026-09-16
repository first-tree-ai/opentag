---
name: git
description: Use Git for repository inspection, changes, and history in the Runner workspace.
license: Apache-2.0
metadata:
  author: opentag
---

# Git

Use `git --version` and `git <command> -h` to check the installed CLI. Start with
`git status --short`, `git diff`, and `git log -5 --oneline` to understand the
checkout. Run commands in the intended repository or use `git -C <repo>`.

Preserve existing user changes. Keep commits focused, inspect the staged diff,
and follow repository instructions for validation. Use fetch, clone, commit,
or push when the task authorizes them. Do not print embedded credentials or
discard changes without authorization.
