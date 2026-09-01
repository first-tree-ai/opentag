# AGENTS.md

## Scope

These instructions apply to the entire OpenTag repository.

OpenTag is a new, independent product. It does not inherit code, data models, migrations, or product constraints from any
historical feature with the same name in the First Tree repository. Do not copy or depend on that historical implementation.

## Toolchain

- Node.js `^22.13.0 || ^24.0.0 || ^26.0.0` (Node.js 24 primary), ESM, strict TypeScript
- pnpm 10.12.1 and Turborepo
- Biome for formatting and linting
- lefthook for the local `pre-commit` and `pre-push` gates, installed by `pnpm install`
- tsdown for ESM builds and Vitest for tests
- Fastify for the server and Zod for shared runtime schemas

## Repository structure

- `apps/cli`: thin Commander registration and presentation in `src/commands`, reusable logic in `src/core`
- `apps/web`: TanStack Router file routes in `src/routes`, page and domain modules in `src/features`
- `packages/shared`: cross-package runtime schemas and derived types
- `packages/client`: server access and future local runtime/provider/repository layers
- `packages/server`: server APIs and services

The dependency direction is:

```text
apps/cli -> packages/client -> packages/shared
apps/cli --------------------> packages/shared
apps/web --------------------> packages/shared
packages/server -------------> packages/shared
```

In `apps/web` the route tree is the directory tree: a file under `src/routes` is a route, and a
`_`-prefixed file is a pathless layout that wraps the directory beside it. Route files stay thin —
they read params and search, then hand them to a component in `src/features` as props, so pages do
not read the router and can be mounted directly in tests. `src/routeTree.gen.ts` is generated and
committed; never edit it. `src/paraglide` is generated from `project.inlang` and `messages/*.json`,
is not committed, and must never be edited. User-facing copy goes through `m.*()`, and migration
changes must not modify string assertions in tests. Build links from the typed helpers rather than template strings.

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
pnpm --filter @opentag/server test:integration
```

Run directly affected tests during development and all commands above before opening a pull request. Unit tests must not
depend on the public network, external providers, or a running PostgreSQL instance. Run `pnpm test:coverage` when changing
the root coverage configuration or investigating repository-wide coverage gaps; the scheduled `Unit Coverage` workflow
owns the recurring baseline measurement.

## Code and Git conventions

- Use English for code, comments, GitHub files, and canonical repository documentation.
- Keep Chinese mirrors synchronized with their canonical English documents.
- Use explicit error handling; never swallow failures or log credentials.
- Keep changes scoped and avoid adding empty packages or placeholder directories.
- Run `pnpm check` before every commit to apply linting and formatting, so committed code conforms to repository standards.
- Use Conventional Commits and an approved branch prefix from `CONTRIBUTING.md`.
- Do not amend published commits or force-push shared branches.
