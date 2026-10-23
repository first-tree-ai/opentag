# Production alert relay

This independent Cloud Run service receives Cloud Monitoring incident webhooks, sends a Feishu group message, and
requests SMS urgency for two configured users. It has no runtime dependency on the OpenTag Server or its PostgreSQL
database. Node.js 24 runs the erasable TypeScript directly; the production image has no npm dependencies.

Install development tools with `pnpm install --ignore-workspace`, then run `pnpm typecheck` and `pnpm test` here.
Build with `docker build .`. The separate Alert Relay workflow validates this directory.

Read the [operations contract](../../docs/operations/alert-relay.md) before deployment or changing routes.
