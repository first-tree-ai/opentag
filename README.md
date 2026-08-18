# OpenTag

[简体中文](./README.zh-CN.md)

OpenTag is a new, independent open-source product for connecting team messaging with AI coding agents. The project is
currently **pre-alpha**: its product workflows are still under development and are not ready for production use.

This repository currently provides the engineering foundation and first control-plane slice for OpenTag:

- a TypeScript monorepo with CLI, client, server, and shared workspaces;
- a Fastify server with health and readiness endpoints;
- a schema-validating client health check;
- PostgreSQL migrations and bootstrap authentication for the first user and tenant;
- one-time connect-code login with rotating refresh credentials; and
- `opentag doctor` and `opentag login` commands.

Messaging integrations, agent providers, and session runtimes are not implemented yet.

## Quick start

Prerequisites: Node.js 22.13 or newer on the 22.x line, Node.js 24.x, or Node.js 26.x; Corepack; and pnpm 10.12.1.

```bash
corepack enable
pnpm install
docker compose up -d postgres
export OPENTAG_DATABASE_URL=postgresql://opentag:opentag@localhost:5432/opentag
export OPENTAG_JWT_SECRET=replace-with-at-least-32-random-characters
pnpm build
pnpm --filter @opentag/server start
```

In another terminal:

```bash
pnpm --filter open-tag start doctor
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the full local workflow.

## Project status

OpenTag is being built in small, validated vertical slices. Public APIs and package boundaries may change before the
first stable release. The current code establishes database bootstrap and user authentication; agent execution and
messaging remain future vertical slices.

## Documentation

- [Development guide](./DEVELOPMENT.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Release guide](./docs/releasing.md)
- [Security policy](./SECURITY.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)

## License

OpenTag is licensed under the [Apache License 2.0](./LICENSE).
