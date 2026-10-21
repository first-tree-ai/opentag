# GitHub OAuth cutover: review and verification

Supports the [GitHub platform integration contract](../../docs/system/capabilities/github-platform-integration.md).
Recorded on October 21, 2026. The reviewed implementation is based on `2d24de50f09da8048b11dd8a499fce209ee2cec6`.

## Review scope and corrections

A separate review pass checked the migration, OAuth exchange, client/user/scope validation, encrypted identity,
refresh CAS, runtime credentials, retired routes, repository discovery and current-main integration.
It found and corrected the following before PR creation:

- The original implementation predated 53 main commits. Rebase retained main's native Git/REST/GraphQL forwarding,
  current account UI and discovery authorization fences; it did not restore removed Session/Tree publication policies.
- Migrations 0063 and 0064 were already occupied. Cutover is now 0065, with a new snapshot derived from 0064, journal/hash
  entry and migration count 66. Only `github_connections` changes; historical migration SQL/hashes remain intact.
- The API/UI fixtures and native-proxy workflow used retired installation contracts or a deleted test file.
- Browser assertions still referenced old empty guidance or measured contrast during entry transitions.
- The migration regression selected the last migration. It now selects the named cutover entry, so later migrations
  do not silently change its historical fixture.

No unresolved blocking issue was identified in this pass. This is local code-review evidence, not human approval,
CI success, deployment or production acceptance.

## Data and authorization boundaries

The approved one-time migration adds only `oauth_client_id`, retains `app_id` and historical rows, and updates old current
App rows to revoked while clearing credentials, OAuth flows and worker claims. Shape and uniqueness constraints reject
old-row resurrection, mixed identities and duplicate current OAuth connections. No row deletion or field rename occurs.

The isolated PostgreSQL regression covers all five legacy lifecycle states, pre-commit DDL/UPDATE rollback, preservation
of history/UUIDs, old selector/worker isolation, new connection uniqueness and invalid application shapes. Retired v1
callback/disconnect/webhook API tests verify no new OAuth mutation. Real existing users and old GitHub grants were not
revoked. After a committed cutover, old App binaries cannot restore cleared bindings; recovery requires the OAuth version.

## Local validation

| Check | Result |
| --- | --- |
| `pnpm check`, `pnpm build`, `pnpm typecheck`, E2E TypeScript | Passed |
| Shared package | 47 files, 742 tests passed |
| Affected Web account/discovery tests | 6 files, 69 tests passed |
| Server OAuth/config/management/refresh/Tree/native proxy tests | 16 files, 383 passed, 2 Linux-only cases skipped on macOS |
| Complete PostgreSQL integration selection, one worker | Initial run: 66 files passed; one file could not import Shared while a concurrent build replaced its output, and one collaboration case timed out. Both affected files then passed all 42 tests at the unchanged default timeout. All 68 files / 926 distinct cases have passing evidence across the run and targeted retry. |
| Named cutover migration regression after its test-only correction | 6 passed |
| Linux Client native Git/gh, Cloud bridge and credential relay | 4 files, 54 passed |
| Linux Server native gh, provider adapter and execution credentials | 3 files, 78 passed, including Cloud downloads through the full provider channel |
| Built-app GitHub browser smoke | 16 passed; [UI evidence](../web-ui/github-oauth-cutover/README.md) |

Linux uses an isolated amd64 Node 24 container, Git 2.47.3, pinned gh 2.100.0 and fake upstream credentials. The first
Linux Server attempt could not execute gh as the unprivileged Cloud fixture user because the binary lived in the private
results directory. Installing that same binary at a traversable `/usr/local/bin/gh` resolved it. No product permission was
relaxed. The macOS host's older gh 2.91.0 was replaced for validation only by the checksum-verified pinned gh 2.100.0.
The separate Server Cloud native-Git case remains skipped locally; Client Cloud native Git and Server Local native Git
passed. CI owns the complete OS matrix and must pass before merge.

Validation scope follows DEVELOPMENT.md: the changed contract owners and affected consumers were checked, plus the full
PostgreSQL selection required for a migration. The whole monorepo unit suite, full browser journey project and Agent Runtime
coverage were not rerun on this rebased implementation; the covered Client runtime implementation did not change relative
to main. Historical full-suite results from the pre-rebase implementation are not current-head evidence.

## Earlier live-provider evidence

A newly created test OAuth App, separate grant and isolated database completed code/PKCE authorization, client/user/scope
validation and actual maintenance-worker refresh. Native git clone/fetch/push and gh repository/PR reads, creation and
closure succeeded on an explicitly authorized test branch. The disposable test PR was closed without merging.

Two disposable cloud instances then reused the test credential with new machines/HOMEs; a trusted parent process refreshed
it with the new API client, and local reuse after cloud refresh succeeded. The old access token returned 401. Local and
cloud egress differed; the two cloud instances shared an egress IP. No organization IP-policy change was simulated.

These earlier checks establish OAuth credential and native CLI capability, not a complete deployed candidate Server/Runner
workflow. Current product proxy behavior is checked separately by offline native regressions. No new real authorization or
provider mutation occurred during this review. Raw logs, private credentials and machine-specific evidence stay outside Git.
