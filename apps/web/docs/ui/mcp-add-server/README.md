# Add custom UI evidence

These screenshots come from `e2e/tests/mcp-add.spec.ts`, using the built application and fictional MCP fixtures.
MCP management responses and provider consent are simulated; these tests do not authorize a real provider account.
The spec is included in the smoke project so the Browser Smoke gate runs the Add custom layout and interaction checks.

`e2e/tests/mcp-auth-rejection.spec.ts` additionally runs the real management API and a local HTTP peer.
Both 401 and 403 are passed through transport, probe persistence, and the browser Add flow: anonymous
access reaches the fixture OAuth sign-in page; a rejected bearer key stays editable with its specific error.
This covers the web/server rejection contract without authenticating against an external provider.
The real-HTTP rejection spec remains in the journey project and must be run separately from Browser Smoke.

- [Desktop picker](./picker-desktop.png) and [320px picker](./picker-320.png): configured connectors are initially
  collapsed behind one lightweight disclosure. There are no default shortcut cards or advanced settings.
- [Desktop configured connectors](./configured-desktop.png) and [320px configured connectors](./configured-320.png):
  opening the disclosure shows every available connector in a bounded, scrollable list with names and URLs, without search.
- [320px Chinese picker](./picker-zh-320.png) and [320px Chinese configured connectors](./configured-zh-320.png):
  translated counts and selection labels use the same compact flow.
- [Desktop authentication](./authentication-desktop.png) and [320px authentication](./authentication-320.png):
  API key appears only after Connect requires it and receives focus; the footer stays visible.
- [Desktop sign-in error](./sign-in-error-desktop.png) and [320px sign-in error](./sign-in-error-320.png):
  feedback stays below the URL and above the collapsed picker, without clipping or overlapping either.
- [Desktop loading](./loading-desktop.png): the loading label stays on one line and the footer remains in place.

Older shortcut, saved-services, and all-servers screenshots in this directory record the previous picker UI.

The page preloads saved servers before enabling Add custom, so first use and reopening choose the same compact size.
The picker offers only services absent from this Agent when the dialog opened, regardless of an existing
binding's enabled or authentication state. Those bindings continue to be managed from the connector list. The complete
account pool remains available to the unchanged connection logic for URL matching and retry; only picker presentation
is filtered. The opening filter stays stable when an in-progress attempt creates a binding, so error recovery does not
remove the selected choice. No available choices means no disclosure and URL-only sizing.

The disclosure reads “Choose a configured connector (N)” (“选择已配置的连接器（N）”). It starts closed for any
number of choices. Opening it displays all available services in the existing order; there is no search input,
recent subset, View all, or threshold-dependent behavior. Selecting a row fills the URL, closes the list, and
returns keyboard focus to the disclosure without connecting. Its label becomes “Selected: {name} · Change”
(“已选择：{name} · 更换”). Reopening allows another selection, with the selected row retaining `aria-pressed`.
Rows contain only their names and URLs, without logos or check icons. Long names and addresses wrap naturally in the list; the selected disclosure label truncates with a full-text title.
Editing the URL clears selection and credentials. The count and list use the same available-service subset.

Desktop height is 256px for URL-only entry, 288px with the collapsed disclosure, and 336px for an API key.
At widths up to 600px, API key entry uses 352px and the collapsed disclosure uses 304px to accommodate wrapped text. Opening the list explicitly
expands to 480px. The opening top anchor stays fixed through selection, key collection, and expansion, and every
height is bounded by the remaining viewport. Explicit steps animate only the bottom edge over 160ms,
with no animation when reduced motion is requested. Loading and errors retain their current step's height.
API key collection replaces the picker and sits 24px below the URL, with feedback below the key.
URL validation and connection feedback share a reserved line below the URL; longer feedback can wrap naturally.

Browser tests verify preloading, consistent first-use geometry, stable header and URL positions through explicit steps,
and unchanged geometry through connection loading and errors. They cap the gap between the API key and footer at 64px
and between the URL and API key inputs at 56px. They check the full bounds of the disclosure and first/last expanded
results against clipping ancestors, including long names at 320×480. They also verify mounted services are excluded,
an entirely mounted pool uses the compact URL-only view, choices contain no images or SVG icons, selection collapses
the list, and focus returns to the disclosure. Unit tests cover connected, disabled, and unauthenticated mounted services,
filtered counts, full-list selection without search, late pool loading, strict URL input, per-Agent authentication,
retry without duplicate creation, and OAuth cancellation. Browser checks include Escape focus return and axe accessibility.
Verified viewports are 1440×720, 768×900, 390×844, 320×720, and 320×480.

Sign-in startup failures use a short retry message rather than directing users to unspecified provider setup
instructions. No provider admission status is inferred from a generic OAuth failure; these changes do not alter
OAuth discovery, registration, or per-Agent credential storage. Authentication method editing and advanced settings
remain in the connector Settings flow; Add custom does not introduce those controls.

The connector list page retains its existing layout. See [the integration design](../../../../../docs/design/mcp-server-integration.md)
for the connection flow and existing API limitations.
