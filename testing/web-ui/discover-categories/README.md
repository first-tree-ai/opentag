# Discover categories and initial focus

Discover opens with focus on its heading. Loading the Account directory does not move focus to
search or interrupt a user's keyboard navigation.

The directory groups connectors into Docs & Knowledge, Communication, Projects, Web Search,
Design, Data & Analytics, and Developer Tools. Sales & CRM, Finance & Payments, and Automation
currently have one connector each, so their navigation entries are hidden. All 26 connectors remain
available in All and search. Category navigation appears when the full directory contains at least
two entries in that category, independently of search results or connection status. A restored
category that no longer has a visible navigation entry falls back to All.

Desktop uses compact category buttons. At widths of 600px and below, a category selector gives the
connector list more space. Both controls use the same selection and search behavior.

## Validation

The existing Playwright Discover authorization suite passed eight journeys at 1440px, 736px, and
320px. It verified heading focus on open, category selection, OAuth completion, cancellation,
retry, blocked-popup recovery, independent authorization while filtering, stable card geometry, and
no horizontal page overflow. The desktop
authorization journeys also passed the suite's automated accessibility scan. Widths of 390px and
768px and Chinese browser rendering were not separately checked.

Screenshots use production Web assets, an isolated local database, and synthetic MCP/OAuth API
responses. They show authorization waiting/preparation; they do not establish compatibility with
public providers.

- [Desktop, 1440px](./desktop-1440.png)
- [Mobile, 320px](./mobile-320.png)
