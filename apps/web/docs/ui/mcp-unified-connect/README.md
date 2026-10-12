# Unified MCP Connect validation

The production change is confined to Web connection interactions. It uses the existing Agent-scoped authorization,
OAuth, binding, and probe APIs without changing API contracts, database schemas, or credential ownership.

## Browser evidence

- [320px](./bearer-320.png), [390px](./bearer-390.png), [768px](./bearer-768.png), [1440px](./bearer-1440.png).
- Credential input receives focus. Enter submits; Escape cancels and returns focus to the retained Server row.
- The credential dialog has no authentication method selector. Settings still offers OAuth, bearer, and none.
- The dialog and Connect button fit the viewport, with no horizontal overflow and no axe violations.
- Disabling displays only Disabled and re-enabling retains the saved authorization method.

## Connection evidence

`e2e/tests/mcp-connect.smoke.spec.ts` checks real OpenTag API/storage/probe behavior against a local HTTP MCP/OAuth peer:
OAuth success, denied consent, failed token exchange and reconnect; invalid bearer credentials and replacement;
anonymous tool-probe failure and retry. Each retry retains the original Server binding.

A separate group compares Add, Discover, and row Connect for the same configured service using browser-intercepted
MCP management responses. These tests establish UI routing and definition reuse, not a third-party integration.
`mcp-auth-rejection.spec.ts` additionally checks actual local HTTP 401/403 responses.

No real third-party account authorization was performed. Existing user preview data and the server on port 8186
were preserved. Local verification used a disposable PostgreSQL database, isolated test accounts, and ports 8192/8193.
