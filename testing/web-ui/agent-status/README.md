# Agent status layout verification

Supports the [Overview design contract](../../../docs/system/web/design.md).

## Scope

The status card retains two sections and the original healthy two-line layout in all dependency states.
Runtime exceptions replace the Computer status instead of introducing a third section. The selected runtime
Provider remains visible after the Computer identity. Existing English and Chinese status values are unchanged.
Narrow cards omit the platform and truncate long names; complete metadata is available through the healthy
row's popover or the actionable row's existing recovery destination. Whole-row targets preserve 44px touch
areas without adding layout height.

## Repeatable browser check

Install dependencies and build the two Web dependencies, then run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @opentag/shared build
pnpm --filter @opentag/mcp-presets build
OPENTAG_STATUS_BASELINE_REF=2d24de50f09da8048b11dd8a499fce209ee2cec6 node testing/web-ui/agent-status/verify.mjs
```

The script builds an isolated page containing both the actual changed component and the original component
from the specified Git revision. Both use the repository's real fonts, theme, Tailwind output, and status
projection. No backend, database, external Provider, or credentials are used. Temporary sources and the fixture
build are removed on completion. The validation-only bundle contains both revisions, so its build omits the
application entry-size gate; the normal Web build separately retains and passes that gate.

The baseline uses a short Computer identity that fits its original identity line. Long-name scenarios check
that the new card retains that two-line footprint instead of growing as text wraps. This deliberately measures
the original compact healthy composition, rather than preserving arbitrary height caused by a long name.

The check covers 23 scenarios at 320, 390, 768, and 1440px in both English and Chinese (184 comparisons):

- healthy; runtime checking, missing installation, sign-in, unavailable, and unconfirmed;
- offline, unreadable, and unassigned Computer;
- unconfigured, provisioning, permission-required, failed, disconnected, checking, and unreadable messaging;
- failed delivery, a paused Agent with a runtime failure, long identities, Claude Code, and Pi.

Every comparison requires two sections, height equal to the original healthy card, an unchanged relative
divider position, a visible Provider, no page overflow, and targets at least 44px tall. The full-name popover
is checked for content, unchanged card geometry, Escape dismissal, and returned keyboard focus. Axe checks
cover healthy and actionable cards in both languages at each width.

## Recorded validation

- Related Web tests: 104 passed across Agent home, Computers, Messaging, presentation, and App shell suites.
- Web type check and production build passed.
- `pnpm check` passed, including Context Tree verification; existing repository lint warnings remain.
- Browser comparisons passed all 184 cases. The isolated card measures 175px on desktop and 167px below
  the existing padding breakpoint, matching the original healthy two-line card at those widths. These are
  measured results, not new fixed-height declarations.
- Screenshots and raw measurements are in [output/](output/). Chromium screenshots show the rendered component,
  rather than a design mockup.

Backend integration and the full serial E2E journey were not run: the change is bounded to Web presentation,
existing navigation destinations, and layout. These targeted checks do not establish that CI is green.
