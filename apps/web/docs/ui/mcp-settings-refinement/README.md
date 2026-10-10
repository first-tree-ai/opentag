# MCP settings refinement

These screenshots show the current React components after reconciliation with the MCP management journeys on `main`. They use disposable sample data in a local preview, not a signed-in provider account.

- [Desktop settings (1440 × 900)](settings-desktop.jpg)
- [Desktop authentication (1440 × 900)](authentication-desktop.jpg)
- [Settings (320 × 640)](settings-320.jpg)
- [Authorization required (320 × 640)](disconnected-320.jpg)

The settings page keeps the Server address label, removes the redundant Agent scope sentence and Server information disclosure, and uses consistent 44 px navigation rows with restrained hover backgrounds. Back returns to the parent; Close and Escape dismiss the entire flow. Drafts, disclosure state and scroll positions survive returning from child dialogs. Dirty connection settings must still be saved before authentication.

Authentication reserves space for its method-specific content, so switching between browser sign-in, a token and no authentication leaves the dialog position and footer unchanged. Settings and authentication share a top anchor and scroll their body when viewport space is limited. Tools uses the initial list size with a minimum list area, caps at the remaining viewport height, and keeps its height while filtering.

Browser layout checks covered 320, 390, 768 and 1440 px widths, a short viewport, connected and authorization-required settings, header mode switching, all three authentication methods, Tools filtering and empty results. At 320 px, expanded settings scroll internally and preserve the footer. The current 1440 px authentication dialog measured the same top and height for all three methods; Tools kept its dimensions for a no-match query.

Before reconciliation, a separate local end-to-end run exercised the actual application, Fastify, PostgreSQL and a controlled MCP/OAuth provider: save/cancel, header modes, token authentication, browser OAuth, draft rebasing, tool refresh/search, long lists and removal. That provider used client-ID metadata documents. Real Notion/Linear authorization and dynamic client registration (DCR) were not validated. The independent review's existing DCR registration-binding finding remains outside this change.
