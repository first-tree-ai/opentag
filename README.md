# OpenTag

[简体中文](./README.zh-CN.md)

OpenTag is a new, independent open-source product for connecting workspace messaging with AI coding agents. The project is
currently **pre-alpha**: its product workflows are still under development and are not ready for production use.

This repository currently provides the engineering foundation and first control-plane slice for OpenTag:

- a TypeScript monorepo with CLI, Web, client, server, and shared workspaces;
- a Fastify server with health, readiness, REST, and Computer WebSocket endpoints;
- a schema-validating client health check;
- provider-neutral account identities, Google browser sign-in, and PostgreSQL migrations;
- one-time Account login codes with sliding stateless refresh JWTs;
- legacy roleless Workspace Admin grants and redemption for outstanding single-use Admin invitations;
- independently authenticated Computer enrollment and presence;
- Workspace-owned Agent registry with immutable Computer/provider binding and revision fencing;
- durable Agent Runtime execution, delivery custody, reporting, and recovery;
- Feishu and Slack inbound normalization, persistence, and Channel/Thread Session routing;
- durable, best-effort internal Session collaboration with explicit message retry;
- direct provider CLI credential handoff for Agent-controlled replies and reactions; and
- a same-origin Admin Web plus `doctor`, `login`, `admin`, `agent`, `computer`, and daemon service management commands.

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

In another terminal, bootstrap the first Account and Workspace, then exchange the returned Account login code:

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

Account credentials are management-only and never start the daemon. Open the Web, enter the Agents area, generate a
15-minute Computer connection command, and run its `opentag-dev computer connect --server ... <code>` invocation on the
execution host. That command stores an enrollment-scoped machine credential and installs or restarts the per-user daemon
service on Linux and macOS. Keeping `~/.local/bin` first in `PATH` ensures the service uses this checkout's newly built CLI
instead of an older shim. `opentag-dev computer list` shows the enrolled Computer as online. Use `daemon stop`, `start`,
`restart`, `status`, and `uninstall` for lifecycle management. Pass `computer connect --no-start` when only the machine
credential should be stored. Daemon services are not supported on Windows in v0.1.

With the daemon registered, create and inspect an Agent configuration:

```bash
pnpm --filter open-tag start agent create \
  --name code-reviewer \
  --display-name "Code Reviewer" \
  --provider codex
pnpm --filter open-tag start agent list
```

This records the Agent identity and Computer binding. Agent Runtime turns start when admitted work is delivered to that Agent.

Workspace Admins manage model, reasoning effort, and the maximum Turn duration for Codex Agents from the Agent's **Runtime**
tab or the corresponding `agent update` flags. A blank model or reasoning value leaves the choice to Codex; a blank
duration uses OpenTag's 30-minute default. Explicit Codex-native values are validated by the bound Computer when it
prepares the Runtime and never silently replaced by OpenTag. Claude Code Effective Runtime Snapshots are not yet
supported.

Configure `OPENTAG_GOOGLE_CLIENT_ID` and `OPENTAG_GOOGLE_CLIENT_SECRET` to enable Google sign-in, then open
`http://127.0.0.1:8000/`. Workspace Admins manage Agents, Tasks, Skills, and Integrations. Computers are enrolled and
diagnosed from the Agents area. OpenTag no longer exposes a way to create an additional Workspace or issue a new Admin
invitation. Normal sign-up without an invitation and bootstrap still provision an internal default Workspace. An
invitation issued before this transition remains previewable while it is unconsumed, unrevoked, and unexpired, and it
remains redeemable only while its issuer is also a current Admin; accepting one may still add an Admin. Existing Admins
remain listable and revocable:

For loopback development without Google credentials, set `OPENTAG_DEV_AUTH_BYPASS_ENABLED=true` and
`OPENTAG_DEV_AUTH_EMAIL` to the unique email of an existing bootstrap user. This bypass is rejected outside the
`dev` environment and never creates Accounts or Admin grants.

```bash
pnpm --filter open-tag start admin list
pnpm --filter open-tag start admin revoke <account-id>
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
- [Slack App configuration](./docs/slack-app-setup.md)
- [IM Channel and Thread Sessions](./docs/thread-sessions.md)
- [Internal Session collaboration](./docs/internal-session-collaboration.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Release guide](./docs/releasing.md)
- [Deployment guide](./docs/deploying.md)
- [Security policy](./SECURITY.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)

## License

OpenTag is licensed under the [Apache License 2.0](./LICENSE).
