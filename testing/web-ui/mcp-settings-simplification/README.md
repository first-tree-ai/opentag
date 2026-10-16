# Connector Settings UI simplification

The current UI uses Connectors, Add custom, and Discover. Existing screenshots record the UI before this rename; the MCP protocol and page URL remain unchanged.

Captured from the actual Settings component in a production-bundled, temporary preview using
non-secret fixture data. The preview uses OpenTag's existing theme, components, styles, and English /
Chinese messages. It is not a live provider connection or a complete application journey. Screenshots and browser
observations are retained from the same Settings UI in #858; this PR narrows the backend scope
without changing that layout.

- `bearer-desktop.png`: API-key settings and directly editable extra headers at 1440px.
- `oauth-desktop.png`: OAuth advanced settings omit the unused API-key formatting fields.
- `bearer-320.png`: the same API-key settings at 320px.
- `bearer-zh-320.png`: Chinese copy at 320px with a 700px viewport height.

Browser checks covered OAuth, API-key, and anonymous connections at 320px, 390px, 768px, and 1440px.
There was no horizontal overflow and the footer stayed inside the viewport. Saving an empty prefix,
a different auth header, and deleting all extra headers produced the expected Agent-scoped patch;
reopening preserved the empty header list. Tab stayed in the dialog and Escape closed it. An axe
check of the Chinese mobile dialog reported no violations.

No new reusable component, theme value, or CSS exception was introduced.

The UI uses the existing Agent binding API and writes only changed fields. Database migrations,
Server inheritance and validation rules, Client code, and CLI behavior are unchanged.
