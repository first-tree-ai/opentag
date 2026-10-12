# MCP Add server UI evidence

These screenshots come from `e2e/tests/mcp-add.spec.ts`, using the built application and fictional MCP fixtures.
MCP management responses and provider consent are simulated; these tests do not authorize a real provider account.

`e2e/tests/mcp-auth-rejection.spec.ts` additionally runs the real management API and a local HTTP peer.
Both 401 and 403 are passed through transport, probe persistence, and the browser Add flow: anonymous
access reaches the fixture OAuth sign-in page; a rejected bearer key stays editable with its specific error.
This covers the web/server rejection contract without authenticating against an external provider.

- [Desktop authentication](./authentication-desktop.png): API key appears only after Connect requires it.
- [320px authentication](./authentication-320.png): the dialog remains within the viewport and preserves focused input borders.
- [Desktop loading](./loading-desktop.png): the loading label stays on one line and the footer remains in place.

The compact dialog is 352px high. View all explicitly expands it to 440px with a stable header and URL field;
selection restores the compact height. Browser tests verify identical compact geometry through account loading,
selection, authentication, connection loading, and errors, and cap the gap between the API key and footer at 64px.
They also cover strict URL input,
per-Agent authentication, retry without duplicate creation, OAuth cancellation, Escape focus return, and axe checks.
Verified viewports are 1440×720, 768×900, 390×844, 320×720, and 320×480. Compact and explicitly expanded
sizes are bounded by the viewport, without intermediate breakpoints.

The MCP list page retains its existing layout. See [the integration design](../../../../../docs/design/mcp-server-integration.md)
for the connection flow and existing API limitations.
