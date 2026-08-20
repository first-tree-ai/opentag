# AGENTS.md

## Scope

These instructions apply to the entire OpenTag repository.

OpenTag is a new, independent product. It does not inherit code, data models, migrations, or product constraints from any
historical feature with the same name in the First Tree repository. Do not copy or depend on that historical implementation.

## Toolchain

- Node.js `^22.13.0 || ^24.0.0 || ^26.0.0` (Node.js 24 primary), ESM, strict TypeScript
- pnpm 10.12.1 and Turborepo
- Biome for formatting and linting
- tsdown for ESM builds and Vitest for tests
- Fastify for the server and Zod for shared runtime schemas

## Repository structure

- `apps/cli`: thin Commander registration and presentation in `src/commands`, reusable logic in `src/core`
- `packages/shared`: cross-package runtime schemas and derived types
- `packages/client`: server access and future local runtime/provider/repository layers
- `packages/server`: server APIs and services

The dependency direction is:

```text
apps/cli -> packages/client -> packages/shared
apps/cli --------------------> packages/shared
packages/server -------------> packages/shared
```

Do not import workspace-internal paths. Import only from each package's public `src/index.ts` surface. The shared package
must not depend on another workspace. Client and server must not depend on each other. Runtime schemas are the source of
truth; derive TypeScript types from Zod schemas instead of duplicating DTO interfaces.

## Commands

```bash
pnpm install
pnpm check
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @opentag/client test:agent-runtime:coverage
pnpm test:coverage
```

Run directly affected tests during development and all commands above before opening a pull request. Unit tests must not
depend on the public network, external providers, or a running PostgreSQL instance.

## Code and Git conventions

- Use English for code, comments, GitHub files, and canonical repository documentation.
- Keep Chinese mirrors synchronized with their canonical English documents.
- Use explicit error handling; never swallow failures or log credentials.
- Keep changes scoped and avoid adding empty packages or placeholder directories.
- Use Conventional Commits and an approved branch prefix from `CONTRIBUTING.md`.
- Do not amend published commits or force-push shared branches.
