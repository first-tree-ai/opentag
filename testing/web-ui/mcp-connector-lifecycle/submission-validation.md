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
