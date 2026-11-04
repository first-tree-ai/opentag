# Local PostgreSQL reuse and disposal

Ordinary local Server integration fixtures use one PostgreSQL 17 instance and one logical `opentag` database.
The instance, database, application data, and migration ledger survive fixture shutdown. Fixtures use an advisory
lock to serialize complete suites across processes and worktrees, and local Vitest defaults to one worker.
Individual tests retain their explicit data-reset operations when they need a known fixture.

The default instance is `opentag-local-postgres`, backed by the named volume `opentag-local-postgres-data` and
published only at `127.0.0.1:5432`. An existing default `opentag-postgres-1` development Compose service is reused.
Migration-history tests, version-specific tests, and fault tests that require exclusive ownership of all database
connections use disposable fixtures. CI and remote Docker retain disposable fixtures.

The development commands and lifecycle are documented in [the development guide](../../DEVELOPMENT.md#targeted-commands).

## Regressions covered

- Repeated fixture acquisition retains the same container, logical database, and a previously inserted row.
- A second process blocks until the first fixture releases its advisory lock.
- Killing a lock owner with SIGKILL releases the lock while retaining PostgreSQL and its data.
- Concurrent first starts converge on a single Docker container name.
- A pre-existing development Compose database is reused; unrelated containers are not adopted.
- CI, remote Docker, explicit image versions, and explicit disposable fixtures keep their disposal behavior.
- A failed migration releases the shared lease rather than stopping the persistent server.
- Manual E2E PostgreSQL teardown removes the container and its anonymous data volume with `docker rm -f -v`.

## Validation

Local validation used Node 24.20.0, pnpm 10.12.1, Vitest 5.0.1, and Docker Desktop.

- Focused database-fixture unit selection: 25 passed.
- Docker-workflow and container PostgreSQL TCP-probe script selection: 19 passed.
- Representative ordinary integration selection: 31 passed.
- Complete local integration selection: 125 files and 1,402 cases exercised; initially 1,397 passed and five failed.
  The zero-backend Server-process fixture was moved to explicit disposable mode, its Web build prerequisite was
  prepared, and all four cases passed. The query-plan fixture now supplies reported history, refreshes its own
  statistics, and scopes its planner setting to one transaction; both cases passed on the reused database.
- Real two-process data-retention, serialization, and killed-owner recovery probe: passed.
- Real disposable E2E container and anonymous-volume removal probe: passed.
- Server type check, Server/CLI/Web and dependency builds, and repository checks passed.

The full selection's initial failures are retained as evidence; targeted correction runs are not presented as a
second complete green run. Fresh CI and current-head review remain required before merge. Product schema and
migrations are unchanged. No production operation, deployment, or real external-provider acceptance was performed.
