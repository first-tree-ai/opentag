# Web UI contract: verification and acceptance

Test and acceptance material for [Web UI contract](../../docs/system/web/web-ui-contract.md).

## Verification and pull request evidence

Tests should cross the same interface as product callers:

- adapter and owned-block tests verify public behavior and accessibility semantics;
- static contract tests enforce the Kumo import, interactive-element, token, and stylesheet seams;
- feature tests cover domain states and user-visible outcomes; and
- Playwright checks representative keyboard, axe, responsive, and stable visual paths against local fixtures.

The pull-request Browser Smoke maps the four representative widths to stable acceptance paths rather than multiplying
every page by every viewport: 320px sign-in, 390px touch dialog behavior, the 768px Account layout transition, and the
1440px bounded desktop content frame. These checks enforce page-level overflow and axe acceptance; feature-specific
responsive tests remain responsible for intrinsically wide regions and specialized compositions.

When a pull request changes rendered UI, its `UI validation` section records desktop and mobile evidence, the states that
were exercised, keyboard or accessibility checks, and any new reusable block, theme value, or CSS exception. A change
that cannot render at one of the representative widths should state why rather than silently omitting that check.
