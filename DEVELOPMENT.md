# openTag development

[简体中文](./DEVELOPMENT.zh-CN.md)

## Run locally from source

You'll need macOS or Linux, Node.js (use the version in [.node-version](./.node-version)), pnpm 10.12.1,
Docker with Compose, and a signed-in Codex or Claude Code CLI. Keep Docker running and run the commands below
from the root of your cloned repository.

### 1. Install openTag

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
For Slack, see the [additional setup instructions](./docs/system/messaging/slack-app-setup.md).

## Admin operations

Two commands act on the database directly instead of going through the server. Both need the settings from
`.env.local` and a current `dist/` (`pnpm build`):

- `pnpm --filter @opentag/server bootstrap:admin` creates the first Account on a fresh database.
- `pnpm --filter @opentag/server transfer:agent` moves an existing Agent to another Account.

### Transfer an Agent to another Account

```bash
set -a
source .env.local
set +a
OPENTAG_TRANSFER_AGENT_ID=<agent-uuid> \
OPENTAG_TRANSFER_TARGET_ACCOUNT_ID=<account-uuid> \
OPENTAG_TRANSFER_SLACK=disable \
  pnpm --filter @opentag/server transfer:agent
```

The Agent must be suspended. The command runs in one transaction and prints the result as JSON; it also writes a redacted
audit line to stderr. A rejected precondition - the Agent is not suspended, the target Account already has an Agent with
that name, or a Turn can still land on the old Computer - exits non-zero and names the reason in that line. Unbinding the
messaging connection does not clear the Turn check: the pending Delivery survives in the database, so the command keeps
refusing until that Turn is reconciled.

Suspend the Agent while its Computer is online: this command has no Runtime connection, so it relies on the suspension
having already stopped the Sessions and retired the previous Computer's placement. That stop is best effort, so a
Computer that was offline at suspend time is not retried.

Everything keyed by the Agent alone moves with it: Skills, instructions and history. The Computer is detached, so the
Agent shows no Computer until the new owner binds one. The MCP mounts and their stored credentials are deleted, because
the Server definitions they point at belong to the previous Account.

Schedules are kept as records but paused (`enabled = false`, no next occurrence), and the result reports how many were
paused. Each Schedule pins one target conversation, and that conversation ends with the transfer, so it could no longer
dispatch. The new owner recreates the Schedule from a conversation they own.

Per-Agent usage history (token counts and outcomes, no message content) is keyed by the Agent, so the new owner's usage
view includes Turns the source Account ran. Billing history itself is not touched.

`OPENTAG_TRANSFER_SLACK` selects what happens to the messaging binding:

- `disable` (default) disables the binding and releases an unused Slack installation.
- `keep` leaves a Slack binding and its installation serving the Agent under the new owner. A Feishu binding cannot be
  kept and is rejected with `im_binding_keep_unsupported`.

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

For UI translations, see [Web i18n](./docs/system/web/i18n.md).

## Checks

For database and read/write changes, start with the [Database read/write standards](./docs/system/database-read-write-standards.md).
Identify the applicable rule IDs, any exceptions, and the verification scope in the change proposal and review.

### Local validation

Choose checks from the changed behavior and its consumers. Use the same scope during development and before opening
a pull request; opening a PR does not require repeating successful checks on unchanged code. Run `pnpm check` before
every commit. CI runs the complete regression matrix and must pass before merge.

| Change | Local validation |
| --- | --- |
| Documentation only | `pnpm check`; no application build or tests. Keep root Chinese mirrors synchronized. Markdown shipped as runtime input, such as bundled Skills, follows the affected package's validation scope. |
| Behavior within one package | Relevant test files and the package's type check. Expand to the package suite when the impact spans the package or is unclear. |
| Shared schemas, public exports, or cross-package contracts | Producer tests and affected consumer tests/type checks. Build changed exports before testing consumers. |
| Database queries, transactions, locking, or persistence | Relevant server unit and PostgreSQL integration tests. A new migration requires the full integration suite and migration-count update in `AGENTS.md`. |
| Agent Runtime implementation or tests covered by `vitest.agent-runtime.config.ts`, or that configuration | Focused tests, then `pnpm --filter @opentag/client test:agent-runtime:coverage`. Its 100% gate is authoritative on CI's Ubuntu host; report host-specific failures. |
| Repository scripts or workflows | Relevant `scripts/__tests__/*.test.mjs` files and any build/package smoke checks exercised by the change. |
| Build, exports, generated code, or packaging | Affected builds plus relevant tests and type checks. |
| Dependencies, toolchain, or shared test/build configuration | Expand to affected packages and consumers; run `pnpm build`, `pnpm typecheck`, and `pnpm test` when the impact is repository-wide or cannot be bounded. |
| Root coverage configuration or repository-wide coverage investigation | `pnpm test:coverage`. Routine changes rely on CI's coverage checks. |

Include relevant browser validation for rendered UI changes; see the [E2E guide](./e2e/README.md).
Record the commands run, why their scope covers the change, and checks not run or blocked in the PR. Rerun successful
checks only when subsequent edits affect their inputs or behavior, or a new failure or risk justifies broader validation.
Do not interpret a filtered run with no matching tests as successful validation.

### Targeted commands

Run these examples from the repository root, selecting the package and files relevant to your change. Tests import
workspace dependencies through built exports. Prepare dependencies before direct package commands, and rebuild them
after changing their source:

```bash
# Build only the client's workspace dependencies, then run one test file.
pnpm exec turbo run build --filter='@opentag/client^...'
pnpm --filter @opentag/client test src/__tests__/auth.test.ts

# Run an entire package suite and its type check, preparing dependencies through Turbo.
pnpm exec turbo run test typecheck --filter=@opentag/web --concurrency=2

# Include a changed shared package and its dependent workspaces.
pnpm exec turbo run test typecheck --filter='...@opentag/shared' --concurrency=2

# Run one repository script test.
node --test scripts/__tests__/git-hooks.test.mjs

# Prepare server dependencies and run one PostgreSQL integration file (requires Docker).
pnpm exec turbo run build --filter='@opentag/server^...'
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/tasks.test.ts --maxWorkers=2
```

Use `open-tag` as the CLI package name. For focused web tests, prepare web dependencies with
`pnpm exec turbo run build --filter='@opentag/web^...'` before `pnpm --filter @opentag/web test <test-file>`.
Vitest's Vite plugin generates translations automatically. For direct web type checks, run
`pnpm --filter @opentag/web paraglide` first; Turbo's web typecheck task already includes this step.
File paths are relative to the selected
package. Keep file filters on direct package commands; do not forward them to unrelated package suites.

For a focused server integration run, use the direct `exec vitest run` example above. Appending a filename to
`test:integration` keeps the script's existing directory filter and still selects the entire integration suite.
Use `pnpm --filter @opentag/server test:integration` when the full integration suite is required.

Each PostgreSQL integration fixture starts its own disposable database. With a local Docker endpoint, its random
published port binds to `127.0.0.1`; remote Docker endpoints retain Docker's default binding. Startup runs a host-side
`SELECT 1` with a five-second connection timeout before migrations or tests begin. If container health passes but this
query fails, check Docker port forwarding: an open TCP port alone does not prove that PostgreSQL traffic reaches the
container. The fixture closes the probe connection and removes the container on failure.

### CI and full-suite reproduction

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
The pre-push hook runs repository lint, format, `pnpm check`, and `pnpm typecheck`; neither hook runs tests.
These hook checks are additional to the targeted tests above.
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

- [Deployment](./docs/operations/deploying.md) — deployment configuration and operations.
- [Runtime protocol](./docs/system/runtime/runtime-protocol.md) — communication between the server and agents.
- [Provider CLIs](./docs/system/messaging/direct-provider-cli.md) — Codex and Claude Code integration.
- [Observability](./docs/operations/observability.md) — server tracing and diagnostics.
- [Releases](./docs/operations/releasing.md) — publishing through GitHub Actions.
