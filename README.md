# OpenTag

[简体中文](./README.zh-CN.md)

OpenTag is a new, independent open-source product for connecting team messaging with AI coding agents. The project is
currently **pre-alpha**: its product workflows are still under development and are not ready for production use.

This repository currently provides the engineering foundation for OpenTag:

- a TypeScript monorepo with CLI, client, server, and shared workspaces;
- a Fastify server health endpoint;
- a schema-validating client health check;
- an `opentag doctor` command; and
- a local PostgreSQL 17 development service for future persistence work.

No messaging integration, agent provider, session runtime, or database schema is implemented yet.

## Quick start

Prerequisites: Node.js 22.13 or newer, Corepack, and pnpm 10.12.1.

```bash
corepack enable
pnpm install
pnpm build
pnpm --filter @opentag/server start
```

In another terminal:

```bash
pnpm --filter @opentag/cli start doctor
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the full local workflow.

## Project status

OpenTag is being built in small, validated vertical slices. Public APIs and package boundaries may change before the
first stable release. The current code proves only the repository toolchain and health-check path described above.

## Documentation

- [Development guide](./DEVELOPMENT.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)

## License

OpenTag is licensed under the [Apache License 2.0](./LICENSE).
