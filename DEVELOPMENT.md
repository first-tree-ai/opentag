# OpenTag development

[简体中文](./DEVELOPMENT.zh-CN.md)

## Run locally from source

You'll need macOS or Linux, Node.js (use the version in [.node-version](./.node-version)), pnpm 10.12.1,
Docker with Compose, and a signed-in Codex or Claude Code CLI. Keep Docker running and run the commands below
from the root of your cloned repository.

### 1. Install OpenTag

```bash
./scripts/dev-install.sh
```

This installs dependencies, builds the app, and installs the development CLI at `~/.local/bin/opentag-dev`.

### 2. Save your local configuration

Run this once for a new local installation. It saves your settings and generated secrets in `.env.local`,
which Git ignores. Keep this file for future restarts; if you already have local settings, reuse them.

```bash
(umask 077; cat > .env.local <<EOF
OPENTAG_DATABASE_URL=postgresql://opentag:opentag@127.0.0.1:5432/opentag
OPENTAG_JWT_SECRET=$(openssl rand -base64 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
OPENTAG_ENCRYPTION_KEY=$(openssl rand -base64 32)
OPENTAG_ENV=dev
OPENTAG_HOST=127.0.0.1
OPENTAG_PORT=8000
OPENTAG_PUBLIC_URL=http://127.0.0.1:8000
OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin
OPENTAG_DEV_AUTH_BYPASS_ENABLED=true
OPENTAG_DEV_AUTH_EMAIL=admin@example.com
EOF
)
```

### 3. Start the server

Load the settings, start PostgreSQL, and create your local account:

```bash
set -a
source .env.local
set +a
docker compose up -d --wait postgres
pnpm --filter @opentag/server bootstrap:admin
pnpm --filter @opentag/server start
```

Leave this terminal running. Account creation is a one-time step; for subsequent runs, use
[Stop and restart](#stop-and-restart).

### 4. Connect your agent

Open <http://127.0.0.1:8000> and choose **Developer sign-in**. In **Agents**, follow the setup steps to
choose Codex or Claude Code, then run the generated connection command in a second terminal.

Follow the chat setup for Slack or Lark / Feishu, then send your agent a message.
For Slack, see the [additional setup instructions](./docs/slack-app-setup.md).

## Stop and restart

Press Ctrl+C in the server terminal to stop the server. To start it again, run from the repository root:

```bash
set -a
source .env.local
set +a
docker compose up -d --wait postgres
pnpm --filter @opentag/server start
```

The settings file must be loaded in each new server terminal. Reuse the saved secrets with the existing database.
Database migrations run automatically when the server starts.

The agent runs in a separate background service. Stop or start it with:

```bash
~/.local/bin/opentag-dev daemon stop
~/.local/bin/opentag-dev daemon start
```

To stop PostgreSQL, run `docker compose stop postgres`. Its data remains in the Docker volume.

## Making changes

After editing code, stop the server, rebuild, and start it again in the terminal with your settings loaded:

```bash
pnpm build
pnpm --filter @opentag/server start
```

After changing CLI or agent runtime code, also run `~/.local/bin/opentag-dev daemon restart`.
After dependency changes, run `pnpm install` before building.

| Directory | Contents |
| --- | --- |
| `apps/web` | Web interface |
| `apps/cli` | Command-line interface |
| `packages/server` | API, authentication, and database |
| `packages/client` | Server client and local agent runtime |
| `packages/shared` | Shared schemas and types |

For UI translations, see [Web i18n](./docs/i18n.md).

## Checks

Run these before opening a pull request:

```bash
pnpm check
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @opentag/client test:agent-runtime:coverage
pnpm --filter @opentag/server test:integration
```

The server integration tests need Docker. Run `pnpm test:coverage` when changing coverage configuration or
investigating coverage gaps. See the [E2E guide](./e2e/README.md) for browser tests.

Each PostgreSQL integration fixture starts its own disposable database. With a local Docker endpoint, its random
published port binds to `127.0.0.1`; remote Docker endpoints retain Docker's default binding. Startup runs a host-side
`SELECT 1` with a five-second connection timeout before migrations or tests begin. If container health passes but this
query fails, check Docker port forwarding: an open TCP port alone does not prove that PostgreSQL traffic reaches the
container. The fixture closes the probe connection and removes the container on failure.

CI runs formatting, builds, type checks, repository script tests, PostgreSQL integration tests, and Agent Runtime
coverage in parallel jobs. Workspace unit tests run on Node.js 22.22.2, 24, and 26, with three Vitest shards per version.
Repository script tests also run on all three versions; the compatibility jobs verify the packed CLI on Node.js 22.22.2
and 26, while `CLI Pack Smoke` covers Node.js 24. The aggregate `CI` check requires every job and shard to succeed.
Patch Coverage checks changed paths before installing dependencies. Changes outside the existing coverable-source policy
receive an explicit pass; source deletions and renames still require measurement. For source changes, five parallel jobs
measure one workspace each and enforce its existing floors. The final job requires every report, concatenates disjoint
file maps, and enforces the unchanged 80% changed-line threshold. Missing reports, failed suites, and overlapping source
ownership fail the check. The weekly Unit Coverage workflow still measures the complete baseline.

On pull requests, Quality Scoreboard runs inside CI and reuses the three Node 24 unit shard timings instead of rerunning
tests. Its duration metric is explicitly the slowest workspace shard, excluding repository script tests and runner queue
time; it is distinct from the full-suite duration measured by scheduled and manual scoreboard runs. All existing static
scoreboard metrics remain available. The aggregate `CI` status requires the PR scoreboard to succeed.

Local `pnpm test` still runs the complete suite with limited concurrency. To reproduce a workspace unit shard locally:

```bash
pnpm build
pnpm exec turbo run test --concurrency=2 -- --shard=1/3
```

## Git hooks and worktrees

`pnpm install` installs hooks that format and lint staged files before commits and check the repository before pushes.
New Git worktrees install dependencies automatically. If a worktree wasn't initialized, run `pnpm worktree:setup` in it.
See [Contributing](./CONTRIBUTING.md) for branch and pull request conventions.

## Troubleshooting

- **Local sign-in fails:** confirm the server loaded `.env.local` and the bootstrap account was created.
  Developer sign-in requires `OPENTAG_ENV=dev` and loopback addresses for the host and public URL.
- **“Bootstrap has already been completed”:** the database already has an account. Use the restart commands above.
- **Agent doesn't connect:** run `~/.local/bin/opentag-dev doctor` and `~/.local/bin/opentag-dev daemon status`.
- **Need daemon logs:** on Linux, run `journalctl --user -u opentag-dev.service`; on macOS, check `~/.opentag-dev/logs`.

Local agent settings and files are stored in `~/.opentag-dev` by default. Back up this directory to preserve local
work and session state; the server cannot restore those files.

## Configuration and further reading

For additional settings, see [.env.example](./.env.example). Add the values you need to `.env.local` and reload it
before restarting the server.

To use Google sign-in locally, configure a Google Web OAuth client with callback URL
`http://127.0.0.1:8000/api/v1/auth/callback/google`, then set `OPENTAG_GOOGLE_CLIENT_ID` and
`OPENTAG_GOOGLE_CLIENT_SECRET` in your local settings.

- [Deployment](./docs/deploying.md) — deployment configuration and operations.
- [Runtime protocol](./docs/runtime-protocol.md) — communication between the server and agents.
- [Provider CLIs](./docs/direct-provider-cli.md) — Codex and Claude Code integration.
- [Observability](./docs/observability.md) — server tracing and diagnostics.
- [Releases](./docs/releasing.md) — publishing through GitHub Actions.
