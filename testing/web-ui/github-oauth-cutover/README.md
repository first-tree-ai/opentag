# OAuth cutover: browser acceptance

Supports the [GitHub integration contract](../../../docs/system/capabilities/github-platform-integration.md) and
[cutover verification record](../../verification/github-oauth-cutover.md).

The built Web app, Server, browser authentication and isolated PostgreSQL are real. GitHub responses and authorization
navigation are controlled fixtures. This browser run does not modify a real GitHub grant or establish live OAuth acceptance.

All 16 GitHub smoke cases passed on October 21, 2026, using Chromium 151.0.7922.34 on macOS, against the implementation based on
`2d24de50f09da8048b11dd8a499fce209ee2cec6`.

- English/Chinese account and repository presentation; loaded, empty, read failure and retry states.
- Active identity, unavailable deployment, reauthorization, replacement, removal confirmation and cancellation.
- On-demand discovery, pagination and authorization-version isolation across account replacement.
- Unsaved profile draft preservation, failed-start cleanup and storage-failure feedback.
- Overflow checks at 320, 390, 768 and 1440px; keyboard focus, help dismissal and axe accessibility checks.
- Existing dialog transitions finish before contrast measurement. No colors, shared primitives or accessibility thresholds changed.

The first run found a stale empty-result assertion and two contrast measurements during the existing 150ms entry
transition. Updating the OAuth copy assertion and waiting for opacity 1 produced the complete passing run without retries.
Screenshots were visually inspected; they contain synthetic identities only.

## Screenshots

- [English account, desktop](account-en-1440.png)
- [Chinese empty repository guidance, 320px](repositories-zh-320-empty.png)
- [Chinese removal confirmation, 320px](remove-zh-320.png)
