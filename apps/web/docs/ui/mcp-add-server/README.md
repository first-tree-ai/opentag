# Add custom UI evidence

The current UI uses Connectors, Add custom, and Discover. Existing screenshots record the UI before this rename; the MCP protocol and page URL remain unchanged.

These screenshots come from `e2e/tests/mcp-add.spec.ts`, using the built application and fictional MCP fixtures.
MCP management responses and provider consent are simulated; these tests do not authorize a real provider account.
The spec is included in the smoke project so the Browser Smoke gate runs the Add custom layout and interaction checks.

`e2e/tests/mcp-auth-rejection.spec.ts` additionally runs the real management API and a local HTTP peer.
Both 401 and 403 are passed through transport, probe persistence, and the browser Add flow: anonymous
access reaches the fixture OAuth sign-in page; a rejected bearer key stays editable with its specific error.
This covers the web/server rejection contract without authenticating against an external provider.
The real-HTTP rejection spec remains in the journey project and must be run separately from Browser Smoke.

- [Desktop authentication](./authentication-desktop.png): API key appears only after Connect requires it.
- [320px authentication](./authentication-320.png): the dialog remains within the viewport and preserves focused input borders.
- [Desktop loading](./loading-desktop.png): the loading label stays on one line and the footer remains in place.
- [Desktop shortcuts](./shortcuts-desktop.png) and [320px shortcuts](./shortcuts-320.png): four equal-width desktop
  shortcuts or two full-width mobile shortcuts remain visible.
- [Saved services](./saved-services-desktop.png) and [320px saved services](./saved-services-320.png): recognizable
  service names remain readable in text-only buttons, with selection conveyed by a subtle background, border and
  heavier name. [Focused desktop dialog](./picker-desktop.png) and [focused 320px dialog](./picker-320.png) show the same state.
- [All servers](./all-servers-desktop.png) and [320px all servers](./all-servers-320.png): View all opens a searchable,
  bounded list while keeping the header and URL field in place.
- [Desktop sign-in error](./sign-in-error-desktop.png) and [320px sign-in error](./sign-in-error-320.png):
  feedback stays below the URL and above saved servers, without clipping or overlapping either.

The page preloads saved servers before enabling Add custom, so first use and reopening choose the same compact size.
The picker offers only services that were absent from this Agent when the dialog opened, regardless of an existing
binding's enabled or authentication state. Those bindings continue to be managed from the connector list. The complete
account pool remains available to the unchanged connection logic for URL matching and retry; only picker presentation
is filtered. The opening filter stays stable when an in-progress attempt creates a binding, so error recovery does not
remove the selected choice or resize the dialog. No available choices means no picker heading and URL-only sizing.
Desktop height is 256px for URL-only entry, 336px for one row of shortcuts or an API key, and 384px for two rows.
At widths up to 600px, shortcuts use one column: one server retains 336px, while two visible servers use 408px;
API key entry uses 352px. View all explicitly expands to 480px. The opening top anchor stays fixed through selection,
key collection, and expansion, and every height is bounded by the remaining viewport. Explicit steps animate only
the bottom edge over 160ms, with no animation when reduced motion is requested. Loading and errors retain their height.

The lightweight heading reads “Or choose a connector” (“或选择已有连接器”). At most four available
recent services appear on desktop and two on mobile, with the selected service kept visible. Default choices contain
only their names: no logos, URLs, Added labels or check icons. Selection retains `aria-pressed` and uses the existing
background and border treatments plus a heavier name. The caption uses the secondary text size and compact action
spacing to keep it on one line at 320px, including alongside View all. Long names truncate with a full-name title.
View all appears when services exceed the visible limit and expands in place with search and a scrolling result list.
Its count, shortcuts, search and dialog size all use the same available-service subset; expanded rows include URLs.
API key collection replaces shortcuts and sits 24px below the URL, with feedback below the key.
URL validation and connection feedback share a reserved line below the URL; longer feedback can wrap naturally.

Browser tests verify preloading, consistent first-use geometry, stable header and URL positions through explicit steps,
and unchanged geometry through connection loading and errors. They cap the gap between the API key and footer at 64px
and between the URL and API key inputs at 56px. They check the full bounds of visible shortcuts and the last expanded
result against clipping ancestors, including long names at 320×480, and verify readable short names and equal shortcut
dimensions using catalog service fixtures. They also verify mounted services are excluded, an entirely mounted pool
uses the compact URL-only view, default choices contain no images or SVG icons, and selection preserves geometry.
Unit tests cover connected, disabled and unauthenticated mounted services, filtered counts and search, and late pool loading.
They also cover strict URL input,
per-Agent authentication, retry without duplicate creation, OAuth cancellation, Escape focus return, and axe checks.
Verified viewports are 1440×720, 768×900, 390×844, 320×720, and 320×480.

Sign-in startup failures use a short retry message rather than directing users to unspecified provider setup
instructions. No provider admission status is inferred from a generic OAuth failure; these changes do not alter
OAuth discovery, registration, or per-Agent credential storage.

The connector list page retains its existing layout. See [the integration design](../../../../../docs/design/mcp-server-integration.md)
for the connection flow and existing API limitations.
