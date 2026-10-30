# Context Tree GitHub MCP authorization: UI verification

Based on main `90dc62efe59245f7ee9ac3d23a67a94010ffdab5`, verified October 30, 2026.
Supports the [Context verification record](../../verification/context-tree-integration.md).

Three Chromium smoke tests pass with zero retries against the built Web app, Server, an
isolated PostgreSQL database and synthetic authenticated accounts. No live GitHub OAuth flow
is involved. The Account tests check both locales at 320/390/768/1440px, no page overflow,
axe accessibility, no legacy section or authorization control, and no legacy GitHub query.
Legacy management/callback endpoints return 410. The Memory test creates an Agent without a
GitHub connection and verifies its navigation, existing connect/create controls and accessibility.

The only structural UI change removes the independent Account GitHub section. Memory and
Connectors keep their existing pages/buttons. Context failure text points to the current
Agent's Connector, with specific disabled/unsupported messages. Unit tests exercise these
messages and retain existing form interaction coverage. No new block, CSS, theme or layout
exception is introduced.

```bash
pnpm --filter @opentag/e2e exec playwright test --project=smoke --workers=1 --retries=0 \
  tests/github-account-review.smoke.spec.ts
```

- [Account in English at 1440px](account-en-1440.png)
- [Account in Chinese at 320px](account-zh-320.png)
- [Existing Memory entry without GitHub authorization](memory-without-github.png)
