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
  --binary opentag
~~~

## Run the health-check path

Build the workspaces, then start the server:

```bash
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

PostgreSQL is reserved for upcoming persistence work; the current code does not connect to it or run migrations.

```bash
docker compose up -d postgres
docker compose down
```

The service exposes port `5432` and stores data in the `opentag-postgres-data` named volume.

## Environment variables

Copy `.env.example` only when you need local overrides. Environment files are not loaded automatically by the current
processes.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENTAG_HOST` | `127.0.0.1` | Server listen host |
| `OPENTAG_PORT` | `8000` | Server listen port |
| `OPENTAG_SERVER_URL` | `http://127.0.0.1:8000` | CLI doctor target |
| `OPENTAG_DATABASE_URL` | local PostgreSQL URL | Reserved for future persistence work |

If `doctor` fails, its error category distinguishes configuration, network, HTTP, and invalid-response failures. Confirm
the server is running and that the configured URL points to its base address.

## Releases

Release publishing belongs to GitHub Actions and npm trusted publishing. Never publish either channel from a maintainer
machine and never add a long-lived npm token to the repository. See [docs/releasing.md](./docs/releasing.md) for channel
identities, release guards, package smoke checks, and recovery steps.
