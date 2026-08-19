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
export OPENTAG_ENCRYPTION_KEY=$(openssl rand -base64 32)
export OPENTAG_PUBLIC_URL=http://127.0.0.1:8000
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

Login installs and starts the user service on Linux and macOS. Inspect it and the user-owned Computer from another terminal:

```bash
pnpm --filter open-tag start daemon status
pnpm --filter open-tag start computer list
```

The daemon reuses the stable Computer ID stored in its home, creates a new process instance on every service start, and
connects to `/api/v1/computer/ws`. Manage it with `daemon install/start/stop/restart/status/uninstall`. `uninstall`
preserves credentials and Computer identity. Use `login --no-start` for credential-only setup; Windows services are not
supported in v0.1. Linux logs are available through `journalctl --user -u opentag-dev.service`; macOS logs are under the
channel home's `logs` directory. Optional `${OPENTAG_HOME}/daemon.env` must be a private regular file (mode `0600`) and
can provide service-only environment values without overriding pinned service settings. The CLI uses `/api/v1/auth/...`
and `/api/v1/me/...`; `/healthz` and `/readyz` remain unversioned deployment probes.

The dev service definition is `~/.config/systemd/user/opentag-dev.service` on Linux or
`~/Library/LaunchAgents/opentag-dev.plist` on macOS; the macOS wrapper is `${OPENTAG_HOME}/service/opentag-dev`.
Staging and production replace the suffix with their channel `serviceId` (`opentag-staging` or `opentag`). If login saves
credentials but service installation fails, fix the reported manager issue and run `opentag-dev daemon install`; do not
request another connect code.

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

## Google sign-in, Team membership, and Admin Web

Create a Google Web OAuth client whose callback is
`http://127.0.0.1:8000/api/v1/auth/google/callback`, then set `OPENTAG_GOOGLE_CLIENT_ID` and
`OPENTAG_GOOGLE_CLIENT_SECRET`. The Google configuration is validated before the server listens; `staging` and `prod`
require an HTTPS `OPENTAG_PUBLIC_URL`. Browser access and refresh JWTs stay in HttpOnly cookies, while browser mutations require a
same-origin request and the readable double-submit CSRF cookie.

For loopback-only development without Google credentials, explicitly enable the development bypass and select one
existing bootstrap user:

```bash
export OPENTAG_ENV=dev
export OPENTAG_DEV_AUTH_BYPASS_ENABLED=true
export OPENTAG_DEV_AUTH_EMAIL=admin@example.com
```

Both `OPENTAG_HOST` and `OPENTAG_PUBLIC_URL` must remain loopback addresses. The login page then shows
`Dev: bypass Google`. The callback resolves exactly one existing user by case-insensitive email and issues the normal
browser session; it never creates a user or Team and still rejects suspended users or users without an active
membership. Missing or duplicate email matches fail closed. The server refuses this configuration in `staging` and
`prod`.

`OPENTAG_ENV` is the only OpenTag environment and release-channel selector. `dev` selects local development behavior and
the `opentag-dev` binary, `staging` selects `open-tag-staging` / `opentag-staging`, and `prod` selects
`open-tag` / `opentag`. `NODE_ENV` may still be `production` in hosted Node.js processes, but it does not select OpenTag
packages or product security behavior. The server logs the resolved environment, public URL, package, and binary at
startup; it never infers the environment from the hostname.

Open `/admin/` for the Team view. On **Computers**, **Connect computer** mints a 15-minute, single-use code and copies the
server-authored install/login command. The page polls the current user's Computer list until the new daemon handshake
arrives. The Web never selects the npm package, binary, or Server URL itself. Use the CLI for membership and invitation
mutations:

```bash
pnpm --filter open-tag start team member list --team example
pnpm --filter open-tag start team member role <user-id> --role admin --team example
pnpm --filter open-tag start team member remove <user-id> --team example
pnpm --filter open-tag start team member restore <user-id> --role member --team example
pnpm --filter open-tag start team leave --team example
pnpm --filter open-tag start team invitation show --team example
pnpm --filter open-tag start team invitation rotate --team example
```

Invitation plaintext is recovered only for an authorized `show`/`rotate` response. PostgreSQL stores its SHA-256 lookup
hash and AES-256-GCM ciphertext. Generate `OPENTAG_ENCRYPTION_KEY` with `openssl rand -base64 32`; changing the key
without rotating existing invitations makes them intentionally fail closed.

## Environment variables

Copy `.env.example` only when you need local overrides. Environment files are not loaded automatically by the current
processes.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENTAG_HOST` | `127.0.0.1` | Server listen host |
| `OPENTAG_PORT` | `8000` | Server listen port |
| `OPENTAG_SERVER_URL` | `http://127.0.0.1:8000` | CLI doctor target |
| `OPENTAG_PUBLIC_URL` | none | Required public Server origin used for browser callbacks and invitation links |
| `OPENTAG_ENV` | `dev` | OpenTag environment/channel: `dev`, `staging`, or `prod`; hosted values require HTTPS |
| `OPENTAG_DATABASE_URL` | none | Required PostgreSQL connection URL |
| `OPENTAG_JWT_SECRET` | none | Required access-token signing secret; at least 32 characters |
| `OPENTAG_ENCRYPTION_KEY` | none | Required canonical base64-encoded 32-byte application encryption key |
| `OPENTAG_GOOGLE_CLIENT_ID` | none | Optional Google OIDC client id; requires the matching secret |
| `OPENTAG_GOOGLE_CLIENT_SECRET` | none | Optional Google OIDC client secret; requires the matching client id |
| `OPENTAG_DEV_AUTH_BYPASS_ENABLED` | `false` | Explicitly enable loopback-only development sign-in; requires the configured email |
| `OPENTAG_DEV_AUTH_EMAIL` | none | Existing unique bootstrap user selected by the development bypass |
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
