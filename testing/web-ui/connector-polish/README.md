# Connector UI polish evidence

Updated: 2026-10-12.

These previews use the production React catalog cards, buttons, search field, category controls,
and bundled CSS/theme, with a narrowed catalog containing Tavily and Firecrawl. The page header is
composed beside the directory for copy review. These are component layout previews, not captures of
an authenticated application or a live provider connection; interactive preview callbacks are inert.

- [Desktop, 1440 × 900](./desktop.jpg)
- [Mobile, 320 × 900](./mobile-320.jpg)

Widths checked: 320, 390, 768, and 1440 px. No horizontal page overflow was observed. The directory
uses one column at 320/390 px and two columns at 768/1440 px. In the single-row preview, cards stay at
their natural content height; the list's minimum height leaves space beneath them. A separate
multi-row preview verified that the desktop list retains its bounded scrolling region.

The current entry labels are **Discover** and **Add custom**. The directory has no Agent scope footer.
Management card subtitles show the catalog's localized purpose description for known endpoints,
the user-supplied description for custom connectors, and the effective URL when no description exists.
Descriptions retain the existing single-line layout and full-text tooltip; the complete address remains
available in connector settings. The catalog previews above do not capture this management subtitle change.
Adding and authorizing a connector have no separate success or failure notification. The card
shows connection status; errors stay on the corresponding card or connection form with a retry
action. Unit tests verify the Connected state and OAuth return handling. Unit tests also cover the existing
keyboard/focus return journeys. Full application E2E validation was attempted but could not start
because the disposable PostgreSQL connection was reset.
