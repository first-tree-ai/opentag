# OpenTag

[简体中文](./README.zh-CN.md)

OpenTag is a new, independent open-source product for connecting team messaging with AI coding agents. The project is
currently **pre-alpha**: its product workflows are still under development and are not ready for production use.

This repository currently provides the engineering foundation and first control-plane slice for OpenTag:

- a TypeScript monorepo with CLI, Web, client, server, and shared workspaces;
- a Fastify server with health, readiness, REST, and Computer WebSocket endpoints;
- a schema-validating client health check;
- provider-neutral account identities, Google browser sign-in, and PostgreSQL migrations;
- one-time connect-code login with sliding stateless refresh JWTs;
- explicit Team membership, role, leave/remove/restore, and seven-day invitation lifecycles;
- user-owned Computer registration and presence;
- Team-owned Agent registry with immutable Computer/provider binding and revision fencing;
- durable Agent Runtime execution, delivery custody, reporting, and recovery;
- Feishu and Slack inbound normalization, persistence, and Channel/Thread Session routing;
- direct provider CLI credential handoff for Agent-controlled replies and reactions; and
- a same-origin, read-only Admin Web plus `doctor`, `login`, `team`, `agent`, `computer`, and daemon service management commands.

These runtime and messaging paths are implemented but remain pre-alpha. Installation, administration, and end-to-end product workflows are still being completed.

## Quick start

Prerequisites: Node.js 22.13 or newer on the 22.x line, Node.js 24.x, or Node.js 26.x; Corepack; and pnpm 10.12.1.

```bash
corepack enable
pnpm install
docker compose up -d postgres
export OPENTAG_DATABASE_URL=postgresql://opentag:opentag@localhost:5432/opentag
export OPENTAG_JWT_SECRET=replace-with-at-least-32-random-characters
export OPENTAG_ENCRYPTION_KEY=$(openssl rand -base64 32)
export OPENTAG_PUBLIC_URL=http://127.0.0.1:8000
pnpm build
pnpm --filter @opentag/server start
```

In another terminal, bootstrap and log in once. Login installs and starts the per-user daemon service on Linux and macOS:

```bash
export OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
export OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin
export OPENTAG_BOOTSTRAP_TEAM_NAME=example
export OPENTAG_BOOTSTRAP_TEAM_DISPLAY_NAME=Example
pnpm --filter @opentag/server bootstrap:admin
./scripts/dev-install.sh
export PATH="$HOME/.local/bin${PATH:+:$PATH}"
opentag-dev login --server http://127.0.0.1:8000 -- <connect-code>
opentag-dev daemon status
```

The dev installer builds and links the CLI, then installs, starts, or repairs the daemon service when credentials already
exist. On a first install it safely defers service setup to the separate `login`, which creates credentials and installs
the service. Keeping `~/.local/bin` first in `PATH` also ensures service definitions use this checkout's newly built CLI
instead of an older shim. `opentag-dev computer list` shows the Computer as online. Use `daemon stop`, `start`, `restart`,
`status`, and `uninstall` for lifecycle management. Pass `login --no-start` when only credentials should be stored.
Daemon services are not supported on Windows in v0.1.

With the daemon registered, create and inspect an Agent configuration:

```bash
pnpm --filter open-tag start agent create \
  --name code-reviewer \
  --display-name "Code Reviewer" \
  --provider codex
pnpm --filter open-tag start agent list
```

This records the Agent identity and Computer binding. Agent Runtime turns start when admitted work is delivered to that Agent.

Team Admins manage model, reasoning effort, and the maximum Turn duration for Codex Agents from the Agent's **Runtime**
tab or the corresponding `agent update` flags. A blank model or reasoning value leaves the choice to Codex; a blank
duration uses OpenTag's 30-minute default. Explicit Codex-native values are validated by the bound Computer when it
prepares the Runtime and never silently replaced by OpenTag. Claude Code Effective Runtime Snapshots are not yet
supported.

Configure `OPENTAG_GOOGLE_CLIENT_ID` and `OPENTAG_GOOGLE_CLIENT_SECRET` to enable Google sign-in, then open
`http://127.0.0.1:8000/`. Active Team members share the same App Shell and member-safe views; Team Admins additionally
manage Agents, runtime configuration, IM bindings, and Local Computer setup. Computer setup is Agent-scoped: Admins can
connect another Computer with a short-lived install/login command while creating an Agent, then inspect the bound
Computer from that Agent's pages. **Settings → Team** lets Team
Admins create, copy, and rotate the bearer invitation link. Invitees can preview the link before signing in; after
redemption, the Web selects the joined Team. Membership role and lifecycle changes remain explicit CLI operations:

For loopback development without Google credentials, set `OPENTAG_DEV_AUTH_BYPASS_ENABLED=true` and
`OPENTAG_DEV_AUTH_EMAIL` to the unique email of an existing bootstrap user. This bypass is rejected outside the
`dev` environment and never creates accounts or Team roles.

```bash
pnpm --filter open-tag start team member list
pnpm --filter open-tag start team invitation show
pnpm --filter open-tag start team invitation rotate
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the full local workflow.

## Project status

OpenTag is being built in small, validated vertical slices. Public APIs and package boundaries may change before the
first stable release. The current code includes the control plane, local Computer connection, Agent Runtime, durable IM
delivery, Feishu/Slack inbound routing, Channel/Thread Sessions, and direct provider CLI handoff. Product administration
and broader collaboration workflows remain under development.

## Documentation

- [Development guide](./DEVELOPMENT.md)
- [Server observability](./docs/observability.md)
- [Direct provider CLI messaging](./docs/direct-provider-cli.md)
- [IM Channel and Thread Sessions](./docs/thread-sessions.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Release guide](./docs/releasing.md)
- [Deployment guide](./docs/deploying.md)
- [Security policy](./SECURITY.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)

## License

OpenTag is licensed under the [Apache License 2.0](./LICENSE).
