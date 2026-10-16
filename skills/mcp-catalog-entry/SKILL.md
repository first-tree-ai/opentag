---
name: mcp-catalog-entry
description: Record a remote MCP Server in this repository's marketplace catalog. Use when a task adds, verifies, or corrects an entry under packages/mcp-presets, when a provider's MCP endpoint must appear in the Agent add flow's Discover surface, or when someone asks to 录入 MCP, 上架 MCP, add an MCP server to the marketplace, or check whether a listed endpoint is still right.
---

# MCP catalog entry

The marketplace catalog is committed repository data, not a service. Recording a Server means
editing two YAML sources in the `@opentag/mcp-presets` workspace, compiling them, and letting the
repository gates reject anything a user would otherwise meet as a broken card.

| Source | Holds |
| --- | --- |
| `packages/mcp-presets/mcp-categories.yaml` | the category set, each with a localized label and a tab order |
| `packages/mcp-presets/mcp-catalog.yaml` | one registry-style entry per Server |
| `packages/mcp-presets/schema/mcp-catalog-entry.schema.json` | the JSON Schema every entry is validated against |

Icons live in `packages/mcp-presets/icons/`, one SVG or PNG per referenced entry. The generated module
`packages/mcp-presets/src/mcp-catalog.gen.ts` embeds those icon bytes as data URLs and is what the Web
App reads through the package's public export. Never edit it by hand: `pnpm catalog:generate` writes
it, and `pnpm check` runs the same script with `--check` to reject drift.

## Step 1 — Collect the facts from the provider

Read the provider's own MCP documentation. Do not take an endpoint or an authorization method from a
blog post, a client configuration in another project, or from memory.

| Fact | Where it comes from |
| --- | --- |
| endpoint | the provider's primary remote Streamable HTTP URL |
| authorization | the same page: anonymous, an interactive OAuth flow, or a key the user supplies |
| OAuth scopes | for a provider whose consent screen is configured with a fixed subset (Google Workspace, for example), the documented scope list per product; record it as `auth.oauth.scopes` |
| display name and summary | the provider's product name and one short sentence, in every supported locale |
| when to use | one sentence that tells an Agent when this Server is the right tool, in every supported locale |
| capabilities and risk | what the tools do, and the strongest side effect any tool has (`none`, `write`, `destructive`) |
| website | the provider's main site |
| documentation URL | keep it for the report — the catalog has no field for it |

Rules:

- Prefer the provider's remote Streamable HTTP endpoint: only an entry with one is installable and
  shown as an addable card in Discover. A self-hosted stdio package (`npx …`, `uvx …`, `docker …`)
  may be recorded under `packages` as data, but it is **not yet installable**: the Server create
  contract and the runtime do not run packages, so a packages-only entry never appears as a card.
  An SSE remote (`/sse`) is likewise data only. Do not list `mcp-remote …` wrappers.
- List the provider's primary endpoint once. Do not add a read-only or legacy variant beside it.
- `auth.default_kind` is a prefill for a new authorization, never a statement about what the Server
  requires. The card uses it to pick the shortest finishing step, so it must match the method that
  actually works: `none` only when the endpoint answers anonymously, `oauth` when the provider runs
  an interactive OAuth flow, `bearer` when a human must paste a key.
- Put no credential of any kind in the catalog — not in the URL, not in a header's `value`.
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

- `id` — `mcp/<slug>`: the slug is lowercase letters, then letters, digits, and hyphens. It must be
  unique in the catalog. The slug is the Server definition name (at most 64 characters) and the card
  id; the human-readable brand name lives in `name`, not here.
- `catalog.category` — an id declared in `mcp-categories.yaml`. Reuse an existing category when one
  fits. Add a new one only when the entry needs it: the generator rejects a declared category that no
  entry references, so a new category and its first entry land in the same change.

## Step 3 — Add the entry to `mcp-catalog.yaml`

The entry is validated against `packages/mcp-presets/schema/mcp-catalog-entry.schema.json`.

```yaml
- schema_version: 1
  id: mcp/<slug>
  kind: mcp
  name:
    en: <Brand>
    zh: <品牌名>
  summary:
    en: <One short sentence.>
    zh: <一句话说明。>
  when_to_use:
    en: <Use when the task needs ...>
    zh: <当任务需要……时使用。>
  keywords: [<search-term>]
  capabilities: [<kebab-case-capability>]
  status: active
  auth:
    methods: [oauth]
    default_kind: oauth
    oauth:
      scopes:
        - <documented-scope>
  risk:
    side_effects: write
    data_access: private
  remotes:
    - type: streamable-http
      url: https://<host>/mcp
  catalog:
    category: general
    order: 30
    icon: <slug>.svg
    icon_is_official: false
  homepage: https://<provider-site>
```

- `name`, `summary`, and `when_to_use` must supply every locale listed in
  `apps/web/project.inlang/settings.json` (currently `en` and `zh`) and no other. A missing locale is
  a build failure, not a fallback.
- An entry needs `packages`, `remotes`, or both. Every remote `url` must be an absolute `https` URL
  with no credentials and no fragment; the generator refuses plain HTTP and every loopback host.
  Remote `type` is `streamable-http` or `sse`; only the first `streamable-http` remote makes the
  entry installable and supplies the flat connection fields.
- `packages[]` records `registry_type` (`npm`, `pypi`, `oci`, `nuget`, `mcpb`), `identifier`,
  `version`, `transport` (`stdio` or `streamable-http`), an optional `runtime_hint` that must match
  the registry type (`npx`, `uvx`, `docker`, `dnx`), `package_arguments`, and
  `environment_variables`. A `named` argument needs a `name`; a secret carries no `value` or
  `default`; a variable named like a credential must be `is_secret: true`; and no value may look like
  a credential. Add `prerequisites` and `platforms` (`linux`, `macos`, `windows`) when they apply.
- `homepage` is an absolute `http(s)` URL; it is the provider's site, linked from the card.
- `catalog.order` is a finite number placing the entry within its category. Read the neighbours and
  keep the gaps you find there.
- `remotes[0].headers` exists for a `bearer` Server whose header is not `Authorization: Bearer`, or
  whose endpoint documents static headers. A header with `role: auth` names the auth header (and an
  optional `scheme`); a header with `role: extra` carries a static `value`. They are configuration
  and never a credential, and an extra header may not collide with the auth header.
- `auth.default_kind` must be one of `auth.methods`. List `oauth` in `auth.methods` exactly when the
  entry has an `auth.oauth` block.
- `auth.oauth.scopes` is optional and only for a provider whose consent screen is configured with a
  fixed scope subset: a card starts OAuth requesting exactly that list. It is bounded to at most 64
  scopes of at most 255 characters, and the empty list or a blank scope is refused. Write
  `oauth: {}` when the provider hands out whatever scopes its discovery advertises; the flow falls
  back to the protected resource metadata's `scopes_supported`.
- `risk.side_effects` may not be weaker than the strongest `tools[].side_effect` you list.
- `status` is `active` for a normal entry. `deprecated` and `archived` entries are hidden from
  Discover; `removed` entries are not emitted.
- `repository`, `license`, and `maintainers` are optional: closed-source hosted vendors have none.
- A card's `summary` is presentation only: the create contract has no description field, so the
  definition starts without one until a probe succeeds.

## Step 4 — Add the icon

Download a product mark from an official brand resource into `packages/mcp-presets/icons/<slug>.svg`
or `<slug>.png`. Preserve the official colors and proportions, record the source in the icons README,
and set `catalog.icon_is_official: true` on the catalog entry only after verifying its origin. Unverified assets
remain unmarked and the UI renders its neutral connection icon instead.

The generator requires every referenced file and embeds its bytes in the generated module. A remote
favicon is not an option: rendering the card must not contact the provider.

## Step 5 — Compile and gate

```sh
pnpm catalog:generate
pnpm --filter @opentag/mcp-presets test
pnpm --filter @opentag/web test src/features/mcp
```

`pnpm check` is the full gate: biome, the theme and catalog drift checks, the Skill-bundle contract,
and the repository policy scripts. It can be red before your change for unrelated local reasons —
when it is, name the failing step and prove yours is green on its own, rather than reporting the gate
as passing. On this workstation biome is the step that is red before any change, because it reaches
the agent-scratch paths (`.opencode/`, `.omo/`) that only the global gitignore excludes; the scoped
form `npx biome check apps packages scripts e2e` is the same gate for the paths this repository owns.
There is nothing for biome to lint inside a Skill bundle: a bundle is markdown and `pnpm check`
validates it with `scripts/check-skill-bundles.mjs` instead.

The package test checks the generated catalog's shape — category and entry ordering, uniqueness, and
the embedded icons. The web command is the smallest test set that covers the catalog model and the
Discover surface. Run the whole web suite when you changed the generator, the entry type, or the add
flow.

## What the generator refuses

- an entry URL the outbound policy would refuse;
- a create payload the Server would reject — the entry is validated by `CreateMCPServerRequestSchema`,
  so its name, auth header and scheme, and extra headers follow the rules the Server enforces;
- an entry that names a category the category source does not declare;
- a declared category that no entry references;
- a duplicate entry or category id;
- an entry that does not validate against the entry schema (unknown key, bad status, non-HTTPS
  remote, an unknown registry type, or neither `packages` nor `remotes`);
- a package whose named argument has no name, whose secret carries a value or default, whose
  credential-looking variable is not secret, or whose value looks like a credential;
- an `auth.default_kind` outside `auth.methods`, or an `oauth` method without an `auth.oauth` block;
- a `risk.side_effects` weaker than a listed tool;
- an `auth.oauth.scopes` list that is empty, carries a blank or oversized scope, or exceeds the start
  request's bounds;
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
