# AGENTS.md

## Scope

These instructions apply to the entire OpenTag repository.

OpenTag is a new, independent product. It does not inherit code, data models, migrations, or product constraints from any
historical feature with the same name in the First Tree repository. Do not copy or depend on that historical implementation.

## Toolchain

- Node.js `^22.22.2 || ^24.15.0 || ^26.0.0` (Node.js 24 primary), ESM, strict TypeScript
- pnpm 10.12.1 and Turborepo
- Biome for formatting and linting
- lefthook for the local `pre-commit` and `pre-push` gates, installed by `pnpm install`
- tsdown for ESM builds and Vitest for tests
- Fastify for the server and Zod for shared runtime schemas

## Repository structure

- `apps/cli`: thin Commander registration and presentation in `src/commands`, reusable logic in `src/core`
- `apps/web`: TanStack Router file routes in `src/routes`, page and domain modules in `src/features`
- `packages/shared`: cross-package runtime schemas and derived types
- `packages/client`: server access, local agent runtime, and provider integration
- `packages/server`: server APIs and services

The dependency direction is:

```text
apps/cli -> packages/client -> packages/shared
apps/cli --------------------> packages/shared
apps/web --------------------> packages/shared
packages/server -------------> packages/shared
```

In `apps/web`, routes under `src/routes` use directories and dotted filenames to express nesting;
`_`-prefixed route segments define pathless layouts. Route files stay thin —
they read params and search, then hand them to a component in `src/features` as props, so pages do
not read the router and can be mounted directly in tests. `src/routeTree.gen.ts` is generated and
committed; never edit it. `src/paraglide` is generated from `project.inlang` and `messages/<area>/{en,zh}.json`,
is not committed, and must never be edited. User-facing copy goes through `m.*()`. Routing and i18n
migrations must preserve user-visible wording and existing string assertions in tests.
Build links from the typed helpers rather than template strings.

Do not import workspace-internal paths. Import only through public package exports, including `@opentag/shared/browser`. The shared package
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

These commands are available checks, not a checklist to run for every change. Follow
[Local validation](DEVELOPMENT.md#local-validation) during development and before opening a pull request:

- Start with tests for the changed behavior. Expand to the owning package and affected consumers when contracts,
  shared code, or dependencies change; use the full suite when the impact cannot be bounded.
- Documentation-only changes need `pnpm check`, not application builds or tests. For code changes, run affected
  package type checks and build when the change affects bundling, exports, generated code, or packaging.
  Markdown shipped as runtime input (such as bundled Skills) follows the affected package's validation scope.
- Run relevant PostgreSQL integration tests for database behavior changes. New migrations require the full
  server integration suite; follow the [migration requirements](docs/system/database-read-write-standards.md#migrations).
- Run Agent Runtime coverage for changes to its covered implementation, tests, or coverage configuration;
  run `pnpm test:coverage` for root coverage configuration changes or repository-wide coverage investigations.
- Do not repeat successful checks on unchanged code just to finish a task or open a pull request. Rerun when later
  edits affect the checked behavior, a failure needs investigation, or a broader check is justified by the risk.
- Report what ran, why that scope was chosen, and anything not run or blocked. CI owns the complete regression
  matrix and must pass before merge; targeted local checks do not establish that CI is green.

Unit tests must not depend on the public network, external providers, or a running PostgreSQL instance.
The scheduled `Unit Coverage` workflow owns the recurring full coverage baseline measurement.

## Knowledge base and testing records

`docs/` is OpenTag's knowledge base, maintained as a Context Tree (start at `docs/NODE.md`):

- Read the relevant `docs/` pages before changing a documented behavior, and update them in the same pull request.
  Code is the ground truth when a page disagrees; fix the page from source evidence.
- Every directory has a `NODE.md` index and every page has `title` and `description` frontmatter. Place a page in the
  narrowest existing domain, list it in that domain's `NODE.md`, and prefer editing an existing page over adding one.
- Write current truth in English only. Leave delivery history, PR references, and dated status to Git and pull requests.
- `pnpm check` runs `context-tree verify` on `docs/`.

Test plans, acceptance runs, UI screenshots, and validation evidence belong in `testing/`, never in `docs/`.

## Database read/write design

Follow [Database read/write standards](docs/system/database-read-write-standards.md) when changing or reviewing persistence.
Before implementing or approving a database or read/write design, present the concrete proposal for human confirmation,
including schema, query paths, authorization, consistency, and retention semantics. Investigation may proceed first.

## Code and Git conventions

- Use English for code, comments, GitHub files, and canonical repository documentation.
- Keep Chinese mirrors of root documents (`*.zh-CN.md`) synchronized with their canonical English documents.
- Use explicit error handling; never swallow failures or log credentials.
- Keep changes scoped and avoid adding empty packages or placeholder directories.
- Run `pnpm check` before every commit. Use `pnpm format` to fix formatting and resolve any remaining lint errors.
- Use Conventional Commits and an approved branch prefix from `CONTRIBUTING.md`.
- Do not amend published commits or force-push shared branches.
