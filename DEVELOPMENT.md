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

### Skills sync

The daemon mirrors the skills assigned to each Agent into that Agent's Home:

| Path | Contents |
| --- | --- |
| `<Agent Home>/.skills/<name>/` | The skill's files, exactly as the server's manifest lists them |
| `<Agent Home>/.skills/.opentag-skills.json` | Local sync record (`0600`): the agent digest, per-skill digests and manifests, `syncedAt`, and `lastError` |
| `<Agent Home>/.claude/skills/<name>` | Relative symlink to `../../.skills/<name>` so Claude Code (`--setting-sources project`) discovers the skill |
| `<Agent Home>/.agents/skills/<name>` | Relative symlink to `../../.skills/<name>` so Codex discovers the skill from its repo-scoped root (the thread cwd is the Agent Home) |
| `data/runtime/workspace-states/a-<hash>.json` | Workspace layout state; schema version 4 adds the latest sync outcome |

`.skills/` is fully managed: a sync installs what the server assigns, removes what it no longer lists, and
never touches other entries under `.claude/skills/` or `.agents/skills/` (such as `context-tree-*`). Sync runs when
a workspace is prepared, when the server pushes a `skills:changed` frame, and every ten minutes as a safety net;
failures are recorded in `lastError` and retried with exponential backoff (one minute up to thirty minutes) without
blocking Session start. Skills stay per Agent: nothing is written to the Computer-wide `$CODEX_HOME/skills`, which
Codex treats as a deprecated user-scoped location.

Manage the library from the CLI:

```bash
opentag skill list
opentag skill show <name>
opentag skill push <dir-or-zip> [--replace]
opentag skill pull <name> [--out <dir>]
opentag skill delete <name> [--yes]
opentag skill assign <agent-id-or-name> --set <names...>
```

`push` packs a directory into a zip (skipping `.git/`, `node_modules/`, and `.DS_Store`; at most 5 MiB
compressed, 20 MiB unpacked, 200 files) and requires a `SKILL.md` at the root. Inside an Agent Session it
publishes through the Session and assigns the skill to that Agent; pass `--session <session-id>` with the
Current Session named in the managed instructions.

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
