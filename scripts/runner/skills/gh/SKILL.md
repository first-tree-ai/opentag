---
name: gh
description: Use GitHub CLI for issues, pull requests, checks, and repository API operations.
license: Apache-2.0
metadata:
  author: opentag
---

# GitHub CLI

Use `gh --version` and `gh <command> --help` to discover the installed CLI.
Use `--repo <owner/repo>` when repository context is ambiguous. Inspect pull
requests with `gh pr view`, `gh pr diff`, and `gh pr checks`; use `gh api` for
API operations supported by the current task.

For authorized writes, prepare the exact content, apply the operation, and
reread the resulting state. Use a body file for multiline descriptions. Runtime
authentication must be supplied separately; report missing authentication
without printing tokens or creating an unrequested login flow.
