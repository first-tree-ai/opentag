# Context local authority: browser verification

October 29, 2026, based on `e834bb43859c52a17e9c28d3ff4caa3470d2241c`.
Supports the [Context verification record](../../verification/context-tree-integration.md).

The only rendered change is the existing English/Chinese disconnect explanation: remote
sync and publication stop, while retained local content remains usable for connected trees.
Pages, buttons, dialogs, navigation, and interaction stay the same.

Three existing Chromium smoke tests passed with zero retries against the built Web/Server
and disposable PostgreSQL. GitHub state is fixture data, including the `@octocat` identity;
no live OAuth grant was revoked. Checks cover cancellation without mutation, confirmed
disconnect, Cancel focus, help dismissal, axe accessibility, and horizontal overflow at
320, 390, 768 and 1440px. English desktop and Chinese 320px dialog captures were inspected.

```bash
pnpm --filter @opentag/e2e exec playwright test --project=smoke --workers=1 --retries=0 \
  tests/github-account-review.smoke.spec.ts \
  --grep 'disconnecting the Context Tree|Chinese GitHub management|active GitHub surface'
```

No reusable UI block, theme value, layout or CSS exception was introduced.

- [English desktop confirmation](disconnect-en-1440.png)
- [Chinese narrow confirmation](disconnect-zh-320.png)
