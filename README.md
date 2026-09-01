# OpenTag

[简体中文](./README.zh-CN.md)

OpenTag is a new, independent open-source product for connecting instant messaging with AI coding Agents. The project is
currently **pre-alpha**: its product workflows are still under development and are not ready for production use.

This repository currently provides the engineering foundation and first control-plane slice for OpenTag:

- a TypeScript monorepo with CLI, Web, client, server, and shared workspaces;
- a Fastify server with health, readiness, REST, and Computer WebSocket endpoints;
- a schema-validating client health check;
- provider-neutral account identities, Google browser sign-in, and PostgreSQL migrations;
- one-time Account login codes with sliding stateless refresh JWTs;
- independently authenticated Computer connection and presence;
- Agent registry with immutable Computer/provider binding and revision fencing;
- durable Agent Runtime execution, delivery custody, reporting, and recovery;
- Feishu and Slack inbound normalization, persistence, and Channel/Thread Session routing;
- durable, best-effort internal Session collaboration with explicit message retry;
- direct provider CLI credential handoff for Agent-controlled replies and reactions; and
- a same-origin management Web plus `doctor`, `login`, `agent`, `computer`, and daemon service management commands.

These runtime and messaging paths are implemented but remain pre-alpha. Installation, management, and end-to-end product workflows are still being completed.

## Quick start

OpenTag is currently pre-alpha. The repository includes a small Docker Compose sample for the local PostgreSQL
dependency:

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_DB: opentag
      POSTGRES_USER: opentag
      POSTGRES_PASSWORD: opentag
    ports:
      - "5432:5432"
    volumes:
      - opentag-postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U opentag -d opentag"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 5s

volumes:
  opentag-postgres-data:
```

Start the dependency with:

```bash
docker compose up -d postgres
```

The Compose service is a local development dependency; it does not start the OpenTag Server or any Agent runtime.
For Node.js setup, server configuration, Account bootstrap, Computer connection, authentication, and Agent management,
see the [development guide](./DEVELOPMENT.md).

## Project status

OpenTag is being built in small, validated vertical slices. Public APIs and package boundaries may change before the
first stable release. The current code includes the control plane, local Computer connection, Agent Runtime, durable IM
delivery, Feishu/Slack inbound routing, Channel/Thread Sessions, and direct provider CLI handoff. Broader product and
cross-Agent collaboration workflows remain under development.

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
- [Trademarks](./TRADEMARKS.md)

## License

OpenTag is licensed under the [Apache License 2.0](./LICENSE).

Marks belonging to other companies appear in the interface to identify their products. See
[TRADEMARKS.md](./TRADEMARKS.md) for what each one is and the conditions we keep to.
