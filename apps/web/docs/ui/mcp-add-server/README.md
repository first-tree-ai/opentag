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
- [Desktop shortcuts](./shortcuts-desktop.png) and [320px shortcuts](./shortcuts-320.png): two complete rows remain visible.
- [Desktop sign-in error](./sign-in-error-desktop.png) and [320px sign-in error](./sign-in-error-320.png):
  feedback stays below the URL and above saved servers, without clipping or overlapping either.

The dialog reserves 416px for two rows of saved shortcuts, or 352px if the server pool is already known to be empty
when it opens. Its opening size stays fixed even when an initially unknown pool resolves to empty. View all explicitly
expands it to 480px with a stable header and URL field; selection restores the opening height. All sizes are bounded
by the viewport. API key collection replaces the shortcut area, with feedback below the key. URL validation and
connection feedback share one two-line area below the URL when a key is not requested.

Browser tests verify identical opening geometry through account loading, selection, authentication, connection
loading, and errors, and cap the gap between the API key and footer at 64px. They check the full bounds of every
shortcut against clipping ancestors, including long names and an unwrapped Added label at 320×480.
They also cover strict URL input,
per-Agent authentication, retry without duplicate creation, OAuth cancellation, Escape focus return, and axe checks.
Verified viewports are 1440×720, 768×900, 390×844, 320×720, and 320×480.

Sign-in startup failures use a short retry message rather than directing users to unspecified provider setup
instructions. No provider admission status is inferred from a generic OAuth failure; these changes do not alter
OAuth discovery, registration, or per-Agent credential storage.

The MCP list page retains its existing layout. See [the integration design](../../../../../docs/design/mcp-server-integration.md)
for the connection flow and existing API limitations.
