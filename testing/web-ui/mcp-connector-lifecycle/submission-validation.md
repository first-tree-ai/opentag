# Submission validation after synchronizing main

Validated on 2026-10-22 after fast-forwarding the branch to main revision
`54a3c87801aa00a413988d63188d530ebafa71f1`, which includes the Skill list controls from PR 988.
The connector changes applied without conflicts. Shared switch and dialog improvements remain intact.

## Automated checks

- `pnpm --filter @opentag/web test src/features/mcp src/ui/design-system.test.tsx src/__tests__/i18n-catalog.test.ts`:
  **30 files / 393 tests passed**.
- Web and E2E TypeScript checks passed.
- The normal Web build and the workspace build passed. The workspace build prepared the real
  Server and CLI needed by the repository browser harness.
- `pnpm check` and `git diff --check` passed before submission.

## Repository browser suites

Ran these existing suites under the smoke project with two workers:

- `mcp-add.spec.ts`
- `mcp-connect.smoke.spec.ts`
- `mcp-discover-authorization.spec.ts`
- `mcp-discover-continuation-smoke.spec.ts`
- `mcp-recovery-smoke.spec.ts`

The initial run passed **70 of 72** cases. Two assertions still selected superseded UI copy:
custom OAuth recovery selected Connect instead of Retry, and a blocked list row selected the
management-dialog wording instead of “Authorization page did not open”. Both selectors were
corrected. Each failed case then passed its own targeted rerun, with no product changes or retries
of the already passing cases. All 72 cases are accounted for; this is not a claim of a new single
72-case green run.

The harness used the production Web/Server build, a separate Compose project, a disposable
PostgreSQL database, and an isolated port. It exercised real MCP/OAuth loopback peers through the
actual Server APIs and persistence in `mcp-connect.smoke.spec.ts`; the remaining controlled browser
journeys retain their explicit MCP API fixtures while using real Account/Agent setup. It also ran
axe and overflow assertions. No live third-party credentials or production data were used.

Isolation for reproduction: `COMPOSE_PROJECT_NAME=opentag_mcp_lifecycle_e2e`,
`OPENTAG_POSTGRES_PORT=55441`, `OPENTAG_E2E_DATABASE=opentag_mcp_lifecycle_e2e`, and
`OPENTAG_E2E_PORT=28123`. The admin database URL must point to that disposable local PostgreSQL.
The harness cleaned up its database and container on completion.

Server/PostgreSQL integration and Agent Runtime coverage were not separately rerun because their
implementation and contracts are unchanged. CI must still pass its complete matrix before merge.
Earlier component/HTTP-fixture checks remain documented separately rather than being presented as
live provider acceptance.

## Review follow-up

The approved review identified four small improvements, now implemented:

- Disable other row recovery actions while a browser-owned connection attempt is active;
  clicking an apparently available action no longer silently does nothing.
- Keep Remove available for a persisted pending background probe. Only a live browser-owned
  operation or resumption locks its own removal control; a delayed refresh worker cannot trap a row.
- Include each connector name in recovery buttons' accessible names, preserving visible copy.
- Remove the three unused enable/menu/save-error messages from both catalogs and replace the
  stale test transcript with this review's actual scope.

The coverage workflow's only failing Web test was the initial Soul navigation query exhausting
Testing Library's default 1-second wait while the workspace shell was still loading. The test now
uses the existing bounded initial-load wait convention, without changing its assertions or the
application. The four Soul tests passed with root V8 coverage instrumentation.

The broader local run accounted for 399 cases: 398 passed, with one MCP first-render query also
exhausting its 1-second wait. After the same bounded wait adjustment, its owning 24-test page suite
passed on a targeted rerun. The two new regression tests cover concurrent row recovery and removal
of a background-pending connector. This is not a claim of a single green 399-case run.

Browser follow-up ran 27 cases from the real-API MCP connection and Discover continuation suites:
26 passed; the remaining list-retry case retained an old accessible-name selector. After updating
that selector, its targeted rerun passed. No application change was needed for that failure.
The journeys include OAuth continuation/cancellation, saved-credential retry, historical Resume,
keyboard operation, axe, and English/Chinese layouts at 320, 390, 768 and 1440 pixels. This uses the
same isolated local Server/PostgreSQL/MCP-peer harness described above, not live provider accounts.

Web/E2E type checks, the production Web build, and `pnpm check` passed. CI must validate the new
published revision before merge; previous approvals are not represented as reviews of this follow-up.
