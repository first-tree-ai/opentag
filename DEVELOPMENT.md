# OpenTag development

[简体中文](./DEVELOPMENT.zh-CN.md)

## Prerequisites

- Node.js 22.13 or newer on 22.x, Node.js 24.x, or Node.js 26.x (use the latest patch; Node.js 24 is primary)
- Corepack and pnpm 10.12.1
- Docker with Compose support, only when running the local PostgreSQL service

## Setup

```bash
corepack enable
pnpm install
```

The repository pins pnpm in `package.json`. Do not use npm or Yarn to update dependencies.

## Validation

```bash
pnpm check
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @opentag/server test:integration
```

Use `pnpm lint` for lint-only feedback. Use `pnpm format` to apply Biome formatting.

The required pull request check is the stable `CI` fan-in job. It covers the commands above, source and staging CLI
tarball installation, a production-container health smoke, and the supported Node.js lines. Full validation and releases
run on Node.js 24. Compatibility jobs run `pnpm check:node-compat` on the exact Node.js 22.13.0 floor and the latest
Node.js 26 release; that command builds, tests, and installs the packed CLI. Node.js 23 and 25 are end-of-life and are not
supported. To exercise the current source tarball locally after a build:

~~~bash
node scripts/cli-pack-smoke.mjs \
  --channel source \
  --name open-tag \
  --version 0.0.1 \
  --binary opentag-dev
~~~

## Run the server and health-check path

Start PostgreSQL, configure the required database and JWT secret, then build and start the server. Migrations run before
the server listens.

```bash
docker compose up -d postgres
export OPENTAG_DATABASE_URL=postgresql://opentag:opentag@localhost:5432/opentag
export OPENTAG_JWT_SECRET=replace-with-at-least-32-random-characters
pnpm build
pnpm --filter @opentag/server start
```

The server listens on `http://127.0.0.1:8000` by default. In another terminal, run:

```bash
pnpm --filter open-tag start doctor
```

Use a different server URL with `--server-url` or `OPENTAG_SERVER_URL`:

```bash
pnpm --filter open-tag start doctor --server-url http://127.0.0.1:9000
```

## Local PostgreSQL

The local PostgreSQL service supports migration and authentication development:

```bash
docker compose up -d postgres
pnpm --filter @opentag/server db:migrate
docker compose down
```

The service exposes port `5432` and stores data in the `opentag-postgres-data` named volume.
The production server image does not bundle or start PostgreSQL. Set `OPENTAG_DATABASE_URL` to a separately managed
PostgreSQL instance when deploying it; the Compose service above is only a local development convenience.

To bootstrap an empty installation, set the required bootstrap fields and run the one-time admin command. It migrates an
empty database before creating the initial user, team, admin membership, and connect code.

```bash
export OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
export OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin
export OPENTAG_BOOTSTRAP_TEAM_NAME=example
export OPENTAG_BOOTSTRAP_TEAM_DISPLAY_NAME=Example
pnpm --filter @opentag/server bootstrap:admin
pnpm --filter open-tag start login <connect-code>
```

The source checkout is the `dev` channel. It exposes the `opentag-dev` binary when packed and defaults to
`~/.opentag-dev`; staging and production builds use `opentag-staging` / `~/.opentag-staging` and `opentag` /
`~/.opentag`. An explicit `OPENTAG_HOME` overrides the channel default.

After login, start the foreground daemon and inspect the user-owned Computer from another terminal:

```bash
pnpm --filter open-tag start daemon run
pnpm --filter open-tag start computer list
```

The daemon reuses the stable Computer ID stored in its home, creates a new process instance on every start, and connects
to `/api/v1/computer/ws`. Ctrl+C performs a clean shutdown; a second daemon using the same home is rejected. The CLI
uses `/api/v1/auth/...` and `/api/v1/me/...`; `/healthz` and `/readyz` remain unversioned deployment probes.

## Manage Agent configurations

An Agent belongs to a Team and is bound at creation time to one Computer owned by its manager. When the current user has
one Team and one Computer, both are selected automatically:

```bash
pnpm --filter open-tag start agent create \
  --name code-reviewer \
  --display-name "Code Reviewer" \
  --provider codex
pnpm --filter open-tag start agent list
```

Use `--team <canonical-name>` or `--computer <uuid>` when more than one choice is available. An offline Computer may be
selected because online presence is not Agent configuration state. Inspect and change the mutable display name with:

```bash
pnpm --filter open-tag start agent show <agent-id>
pnpm --filter open-tag start agent update <agent-id> --display-name "Reviewer"
pnpm --filter open-tag start agent delete <agent-id>
```

Updates use revision compare-and-swap and never overwrite a concurrent change automatically. Deletion is a server-side
soft delete and is idempotent for the Agent manager or a Team admin. `claude-code` is an accepted configuration value,
but its runtime adapter and all Session/Turn delivery remain future work.

The four `OPENTAG_BOOTSTRAP_*` values are inputs to this one-time command only; the running server does not read them.
The bootstrap email is account profile data, not an email/password credential. The current connect-code flow resolves a
stable user ID and then uses the provider-neutral token issuer. Future Google or OIDC identity resolvers can join at that
boundary without changing JWT claims or team authorization; active memberships are always loaded from PostgreSQL.

## Environment variables

Copy `.env.example` only when you need local overrides. Environment files are not loaded automatically by the current
processes.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENTAG_HOST` | `127.0.0.1` | Server listen host |
| `OPENTAG_PORT` | `8000` | Server listen port |
| `OPENTAG_SERVER_URL` | `http://127.0.0.1:8000` | CLI doctor target |
| `OPENTAG_DATABASE_URL` | none | Required PostgreSQL connection URL |
| `OPENTAG_JWT_SECRET` | none | Required access-token signing secret; at least 32 characters |
| `OPENTAG_AUTO_MIGRATE` | `true` | Run checked-in migrations before listening |
| `OPENTAG_ACCESS_TOKEN_TTL_SECONDS` | `900` | Access-token lifetime |
| `OPENTAG_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh-JWT lifetime |
| `OPENTAG_HOME` | channel-specific | CLI credentials, Computer identity, and daemon ownership directory (`~/.opentag-dev` in source) |

If `doctor` fails, its error category distinguishes configuration, network, HTTP, and invalid-response failures. Confirm
the server is running and that the configured URL points to its base address.

## Releases

Release publishing belongs to GitHub Actions and npm trusted publishing. Never publish either channel from a maintainer
machine and never add a long-lived npm token to the repository. See [docs/releasing.md](./docs/releasing.md) for channel
identities, release guards, package smoke checks, and recovery steps.
