# Agent status layout verification

Supports the [Overview design contract](../../../docs/system/web/design.md).

## Scope

The status card retains two sections and the original healthy two-line layout in all dependency states.
Runtime exceptions replace the Computer status instead of introducing a third section. The selected runtime
Provider remains visible after the Computer identity. Existing English and Chinese status values are unchanged.
Narrow cards omit the platform and truncate long names; primary status text remains complete, taking priority
over the static section name and recovery arrow. Complete metadata is included in accessible row names and
available through the details popover or recovery destination. Paused Agents open the existing runtime recovery
guidance in the popover instead of linking to setup, which accepts only active Agents. Whole-row targets preserve 44px touch
areas without adding layout height.

## Repeatable browser check

Install dependencies and build the two Web dependencies, then run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @opentag/shared build
pnpm --filter @opentag/mcp-presets build
OPENTAG_STATUS_BASELINE_REF=2d24de50f09da8048b11dd8a499fce209ee2cec6 node scripts/verify-agent-status-layout.mjs
```

The browser verification tool lives in `scripts/`, alongside manually-run tooling already excluded from
unit patch coverage. Captured screenshots and measurements remain here under `testing/`; the unit coverage
threshold and production-source coverage rules are unchanged.

The script builds an isolated page containing both the actual changed component and the original component
from the specified Git revision. Both use the repository's real fonts, theme, Tailwind output, and status
projection. No backend, database, external Provider, or credentials are used. Temporary sources and the fixture
build are removed on completion. The validation-only bundle contains both revisions, so its build omits the
application entry-size gate; the normal Web build separately retains and passes that gate.

The baseline uses a short Computer identity that fits its original identity line. Long-name scenarios check
that the new card retains that two-line footprint instead of growing as text wraps. This deliberately measures
the original compact healthy composition, rather than preserving arbitrary height caused by a long name.

The check covers 31 scenarios at 320, 390, 768, and 1440px in both English and Chinese (248 comparisons):

- healthy; runtime checking, missing installation, sign-in, unavailable, and unconfirmed;
- offline, unreadable, and unassigned Computer;
- unconfigured, provisioning, permission-required, failed, disconnected, checking, and unreadable messaging;
- failed delivery, a paused Agent with a runtime failure, and long identities;
- all five runtime failure/checking states for Codex, Claude Code, and Pi.

Every comparison requires two sections, height equal to the original healthy card, an unchanged relative
divider position, a visible Provider, no page overflow, and targets at least 44px tall. Each primary status label
must have `scrollWidth <= clientWidth` and remain inside its row, including the longest Claude Code labels. The full-name popover
is checked for content, unchanged card geometry, Escape dismissal, and returned keyboard focus. Axe checks
cover healthy and actionable cards in both languages at each width.

## Recorded validation

- The full Web suite exercised 2,168 tests across 172 files: 2,167 passed, with one catalog-key ordering
  failure. After correcting only that ordering, all three catalog tests passed on a focused rerun.
  The full run includes the Kumo contract, paused-state recovery, and empty-metadata accessibility assertions.
- Web type check and production build passed.
- `pnpm check` passed, including Context Tree verification; existing repository lint warnings remain.
- Browser comparisons passed all 248 cases. The isolated card measures 175px on desktop and 167px below
  the existing padding breakpoint, matching the original healthy two-line card at those widths. These are
  measured results, not new fixed-height declarations.
- Screenshots and raw measurements are in [output/](output/). Chromium screenshots show the rendered component,
  rather than a design mockup.

Backend integration and the full serial E2E journey were not run: the change is bounded to Web presentation,
existing navigation destinations, and layout. These targeted checks do not establish that CI is green.
