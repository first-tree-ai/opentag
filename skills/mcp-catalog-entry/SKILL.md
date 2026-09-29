---
name: mcp-catalog-entry
description: Record a remote MCP Server in this repository's marketplace catalog. Use when a task adds, verifies, or corrects an entry under apps/web/src/features/mcp/catalog, when a provider's MCP endpoint must appear in the Agent add flow's Discover surface, or when someone asks to 录入 MCP, 上架 MCP, add an MCP server to the marketplace, or check whether a listed endpoint is still right.
---

# MCP catalog entry

The marketplace catalog is committed repository data, not a service. Recording a Server means
editing two YAML sources, compiling them, and letting the repository gates reject anything a user
would otherwise meet as a broken card.

| Source | Holds |
| --- | --- |
| `apps/web/src/features/mcp/catalog/mcp-categories.yaml` | the category set, each with a localized label and a tab order |
| `apps/web/src/features/mcp/catalog/mcp-catalog.yaml` | one entry per Server |

`apps/web/src/features/mcp/catalog/mcp-catalog.gen.ts` is generated. Never edit it by hand:
`pnpm catalog:generate` writes it, and `pnpm check` runs the same script with `--check` to reject
drift.

## Step 1 — Collect the facts from the provider

Read the provider's own MCP documentation. Do not take an endpoint or an authorization method from a
blog post, a client configuration in another project, or from memory.

| Fact | Where it comes from |
| --- | --- |
| endpoint | the provider's primary remote Streamable HTTP URL |
| authorization | the same page: anonymous, an interactive OAuth flow, or a key the user supplies |
| display name and description | the provider's product name and one short sentence, in every supported locale |
| website | the provider's main site |
| documentation URL | keep it for the report — the catalog has no field for it |

Rules:

- List remote Streamable HTTP Servers only. Reject a stdio package (`npx …`, `mcp-remote …`), an
  SSE-only or deprecated fallback path such as `/sse`, and anything that needs a local subprocess:
  OpenTag is a hosted service and cannot run one on a user's machine.
- List the provider's primary endpoint once. Do not add a read-only or legacy variant beside it.
- `defaultAuthKind` is a prefill for a new authorization, never a statement about what the Server
  requires. The card uses it to pick the shortest finishing step, so it must match the method that
  actually works: `none` only when the endpoint answers anonymously, `oauth` when the provider runs
  an interactive OAuth flow, `bearer` when a human must paste a key.
- Put no credential of any kind in the catalog — not in the URL, not in `extraHeaders`.
- Settle a doubtful endpoint or method by calling it without credentials. A Streamable HTTP
  `initialize` that answers proves the endpoint and the anonymous case; a `401` carrying
  `WWW-Authenticate: Bearer realm="OAuth"` proves the OAuth case. Report the evidence; do not guess.

One credential-free request tells the two cases apart:

```sh
curl -sS -i -X POST <endpoint> \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"catalog-verify","version":"1.0.0"}}}'
```

## Step 2 — Choose the entry identity

- `id` — lowercase letters, then letters, digits, and hyphens. It is the entry identity and the icon
  file's basename, and it must be unique in the catalog.
- `name` — the Server definition name: lowercase letters, digits, and hyphens, at most 64 characters.
  The human-readable brand name lives in `title`, not here.
- `category` — an id declared in `mcp-categories.yaml`. Reuse an existing category when one fits. Add
  a new one only when the entry needs it: the generator rejects a declared category that no entry
  references, so a new category and its first entry land in the same change.

## Step 3 — Add the entry to `mcp-catalog.yaml`

```yaml
- id: <slug>
  name: <slug>
  title:
    en: <Brand>
    zh: <品牌名>
  description:
    en: <One short sentence.>
    zh: <一句话说明。>
  url: https://<host>/mcp
  defaultAuthKind: oauth
  category: general
  website: https://<provider-site>
  icon: <slug>.svg
  order: 30
```

- `title` and `description` must supply every locale listed in `apps/web/project.inlang/settings.json`
  (currently `en` and `zh`) and no other. A missing locale is a build failure, not a fallback.
- `url` must be an absolute `https` URL with no credentials and no fragment. The generator refuses
  plain HTTP and every loopback host, so an endpoint that only speaks HTTP cannot be listed.
- `website` is an absolute `http(s)` URL; it is the provider's site, linked from the card.
- `order` is a finite number placing the entry within its category. Read the neighbours and keep the
  gaps you find there.
- `authHeader`, `authScheme`, and `extraHeaders` exist for a `bearer` Server whose header is not
  `Authorization: Bearer`, or whose endpoint documents static headers. They are configuration and
  never a credential, and an extra header may not collide with the auth header.
- A card's `description` is presentation only: the create contract has no description field, so the
  definition starts without one until a probe succeeds.

## Step 4 — Add the icon

Create `apps/web/src/assets/mcp/<slug>.svg`: a 24×24 monochrome mark that paints with `currentColor`,
in the shape of the ones already in that directory. The generator fails when the file is missing. A
remote favicon is not an option — the card must not reach the provider before the user picks it.

## Step 5 — Compile and gate

```sh
pnpm catalog:generate
npx biome check apps packages scripts e2e
pnpm --filter @opentag/web test src/features/mcp
```

`pnpm check` is the full gate: biome, the theme and catalog drift checks, the Skill-bundle contract,
and the repository policy scripts. It can be red before your change for unrelated local reasons —
when it is, name the failing step and prove yours is green on its own, rather than reporting the gate
as passing. On this workstation biome is the step that is red before any change, because it reaches
the agent-scratch paths (`.opencode/`, `.omo/`) that only the global gitignore excludes; the scoped
form above is the same gate for the paths this repository owns. There is nothing for biome to lint
inside a Skill bundle: a bundle is markdown and `pnpm check` validates it with
`scripts/check-skill-bundles.mjs` instead.

The web command is the smallest test set that covers the catalog model and the Discover surface. Run
the whole web suite when you changed the generator, the entry type, or the add flow.

## What the generator refuses

- an entry URL the outbound policy would refuse;
- a create payload the Server would reject — the entry is validated by `CreateMCPServerRequestSchema`,
  so its name, auth header and scheme, and extra headers follow the rules the Server enforces;
- an entry that names a category the category source does not declare;
- a declared category that no entry references;
- a duplicate entry or category id;
- a localized field that omits a supported locale or adds an unknown one;
- an entry whose referenced icon file does not exist;
- a compiled module that does not match its sources.

## What an entry change does not touch

No Server API, no database, no migration, and no message catalog. The Discover surface renders
whatever the catalog carries, and the card text is the catalog's own localized copy — a deliberate,
documented exception to the Paraglide rule. A new category needs no UI change either; the tab bar
follows the category source.

If the task needs a *new field*, that is a contract change, not an entry: the generator, the
generated module's type and the catalog model, the component that renders it, their tests, and
`docs/design/mcp-server-integration.md` all move together.

## Staleness

`pnpm check` cannot decide whether a listed endpoint still answers or still uses the recorded method:
unit tests must not depend on the public network. A live check is therefore evidence you attach to
the report, not a gate. State what you verified and when, and prefer an observed fact over an assumed
one.

## Rules

- Never invent, shorten, or guess an endpoint. If the provider documents nothing remote, do not list
  it.
- Keep the change to the entries the task asked for, plus their categories and icons.
- Treat an existing entry as someone's reviewed decision: correct it only with evidence, and say
  which evidence.
- Report the endpoint, the authorization method you recorded, and the check you ran, so a reviewer can
  confirm the entry without repeating the research.
