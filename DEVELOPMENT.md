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
pnpm --filter @opentag/client test:agent-runtime:coverage
pnpm --filter @opentag/server test:integration
```

Use `pnpm lint` for lint-only feedback. Use `pnpm format` to apply Biome formatting.

The separate `Unit Coverage` workflow runs `pnpm test:coverage` against `main` every Monday at 03:17 UTC and can also be
started manually. It builds the workspaces and measures the offline unit tests for CLI, Web, Shared, Client, and Server,
then retains the unified report for 14 days. Run the command locally when changing the root coverage configuration or
investigating coverage gaps. The measurement includes production source files that tests do not import, but excludes
root `scripts/`, Server PostgreSQL integration tests, and Provider end-to-end tests. It is a baseline for finding and
prioritizing gaps, not a required pull request check, and does not yet enforce repository-wide or per-workspace coverage
thresholds. Add regression thresholds only after the measurement is stable across repeated runs.

Required pull request CI still runs all offline unit tests. Agent Runtime keeps its separate 100% gate in
`packages/client/vitest.agent-runtime.config.ts`, enforced by
`pnpm --filter @opentag/client test:agent-runtime:coverage`.

The required pull request check is the stable `CI` fan-in job. It covers the required commands above, source and staging CLI
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

To bootstrap an empty installation, set the required bootstrap fields and run the one-time bootstrap command. It migrates
an empty database before creating the initial Account and Account login code. Its current command name and
`OPENTAG_BOOTSTRAP_WORKSPACE_*` inputs also create the internal default Workspace and grant used as a compatibility seam
until Phase 2; they do not create product-level Workspace or Admin membership.

```bash
export OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
export OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin
export OPENTAG_BOOTSTRAP_WORKSPACE_NAME=example
export OPENTAG_BOOTSTRAP_WORKSPACE_DISPLAY_NAME=Example
pnpm --filter @opentag/server bootstrap:admin
./scripts/dev-install.sh
export PATH="$HOME/.local/bin${PATH:+:$PATH}"
opentag-dev login --server http://127.0.0.1:8000 -- <connect-code>
```

The source checkout is the `dev` channel. `scripts/dev-install.sh` builds the complete workspace, links the configured
dev binary to `~/.local/bin/opentag-dev`, verifies it, and reconciles an existing machine-credentialed daemon service. A first
install has no machine credentials, so service setup is deliberately deferred to `computer connect`; this matches the
published installer boundary without making the installer consume a connect code. Keep `~/.local/bin` first in `PATH`
so service reconciliation cannot select an older `opentag-dev` shim. The dev channel defaults to
`~/.opentag-dev`; staging and production builds use `opentag-staging` / `~/.opentag-staging` and `opentag` /
`~/.opentag`. An explicit `OPENTAG_HOME` overrides the channel default.

Account login stores only management credentials. Generate a Computer connection command from the Web's Agents area,
then run it on the execution host; `computer connect` stores an enrollment-scoped machine credential and installs or
restarts the user service on Linux and macOS. Inspect it from another terminal:

```bash
opentag-dev computer connect --server http://127.0.0.1:8000 -- <computer-connect-code>
opentag-dev daemon status
opentag-dev computer list
```

The daemon reuses the stable physical Computer ID in `${OPENTAG_HOME}/config/computer.json`, loads independent
enrollment credentials from `${OPENTAG_HOME}/config/computer-credentials.json`, creates a new process instance on every
service start, and opens one Runtime connection per enrollment. OpenTag Home is organized by lifecycle:

```text
${OPENTAG_HOME}/
├── config/
│   ├── credentials.json
│   ├── computer-credentials.json
│   ├── computer.json
│   └── daemon.env
├── data/
│   ├── runtime/
│   │   ├── workspace-states/<agent-key>.json
│   │   ├── session-bindings/<agent-key>/<session-key>.json
│   │   └── effective-snapshots/<agent-key>/<snapshot-key>.json
│   └── workspaces/<agent-key>/  # New Agent cwd and writable root
├── state/
│   ├── daemon/owner.json
│   └── service/
│       ├── operation.json
│       ├── target-operation.json  # default channel Home only
│       └── <serviceId>
└── logs/
```

Directories are private (`0700`); credentials, identity, runtime recovery records, and lease files are private regular
files (`0600`). Directories and files are created only when their owner needs them. Account `login` creates only
`config/credentials.json`; `computer connect --no-start` stores `config/computer-credentials.json` without installing the
daemon; runtime recovery records and workspaces appear on the first relevant reconcile.

OpenTag does not maintain control files inside an Agent work area. Platform and Agent instructions are injected through
the selected Provider's native system-prompt surface. A new work-area root is the Provider cwd. For an existing
schema-v1/v2 local Workspace layout, one compatibility transition preserves `files/` as the cwd instead of moving user files. It
removes only legacy instruction files whose OpenTag provenance can be established from the old state; a user-authored or
changed conflict is preserved and fails closed. The transition state is written before cleanup so an interrupted attempt
is idempotent. After it completes, the Client uses workspace state only to preserve layout and identity and no longer
inspects or manages local Workspace entries. Schema v3 is also a downgrade fence: older v1/v2 Clients reject it instead
of reinterpreting an upgraded layout. Here `workspace-states` and `workspaces` are persisted local runtime names, not the
removed product Workspace management concept.

This layout is a clean break: OpenTag does not read, migrate, delete, or fall back to root-level `credentials.json`,
`computer.json`, `daemon-owner.json`, `runtime/`, `service/`, `data/computer.json`, `data/runtime/agents`, or
`~/.opentag-service-targets`. Use a fresh Home, or move the old Home aside and log in again. Existing legacy files
otherwise remain unused on disk.

### Local data loss and recovery

Running `computer connect` again rotates the selected enrollment credential and restores connectivity, not the prior
local execution continuity. The Server can reissue credentials and
rebuild effective snapshots; managed instructions are injected again when the Provider Runtime starts or resumes.
Reissued credentials are new values. If `config/computer.json` is lost, the current Client creates a new Computer
identity; although the Server retains the old Computer and placement records, the Client does not automatically reclaim
that identity or repair old bindings.

Provider bindings, evidence for Turns not yet reported successfully, Agent work-area files, and local `daemon.env` values are
local-only. Losing a Session binding can reset exact Provider resume continuity and can leave accepted-but-unreported
work requiring explicit repair. Work-area files require Git, external storage, or a local backup; the OpenTag Server
cannot restore them. Losing workspace state while its work area is non-empty fails closed instead of silently choosing a
different cwd. Effective snapshots are reproducible and are not a primary backup target.

Daemon/service owner and lease state plus logs are locally reproducible only while the daemon is stopped and no service
mutation is running. Deleting owner or lease evidence while operations are live can break single-daemon and service
mutual exclusion. Backups should prioritize `config/computer.json`, `config/computer-credentials.json`, local `config/daemon.env`,
`data/runtime/session-bindings`, and `data/runtime/workspace-states` together with `data/workspaces`.

Manage the daemon with `daemon install/start/stop/restart/status/uninstall`. `uninstall` preserves `config/` and `data/`.
Windows services are not supported in v0.1. Linux logs are available through
`journalctl --user -u opentag-dev.service`; macOS logs are under `${OPENTAG_HOME}/logs`. Optional
`${OPENTAG_HOME}/config/daemon.env` must be a private regular file (mode `0600`) and can provide service-only environment
values without overriding pinned service settings. The CLI uses `/api/v1/auth/...` and `/api/v1/me/...`; `/healthz` and
`/readyz` remain unversioned deployment probes.

The dev service definition is `~/.config/systemd/user/opentag-dev.service` on Linux or
`~/Library/LaunchAgents/opentag-dev.plist` on macOS; the macOS wrapper is
`${OPENTAG_HOME}/state/service/opentag-dev`.
Staging and production replace the suffix with their channel `serviceId` (`opentag-staging` or `opentag`). If login saves
the machine credential was saved but service installation fails, fix the reported manager issue and run
`opentag-dev daemon install`; do not request another connect code.

Service mutation has two independent leases. `${OPENTAG_HOME}/state/service/operation.json` serializes operations for
the current Home. The target lease is fixed at the current user's default Home for the binary's channel — for example,
`~/.opentag-dev/state/service/target-operation.json` — so multiple custom `OPENTAG_HOME` values cannot concurrently
modify the same `opentag-dev.service`. Dev, staging, and production use different default Homes and service targets, so
their target leases do not contend.

## Manage Agent configurations

The accepted product direction and product presentation are **Account → Computer enrollment → Agent → IM binding**.
In the Phase 1 schema, an Agent is available to and manageable by the current Account through an active internal scope,
and is bound immutably at creation time to one active Computer enrollment in that scope. When the selected internal
scope has one eligible Computer, it is selected automatically. Legacy active grants can expose the same Agents and
enrollments to multiple Accounts until the one-off data split and Phase 2 establish strict per-Account ownership:

```bash
pnpm --filter open-tag start agent create \
  --name code-reviewer \
  --display-name "Code Reviewer" \
  --provider codex
pnpm --filter open-tag start agent list
```

Use `--computer <uuid>` when more than one Computer is available. There is no scope selector: the Agent belongs to the
authenticated Account, which the Server resolves on its own. An offline Computer may be selected because online presence
is not Agent configuration state. Inspect and
change the mutable display name with:

```bash
pnpm --filter open-tag start agent show <agent-id>
pnpm --filter open-tag start agent update <agent-id> --display-name "Reviewer"
pnpm --filter open-tag start agent delete <agent-id>
```

Updates use revision compare-and-swap and never overwrite a concurrent change automatically. Computer rebinding is not
an update operation. Deletion is a server-side soft delete and is idempotent for an Account authorized through the
selected internal scope. `claude-code` is an accepted configuration value,
but its runtime adapter and all Session/Turn delivery remain future work.

The four `OPENTAG_BOOTSTRAP_*` values are inputs to this one-time command only; the running server does not read them.
The bootstrap email is Account profile data, not an email/password credential. The Account login-code flow resolves a
stable user ID and then uses the provider-neutral token issuer. Future Google or OIDC identity resolvers can join at that
boundary without changing JWT claims. Internal grants are still loaded from PostgreSQL as a Phase 2 compatibility seam;
they are not exposed as Admin membership.

An Account email is stored lowercased, and one address identifies at most one Account. The identity resolver enforces
that by serializing on the address before deciding whether to create or attach, so it holds without a database
constraint; a `users_email_unique` index backs it up for any writer that skips the resolver, and is added only once no
revision predating the resolver is still serving.

A provider identity therefore attaches to the Account that already holds its address rather than creating a second one.
Attachment requires the provider to have verified the address, because it hands over an existing Account; an unverified
address that is already taken, and a provider email change onto another Account's address, are both refused with
`AUTH_EMAIL_CONFLICT`. This is how a bootstrap Account and that person's first Google sign-in become one Account.

`users.email_verified` records whether a provider asserted the address currently stored on the Account. It is only ever
raised for that address, never for some other address the provider returned, and the login-code flow never sets it.

## Google sign-in and Web App

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
browser session; it never creates an Account or internal compatibility records and still rejects suspended Accounts or
Accounts without the required internal grant. Missing or duplicate email matches fail closed. The server refuses this configuration in `staging` and
`prod`.

`OPENTAG_ENV` is the only OpenTag environment and release-channel selector. `dev` selects local development behavior and
the `opentag-dev` binary, `staging` selects `open-tag-staging` / `opentag-staging`, and `prod` selects
`open-tag` / `opentag`. `NODE_ENV` may still be `production` in hosted Node.js processes, but it does not select OpenTag
packages or product security behavior. The server logs the resolved environment, public URL, package, and binary at
startup; it never infers the environment from the hostname.

Open `/` for the management shell. Its top-level navigation is **Agents / Tasks / Skills / Integrations**, with no
Settings tab. Computer enrollment and recovery live in the Agents area. **Generate connection command** mints a
15-minute, single-use code and copies the server-authored `computer connect` command; the page polls the Account's
Computer enrollments until the new daemon handshake arrives. The account menu contains Account actions. OpenTag exposes
no Workspace, Admin, or invitation management surface. Normal sign-up and bootstrap still provision an internal default
Workspace and grant solely as a compatibility seam until Phase 2. Operators handle exceptional inspection or correction
of those internal records through controlled PostgreSQL operations under their normal database change procedure.

Session collaboration remains an Agent Runtime concern and does not introduce a product Workspace, Project, or shared
management container. Context Tree can preserve long-term context independently; it does not establish per-Account
ownership or change Computer enrollment, Agent placement, or IM binding.
`OPENTAG_ENCRYPTION_KEY` still protects IM provider credentials; generate it with `openssl rand -base64 32`.

## Onboarding end-to-end check

`scripts/e2e/onboarding-e2e.mjs` drives the whole `/onboarding` flow against a real Server, a real PostgreSQL database,
the real Web build, and a real Computer daemon. It signs in through the browser, reads the connect command from the
page, exchanges it with the CLI, runs `daemon service-run`, waits for the negotiated Provider readiness projection,
creates the Agent from the form, and then checks the handoff, the authorized setup gate, persisted completion, and that a
later runtime outage stays in the normal Agents product flow.

```bash
pnpm build
npm install --no-save playwright-core   # outside the workspace, or reuse an existing install
OPENTAG_E2E_PLAYWRIGHT_PATH=/path/to/playwright-core node scripts/e2e/onboarding-e2e.mjs
```

The check needs a reachable PostgreSQL superuser URL and a Chromium executable. It creates and drops its own database,
listens on its own port, and writes screenshots, Server and daemon logs, and recorded console entries to its artifact
directory. Because it drops that database on every run, it refuses any name that is not an unmistakably disposable E2E
identifier, and it drops that database again once the Server stops. The check also refuses to start when its port is
already taken, so it can never drive another local Server. The daemon receives an explicit Provider environment rather
than the invoking shell's, so readiness is the same on any developer machine.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENTAG_E2E_ADMIN_DATABASE_URL` | `postgresql://opentag:opentag@127.0.0.1:5432/postgres` | Superuser URL used to create the E2E database |
| `OPENTAG_E2E_DATABASE` | `opentag_e2e` | E2E database name, dropped and recreated on every run; must be a lowercase identifier containing `e2e` |
| `OPENTAG_E2E_PORT` | `8123` | Server listen port for the run |
| `OPENTAG_E2E_CHROMIUM` | `/opt/pw-browsers/chromium` | Chromium executable |
| `OPENTAG_E2E_PLAYWRIGHT_PATH` | `playwright-core` | Module specifier or path for `playwright-core` |
| `OPENTAG_E2E_ARTIFACTS` | `$TMPDIR/opentag-onboarding-e2e` | Screenshot and log output directory |
| `OPENTAG_E2E_PROVIDER_STUB` | `on` | Set to `off` to probe the Claude Code CLI installed on `PATH` instead of the stub |
| `CLAUDE_CONFIG_DIR` | `$HOME/.claude` | Claude Code configuration the daemon reads when the stub is off |
| `OPENTAG_E2E_KEEP_DATABASE` | `off` | Set to `on` to keep the E2E database after the run for debugging |

Two parts of the flow cannot run offline. Agent Runtime and Feishu CLI readiness use stub executables that answer the
same probe contracts as Claude Code and `lark-cli`, because signed-in local CLIs are not available in CI. Feishu
authorization needs `open.feishu.cn`, so the check starts a real setup attempt, records its outcome, and then writes an
authorized binding into the database to confirm that the Server projects handoff readiness and the page derives the
ready state from it.

## Environment variables

Copy `.env.example` only when you need local overrides. Environment files are not loaded automatically by the current
processes.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENTAG_HOST` | `127.0.0.1` | Server listen host |
| `OPENTAG_PORT` | `8000` | Server listen port |
| `OPENTAG_SERVER_URL` | `http://127.0.0.1:8000` | CLI doctor target |
| `OPENTAG_PUBLIC_URL` | none | Required public Server origin used for browser callbacks and generated connect commands |
| `OPENTAG_ENV` | `dev` | OpenTag environment/channel: `dev`, `staging`, or `prod`; hosted values require HTTPS |
| `OPENTAG_DATABASE_URL` | none | Required PostgreSQL connection URL |
| `OPENTAG_JWT_SECRET` | none | Required access-token signing secret; at least 32 characters |
| `OPENTAG_ENCRYPTION_KEY` | none | Required canonical base64-encoded 32-byte application encryption key |
| `OPENTAG_GOOGLE_CLIENT_ID` | none | Optional Google OIDC client id; requires the matching secret |
| `OPENTAG_GOOGLE_CLIENT_SECRET` | none | Optional Google OIDC client secret; requires the matching client id |
| `OPENTAG_SLACK_CLIENT_ID` | none | Optional first-party Slack App client id; requires the matching secret, signing secret, and redirect URL |
| `OPENTAG_SLACK_CLIENT_SECRET` | none | Optional first-party Slack App client secret; never logged |
| `OPENTAG_SLACK_SIGNING_SECRET` | none | Optional first-party Slack App signing secret for Events API HMAC; never logged |
| `OPENTAG_SLACK_REDIRECT_URL` | none | Optional public origin or exact Slack OAuth callback URL on `OPENTAG_PUBLIC_URL` |
| `OPENTAG_DEV_AUTH_BYPASS_ENABLED` | `false` | Explicitly enable loopback-only development sign-in; requires the configured email |
| `OPENTAG_DEV_AUTH_EMAIL` | none | Existing unique bootstrap user selected by the development bypass |
| `OPENTAG_AUTO_MIGRATE` | `true` | Run checked-in migrations before listening |
| `OPENTAG_OTEL_ENDPOINT` | empty | Optional OTLP/HTTP traces endpoint; see [server observability](./docs/observability.md) |
| `OPENTAG_OTEL_HEADERS` | empty | Secret OTLP headers in comma-separated `key=value` form |
| `OPENTAG_OTEL_ENVIRONMENT` | `OPENTAG_ENV` | Trace deployment environment label |
| `OPENTAG_OTEL_SAMPLE_RATE` | `1` | Global trace head sample rate from `0` to `1` |
| `OPENTAG_ACCESS_TOKEN_TTL_SECONDS` | `900` | Access-token lifetime |
| `OPENTAG_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh-JWT lifetime |
| `OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID` | empty | Staging-only Account UUID allowed to reset the [Onboarding Lab](./docs/staging-onboarding-lab.md) Account; Scenario Preview needs no configuration |
| `OPENTAG_HOME` | channel-specific | Root for lifecycle-separated `config/`, `data/`, `state/`, and `logs/` (`~/.opentag-dev` in source) |

If `doctor` fails, its error category distinguishes configuration, network, HTTP, and invalid-response failures. Confirm
the server is running and that the configured URL points to its base address.

## Releases

Release publishing belongs to GitHub Actions and npm trusted publishing. Never publish either channel from a maintainer
machine and never add a long-lived npm token to the repository. See [docs/releasing.md](./docs/releasing.md) for channel
identities, release guards, package smoke checks, and recovery steps.
