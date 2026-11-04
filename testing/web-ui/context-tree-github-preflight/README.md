# Context Tree GitHub prerequisite check

Verified on November 4, 2026. Supports the
[Context Tree contract](../../../docs/system/capabilities/context-tree-integration.md)
and [GitHub authorization contract](../../../docs/system/capabilities/github-platform-integration.md).

The production `ContextTreeSettings` component was bundled with the Web's Vite configuration,
styles and light theme in an isolated fixture, then exercised with Chromium. Its API responses
were intercepted; no running Server, PostgreSQL, GitHub credential or external GitHub call was used.

For English and Chinese at 320, 390, 768 and 1440 pixels, all eight cases verified:

- Opening Connect checks availability and shows the missing Server OAuth configuration before any fields.
- The notice names the server administrator's next step without asking for repository details.
- After the fixture becomes ready, Retry issues a second GET and reveals the form with its first field focused.
- Cancel returns focus to the connection shortcut.
- Page and dialog have no horizontal overflow; axe reports no violations after the dialog animation settles.
- No write request or browser error occurs.

Screenshots: [English at 1440px](blocked-en-1440.png), [Chinese at 320px](blocked-zh-320.png).

Focused unit and API tests additionally cover both Connect and Create, Agent ownership, disabled
and unsupported authorization, read-only create restrictions, Local runtime capability, Cloud,
failed/older Server reads, cancellation with late responses, disconnect without GitHub, existing
revision checks and final authorization fences. The availability response accepts only readiness
and read-only state or a prerequisite failure; it rejects credential-shaped extra fields.

```sh
pnpm --filter @opentag/shared test src/__tests__/context-tree.test.ts
pnpm --filter @opentag/web test src/features/agents/agent-settings/context-tree-settings.test.tsx src/__tests__/api.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/context-tree-operation.test.ts src/__tests__/github-context-tree-operations.test.ts src/__tests__/agent-api.test.ts src/__tests__/context-tree-create.test.ts src/__tests__/agent-github-credential.test.ts --maxWorkers=1
```

The change adds an authenticated, uncached GET using the existing Agent configuration and MCP
credential readers. It changes no query, persistence, schema, OAuth flow or runtime protocol, so
no PostgreSQL integration run was needed. Shared/Web/Server type checks, affected builds and
`pnpm check` cover the cross-package contract and generated translations. These local fixtures
establish UI and authorization behavior, not deployed OAuth or live repository acceptance.
