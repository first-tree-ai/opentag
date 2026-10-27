---
title: "Agent Skills"
description: "The shared Skill contract: ownership, stored archives, object storage, upload, delivery to Computers, and limits."
---

# Agent Skills

> **Status: the shared contract is the source of truth; the lanes build against it.**
>
> The `@opentag/shared` runtime schemas, constants, HTTP path templates, the manifest parser, and this
> document are delivered in `packages/shared/src/skill.ts`, `packages/shared/src/skill-manifest.ts`,
> and their tests. The Server lane delivers the `agent_skills` table and its migration, the
> `SkillObjectStore` and its S3 adapter, the three HTTP surfaces, and the deferred orphan-object
> collector. The Web lane delivers the Skills page. The Client/CLI lane delivers `opentag skill push`
> and runtime materialization on a Computer.
>
> Where this document and the shipped contract differ, the contract wins; a change to it is a change
> to this design.

## What this feature is for

An Agent is more useful when it can carry its own reusable know-how. A Skill is a directory
containing a `SKILL.md` manifest plus supporting files; an operator uploads one to the platform, it is
stored as a single archive, owned by exactly one Agent, and materialized into that Agent's workspace
when a runtime starts. An Agent may also author a Skill locally and push it back up through the CLI.

The design goal that shapes everything below: **a Skill belongs to exactly one Agent.** An Agent
uploading a routine must not make it visible to its siblings, and a Skill is not an Account-level
asset that happens to be mounted somewhere. Sharing a Skill means uploading it again.

## Scope

| In scope | Out of scope |
| --- | --- |
| One archive per Skill, owned by one Agent | Versioning (always exactly one version) |
| Upload from Web, human CLI, and the Agent itself | Online editing of a Skill |
| Download/sync of enabled Skills to a Local Computer | Review or moderation workflow |
| Deterministic server-side re-packing and hashing | Cross-Account sharing |
| Three authenticated HTTP surfaces | Cloud sandboxes (Local Computers only in v1) |

## Ownership and data model

**A Skill belongs to exactly one Agent, and it is stored in one table.** The table `agent_skills` has
no `account_id` column and carries a unique index on `(agent_id, lower(name))`. Ownership is resolved
by joining `agents.created_by_user_id`, exactly as `mcp_server_authorizations` resolves ownership of
an authorization through the Agent that owns it.

This is deliberately unlike MCP, which keeps an Account-level pool of Server definitions and mounts
them per Agent. For MCP the shared artifact is the *definition* of an external service, and two
Agents mounting it are talking about the same thing. For Skills there is no such shared artifact: the
requirement is that Agents own Skills independently, so a pool would be a false abstraction and an
extra table to keep consistent. The database is the single source of trust; the Server never accepts
an `account_id` from a caller when addressing a Skill.

**A Skill has exactly one version.** Replacing the archive bumps `revision` and swaps the stored
object; no history is kept. If an Agent needs two variants it uploads two Skills under two names.

## The stored archive

**The canonical stored format is `tar.gz`, with member paths relative to the skill root.** `zip` is
accepted on upload for convenience and re-packed server-side, so exactly one format reaches storage
and a reader never has to branch on format.

The Server validates every upload before it stores anything:

- rejects path traversal and absolute member paths;
- rejects links, devices, and setuid/setgid bits;
- enforces the entry count and the unpacked-size bound, which is what defeats a zip bomb;
- strips a single shared top-level directory, so `my-skill/SKILL.md` and `SKILL.md` are the same Skill;
- requires a root `SKILL.md` and parses its frontmatter.

The parser is the same bounded, dependency-free function the contract layer exports; it understands
plain and quoted scalars and `>`/`|` block scalars, and refuses anything it cannot represent
faithfully rather than guessing. **`name` and `description` must be strings.** The value is
classified by YAML's structural rules rather than by listing collection shapes: a plain value is
rejected when its effective first line starts with a flow indicator (`[`, `{`, `]`, `}`, `,`), an
anchor/alias/tag/directive indicator (`&`, `*`, `!`, `%`, `@`, a backtick), or a block-sequence or
block-mapping indicator (`-`, `?`, `:` followed by space or end of line), and when any line of a plain
scalar contains a mapping colon (`: ` or a trailing `:`). That covers flow lists and maps, block
sequences, block mappings, and explicit `? key` / `: value` entries, while a `|`/`>` block whose text
contains `- item` or `key: value` lines is still a string. A plain value that YAML resolves to a
non-string — null (`~`, `null`), a boolean (`true`, `yes`, `on`, …), a number (integer, hex, octal,
float, `.inf`, `.nan`), or a date/timestamp (`2024-01-01`) — is rejected as
`Skill manifest <key> must be a string, not a <type>`, because the reference validator's strict parser
rejects it too; a quoted token (`"123"`) or one merely embedded in text (`true story`, `v2`) stays a
string. The manifest description is trimmed of leading and trailing whitespace, because a block
scalar's chomping indicator otherwise leaves a trailing newline in a value that is stored and shown as
a single line. A quoted scalar may start on the key line or on the first continuation line and may
span lines; it is folded and must be exactly one complete quoted scalar, so text after the closing
quote, a mapping key after it, or an unterminated quote is rejected.

Because the Server re-packs deterministically, **the stored `sha256` is the Server's, not the
uploader's.** The `x-opentag-skill-sha256` header is an integrity check on the transfer, not a claim
the Server copies into the row.

## Object storage

**Skills are stored in S3-compatible object storage behind a `SkillObjectStore` interface**
(`put`/`get`/`head`/`delete`/`list`), with an S3 adapter built on `aws4fetch` and an in-memory fake for
tests — the same interface/adapter/fake shape as `WorkspaceObjectStore` in
`packages/server/src/services/sandboxes/workspace-object-store.ts`. `list` is a bounded
`ListObjectsV2` page (`prefix`, optional `cursor`/`limit`) used only by the object collector; the S3
adapter parses its XML with a small extractor rather than an XML dependency.

`aws4fetch` is chosen over the AWS SDK v3 because it is SigV4 over `fetch` with zero transitive
dependencies and no default-checksum behaviour, which several S3-compatible services reject. The
adapter supports path-style addressing for services that require it.

**Object keys are derived server-side and never supplied by a caller:**

```
<prefix>/accounts/<accountId>/agents/<agentId>/skills/<skillId>/<objectId>.tar.gz
```

The configured prefix is **normalized once**: empty slash segments are dropped and every remaining
segment must be `[A-Za-z0-9._-]+` and must not be `.` or `..`. So `skills/`, `/skills`, and
`//skills//` are the same namespace, and an empty or traversal prefix is rejected at startup. Writes
and collection both use that one normalized form.

Every upload or replacement allocates an independent random 256-bit `objectId`, encoded as 64 lowercase
hex characters. Re-uploading identical content therefore writes a different physical key. The real
content hash stays in `archive_sha256`, the PUT's payload-hash header, bundle headers, and runtime
manifests; it is never inferred from the filename. All upload sources use this rule.

A replace writes its own object before the conditional row update, without holding database locks
across object I/O. Only one logical current archive is exposed. Identical-content replacements still
advance the existing revision and provenance rules, and can leave duplicate objects until GC.
Existing hash-named objects remain readable through their stored `object_key`; no migration or
rewrite is required. The owner path, filename shape and length, and exact-prefix GC matcher stay the same.

## Orphan-object collection

**A replace leaves its previous object for `SkillObjectGc`.** Collection keeps the existing grace
period and reference checks. Since every new write has its own key, a later same-content replacement
cannot make an object whose DELETE is already in flight current again. The same rule isolates a
failed writer's cleanup from another successful writer's object.

`SkillObjectGc` is a timer-driven worker — no overlapping runs, `unref`'d, errors logged and never
thrown — that pages through `list(<normalized prefix>/)` and deletes an object only when **all three**
hold:

- its key is **exactly** `<normalized prefix>/accounts/<uuid>/agents/<uuid>/skills/<uuid>/<64hex>.tar.gz`.
  The binding is exact, with no intervening namespace, so a deployment may share a bucket with another
  deployment under a nested prefix (`skills/staging`) or an adjacent one (`skills-staging`) without
  collecting the other's objects — that deployment's rows live in a different database this one cannot
  reference-check. A key not directly under this prefix is `skippedForeign` and is never looked up or
  deleted;
- it is older than the grace period (`OPENTAG_SKILL_STORAGE_GC_GRACE_SECONDS`, default one day), so a
  just-written object is never swept;
- **no `agent_skills.object_key` references it.** References are checked in batches, then the single
  key is re-checked immediately before its delete, because a row can appear between the two.

Deletes are capped per run (`maxDeletesPerRun`, default 500); a failed delete is logged and left for
the next pass. Logging is one `info` summary per run (scanned, deleted, skipped-young,
skipped-referenced, duration), `debug` per delete, and `warn` on a failed delete.

Failed writes still check the current row before deleting their own object: a lost commit acknowledgement
must not delete a committed archive, and an unreadable reference is treated as do-not-delete.
`ensureObjectPresent` retains the replacement's post-commit HEAD and restore behavior. `remove()` still
deletes the removed row's current object inline; the existing grace period, batch limits and failure
handling do not change.

During a mixed deployment, older writers can still reuse their content-hash keys and remain exposed
to the original check-then-delete race. The independent-key guarantee requires all writers to use the
new allocation rule. Reading legacy keys is compatible, but does not repair an archive already missing
from storage.

## Upload transport

**Bundles stream through the Server rather than being handed out as presigned URLs.** The route is an
octet-stream pass-through with an exact `Content-Length`, and the Server verifies the
`x-opentag-skill-sha256` header before storing — the pattern already used by
`packages/server/src/api/runner-workspace.ts`.

Presigned URLs would push the bucket's authorization model into the browser or CLI, leave uploads
uncapped, and split the authorization decision across two systems. Streaming keeps the bucket private
and keeps authorization in one place; bundles are capped at 16 MiB, so the bandwidth cost of proxying
them is small.

Upload requests carry these headers:

| Header | Meaning |
| --- | --- |
| `x-opentag-skill-sha256` | Lowercase hex SHA-256 of the uploaded bytes |
| `x-opentag-skill-format` | `tar.gz` or `zip`; omitted means `tar.gz` |
| `x-opentag-skill-replace` | Present to replace an existing Skill with the same name |
| `Content-Type` | `application/octet-stream` |

## HTTP surfaces

Exactly three surfaces exist, and they are listed as templates in
`packages/shared/src/http-paths.ts` so that Server, Client and Web build links from the same source.
Every builder percent-encodes its arguments.

| Surface | Authentication | Templates |
| --- | --- | --- |
| Account (Web, human CLI) | User session | `/api/v1/agents/:agentId/skills`, `/api/v1/agents/:agentId/skills/:skillId`, `/api/v1/agents/:agentId/skills/:skillId/bundle` |
| Computer (machine token) | Computer machine token; the Agent must be bound to the authenticated Computer | `/api/v1/computer/agents/:agentId/skills`, `/api/v1/computer/agents/:agentId/skills/:skillId/bundle` |
| Agent CLI (session proof) | Session proof file | `/api/v1/runtime/skills`, `/api/v1/runtime/skills/:name/bundle` |

The Computer surface repeats the Agent id because a Computer may be bound to several Agents and must
name which one it is syncing. The Agent CLI surface deliberately takes no Agent id: the agent is
always the one the session proof resolves to, and a request can never name a different Agent. The
preset catalog below adds resources to the Account and Agent CLI planes rather than a fourth plane,
the same way remote installation does.

## Deployment configuration

**Storage is optional at deploy time.** The environment group is:

```
OPENTAG_SKILL_STORAGE_ENDPOINT
OPENTAG_SKILL_STORAGE_REGION
OPENTAG_SKILL_STORAGE_BUCKET
OPENTAG_SKILL_STORAGE_ACCESS_KEY_ID
OPENTAG_SKILL_STORAGE_SECRET_ACCESS_KEY
OPENTAG_SKILL_STORAGE_PREFIX
OPENTAG_SKILL_STORAGE_FORCE_PATH_STYLE
OPENTAG_SKILL_STORAGE_GC_INTERVAL_SECONDS
OPENTAG_SKILL_STORAGE_GC_GRACE_SECONDS
```

The two `GC_` values are only meaningful when storage is enabled:
`OPENTAG_SKILL_STORAGE_GC_INTERVAL_SECONDS` defaults to one hour and `0` disables the collector,
`OPENTAG_SKILL_STORAGE_GC_GRACE_SECONDS` defaults to one day with a floor of 300 seconds.
`OPENTAG_SKILL_STORAGE_PREFIX` defaults to `skills`; it is normalized (see above), and a value whose
segments are empty or a traversal fails the parse at startup.

Routes are always registered, because a self-hosted deployment without object storage should still
be able to manage Skills. Without storage, listing still works and reports `storage: "unavailable"`;
any bundle read or write fails with `SKILL_STORAGE_UNAVAILABLE`. The UI uses that status to disable
upload/download rather than presenting a dead button.

## Delivery to the Computer

**Delivery happens at provider runtime start**, next to Context Tree preparation in
`packages/client/src/runtime/session-runtime-manager.ts`, over HTTP with the machine token — not over
the runtime WebSocket, whose frames are capped at 64 KiB and which carries control, not bulk content.

The Computer fetches the runtime manifest (enabled Skills only), then each bundle it does not already
have, verifies the sha256, and materializes it:

| Provider | Target |
| --- | --- |
| Claude Code | `<workspace>/.claude/skills/<name>/` |
| Codex | Agent-scoped only: `<workspace>/.agents/skills/<name>/`, or a per-Agent `CODEX_HOME`; otherwise out of v1 |
| Pi | explicit `--skill <path>` arguments |

**Codex materialization must be Agent-scoped.** The only acceptable targets are the workspace's
`.agents/skills` or a per-Agent `CODEX_HOME`. The OS account home's `.agents/skills` is shared by
every Agent on the Computer and is **never** a target or a fallback — writing there would expose one
Agent's Skills to its siblings, which is exactly what per-Agent ownership exists to prevent. If
neither Agent-scoped option works on the target Codex version, Codex is out of v1 rather than falling
back to the shared account home.

Every platform-managed directory carries a `.opentag-skill.json` marker containing the Skill id and
the archive sha256. **Sync only ever touches directories carrying that marker**, so a Skill an Agent
is authoring locally, and every Context Tree skill, are never modified or deleted.

**Sync failure is soft.** A failed fetch or a storage outage logs a warning and the turn proceeds with
whatever is already on disk. Losing Skills must never cost the Agent its turn — the same principle
the MCP gateway applies to an unreachable upstream.

## Uploading from the Agent

`opentag skill push <dir>` uploads a locally authored Skill and is authenticated by the session proof
file (`OPENTAG_SESSION_PROOF_FILE`), the same mechanism `opentag session create` uses. The Agent id
comes from the proof; the command cannot target another Agent. A pushed Skill lands under the
`agent_upload` source and the same validation as any other upload.

**Push then sync.** When the pushed directory is the Skill's own materialization target — for example
a Skill the Agent authored in `<workspace>/.claude/skills/<name>` — the CLI writes the
`.opentag-skill.json` marker into that directory after the upload succeeds, so the directory becomes
platform-managed. From then on a Web replace, disable, or delete reaches that Agent on the next sync
like any other Skill, instead of the local copy looking unmanaged and being left alone.

Push also reports name collisions: if the manifest name matches a directory that does not carry the
marker, that directory is skipped and the collision is reported rather than overwritten, because an
unmarked directory may be something the Agent is still authoring.

Sync completes the loop by removing marked directories that are absent from the runtime manifest — a
Skill that was disabled or deleted. Ownership stays one-way: the platform is the source of truth for
every directory it manages.

## Installing from a remote source

A Skill no longer has to be built locally and uploaded. An operator can paste a public address from
the open skills ecosystem into an Agent's Skills page, preview what it publishes, and install a
selection; the result is an ordinary Skill with `source = url_install`. The whole feature — accepted
source forms, discovery rules, the outbound policy, and the per-item install semantics — is specified
in `docs/design/skill-remote-install.md`; what matters here is that it adds no new storage, no new
row shape, and no new runtime behaviour. Installation goes through `SkillService.upload`, so the
archive contract and the per-Agent ownership rules above apply unchanged, and a name conflict is
skipped rather than replaced.

Two Account-scoped routes carry it, both outside the upload transport's octet-stream scope:
`POST /api/v1/agents/:agentId/skills/install/resolve` reads a source and returns its candidates, and
`POST /api/v1/agents/:agentId/skills/install` installs the selected names. So the "exactly three
surfaces" above still holds — those are the three authentication planes — and this adds resources to
the Account one rather than a fourth plane.

## The preset Skill catalog

An Agent with no Skills has no way in unless its user already has an archive or knows a public
source. The preset catalog closes that gap the way the MCP marketplace catalog does: a curated set of
Skills the platform's own team ships, which a user can browse and install in one action.

**The catalog is committed repository data in `packages/skill-presets` (`@opentag/skill-presets`),
not a service.** The package holds `skills/<name>/` bundles and `presets.yaml` (category ids from the
shared taxonomy, display order). `scripts/generate-skill-presets.mjs` packs every bundle with the same
`packSkillDirectory` the upload uses, validates manifest/directory agreement, category integrity, the
per-archive ceilings and the total catalog budget, and writes the committed
`packages/skill-presets/src/presets.gen.ts` with metadata and base64 archives. `pnpm
presets:generate` writes it; `pnpm check` runs the same script with `--check` and fails on drift, so a
bundle the Server would refuse fails the pull request that wrote it.

**Packing is byte-stable across platforms, because the committed module is drift-checked.** A checked-in
artifact whose bytes depend on the host cannot be verified: `node:zlib` output differs between the
toolchains the repository supports (a macOS and a Linux checkout disagree on the same tar at the same
level), so a clean macOS checkout would fail the drift check and regenerating there would move the
drift to Linux. `packSkillDirectory` therefore compresses with `fflate` (pure JavaScript, one input has
one encoding everywhere) and pins the gzip MTIME to zero, which otherwise defaults to `Date.now()` and
would make every pack differ from the last. The tar layer is already canonical: fixed entry order,
zeroed mtimes, normalized modes. `packages/client/src/__tests__/skill-archive.test.ts` asserts both
properties — repeated packs are byte-identical with a zeroed MTIME, and packing fails the test if it
ever reaches for the host compressor.

**The Server serves canonical archive identity.** The generator packs with the Client packer, whose
bytes differ from the Server's canonical repack (compression level, directory entries), so
`SkillPresetService` normalizes each packaged archive once through `normalizeSkillArchive` before it
is served or compared. The catalog's `archiveSha256`, `archiveBytes`, and `fileCount` are therefore
the values an installed row will carry, and a fresh install reads back as `installed` rather than as
a permanent false update.

Two Account-scoped and two session-proof routes expose it:

| Surface | Templates | Meaning |
| --- | --- | --- |
| Account | `GET /api/v1/agents/:agentId/skill-presets`, `POST /api/v1/agents/:agentId/skill-presets/:presetName/install` | Web and the human CLI; ownership is resolved exactly as for Skills |
| Agent CLI | `GET /api/v1/runtime/skill-presets`, `POST /api/v1/runtime/skill-presets/:presetName/install` | The proof resolves the Agent; no request field can select another |

A catalog response lists the categories and, per preset, its name, description, category, order,
canonical archive identity, and the target Agent's state:

| State | Meaning |
| --- | --- |
| `not_installed` | No same-named Skill exists |
| `installed` | The same-named Skill's `archive_sha256` matches |
| `update_available` | The same-named Skill differs and its `source` is `preset` |
| `name_conflict` | The same-named Skill differs and came from any other source |

**Install is a named write, not an upload.** The Server maps the state to `SkillService.upload`
(`source: "preset"`): `not_installed` inserts, `update_available` replaces and bumps the revision,
`installed` returns the existing row as `unchanged`, and `name_conflict` fails with
`SKILL_NAME_CONFLICT` without touching the row. Because `update_available` requires
`source === "preset"`, the catalog can never overwrite content a user uploaded: replacing a
preset-installed Skill through an upload writes that source, and the preset reads back as a conflict.

**A preset replaces exactly the row it read.** `update_available` is decided from a catalog read, so the
write carries that row as its expectation (`SkillUploadInput.expectedRow`: id, revision, provenance) and
the guard runs inside the write path against the same read the conditional update uses. Without it, a
user upload landing between the two — a Web or CLI replace of the same name — would still satisfy a bare
`replace: true`, and the preset would overwrite the user's content and stamp `source: "preset"` over it.
With it, that write loses as `SKILL_REVISION_CONFLICT`, the re-read classifies the row by its new
provenance, and the install reports `SKILL_NAME_CONFLICT`. Two racing installs converge — the loser of
the insert or revision race re-reads once and reports `unchanged` or re-runs the update it meant to.
Renaming or removing a preset orphans the installed copy, which stops appearing in the catalog and is
removed by hand; the Server never auto-prunes it.

Web surfaces the catalog as a Presets dialog on the Agent's Skills page, and
`opentag skill preset list [--agent <id>]` / `opentag skill preset install <name> [--agent <id>]`
surface it to the human CLI; inside a managed Session the same commands act on the session's Agent
and refuse `--agent`, exactly like the rest of `opentag skill`.

## Cloud sandboxes

**v1 covers Local Computers only.** Cloud sandboxes run Pi through a separate runner composition and
would need two additions before they can consume Skills: a runner-authenticated route (the runner has
no machine token the Computer surface accepts today) and `--skill` argument assembly in
`packages/client/src/runner/cloud-turn-worker.ts`. Both are follow-ups; nothing here promises them.

## Limits

| Constant | Value | Meaning |
| --- | --- | --- |
| `SKILL_ARCHIVE_MAX_BYTES` | 16 MiB | Maximum stored archive size |
| `SKILL_UNPACKED_MAX_BYTES` | 64 MiB | Maximum total unpacked size (zip-bomb guard) |
| `SKILL_MAX_ENTRIES` | 1000 | Maximum archive members |
| `SKILL_MAX_PATH_BYTES` | 256 | Maximum member path length |
| `SKILL_MANIFEST_MAX_BYTES` | 256 KiB | Maximum `SKILL.md` size for parsing |
| `SKILL_MAX_PER_AGENT` | 64 | Maximum Skills owned by one Agent |
| `SKILL_DESCRIPTION_MAX_LENGTH` | 1024 | Maximum manifest description length |
| `SKILL_MAX_LISTED_FILES` | 500 | Maximum files returned in a Skill detail |
| `SKILL_MANIFEST_FILE` | `SKILL.md` | The required manifest filename |
| `SKILL_MARKER_FILE` | `.opentag-skill.json` | The marker that identifies a platform-managed directory |

Skill creation counts enabled and disabled rows toward the same 64-Skill limit. Archive validation,
packing and object PUT happen before the database transaction. Final admission locks the current
Agent with `FOR NO KEY UPDATE`, rechecks its owner and undeleted status, and checks the current
name/count before inserting. Concurrent creation on one Agent therefore shares one final decision;
a conflicting name retains `SKILL_NAME_CONFLICT`, while a new name without a slot gets
`SKILL_LIMIT_REACHED`. Replacements keep their existing row/revision CAS and do not consume a slot.
A failed admission uses the existing reference-aware object cleanup; an uncertain commit never
justifies deleting a possibly referenced object.

Names are 1–64 characters of lowercase letters, numbers, and single hyphens; they may not start or
end with a hyphen and may not contain consecutive hyphens (`SkillNameSchema`). Ten names are reserved
because openTag already ships them and an upload must not shadow them: the six `context-tree-*`
skills plus `git`, `gh`, `lark-cli`, and `slack`. The reserved list is copied from the Client's runner
skill directories and the Client lane adds a parity test, because `@opentag/shared` may not depend on
the Client package.

## Error codes

| Key | Code | Category | HTTP status |
| --- | --- | --- | --- |
| `NOT_FOUND` | `SKILL_NOT_FOUND` | deterministic | 404 |
| `PRESET_NOT_FOUND` | `SKILL_PRESET_NOT_FOUND` | deterministic | 404 |
| `NAME_CONFLICT` | `SKILL_NAME_CONFLICT` | deterministic | 409 |
| `REVISION_CONFLICT` | `SKILL_REVISION_CONFLICT` | deterministic | 409 |
| `LIMIT_REACHED` | `SKILL_LIMIT_REACHED` | deterministic | 409 |
| `NAME_RESERVED` | `SKILL_NAME_RESERVED` | validation | 400 |
| `MANIFEST_INVALID` | `SKILL_MANIFEST_INVALID` | validation | 400 |
| `ARCHIVE_INVALID` | `SKILL_ARCHIVE_INVALID` | validation | 400 |
| `HASH_MISMATCH` | `SKILL_HASH_MISMATCH` | validation | 400 |
| `ARCHIVE_TOO_LARGE` | `SKILL_ARCHIVE_TOO_LARGE` | validation | 413 |
| `STORAGE_UNAVAILABLE` | `SKILL_STORAGE_UNAVAILABLE` | transient | 503 |

The categories carry the retry meaning the rest of the platform uses: `validation` and
`deterministic` failures will fail again unchanged, while `transient` failures are worth retrying.

## First-party Skill bundles in this repository

A Skill the platform's own team owns is authored as a bundle under one of two homes, both with a root
`SKILL.md` and supporting files — the same shape an operator authors.

`packages/skill-presets/skills/<name>/` is the **preset catalog**: these bundles ship with the
product and are discoverable and installable through the routes above. One lives there today:
`mcp-onboarding` tells an Agent to configure an MCP Server inside the current chat. The Agent branches on
the operation first. An enable, disable, remove, or reauthorize request uses the mounted name from `self mcp
list` and does not search or add. A new connection checks mounted and available definitions. A mounted Server
whose authorization is missing, expired, revoked, or in error stays on that binding. A pending authorization
waits on the link already sent and does not start a new OAuth flow. A Bearer key for an existing mount is
written with `self mcp use`, not with another `add`. The Agent does not create a second definition. The Agent
searches the catalog only when neither list has the Server, and asks the user to paste an MCP configuration
when the catalog has no installable match. A reply that sends the user to the web console or the Connectors
page is the failure this Skill forbids. The OAuth consent screen is the step only a human takes.

Root `skills/<name>/` is the home for a first-party bundle that is not part of the discoverable
catalog. `mcp-catalog-entry` lives there today: the operator's procedure for recording a remote
Server in the marketplace catalog — the facts to collect from the provider, the entry and icon rules,
and the gates to run. Nothing under root `skills/` ships automatically: an operator uploads one with
`opentag skill push skills/<name>`, which stores it as that Agent's Skill like any other upload; the
repository is where the content is reviewed and versioned, not a delivery channel.
`skills/skill-preset-entry/` is one such root bundle: the procedure for recording a bundle into the
preset catalog. It carries the manifest, identity, category, and order rules, the `presets.yaml` row
shape, the generator's refusal list, and the gates, so a contributor enters a Skill correctly on the
first pass.

`pnpm check` runs the preset generator over `packages/skill-presets` and
`scripts/check-skill-bundles.mjs` over every root bundle, so a bundle the Server would refuse fails in
the pull request that wrote it rather than at an operator's upload. The checker packs each bundle with
the same `packSkillDirectory` the upload uses instead of restating its rules: a missing or unreadable
manifest, a reserved name, a symlinked bundle root or member, an unsupported entry, the path, entry,
unpacked and packed byte ceilings, and a name that disagrees with its directory are all decided here.
It reads `@opentag/shared` from source through `scripts/tsconfig.scripts.json`, because `pnpm check`
runs before `pnpm build`.

`pnpm presets:check-candidate <candidate-directory>` pre-flights a bundle that is not in the
repository yet. It packs the candidate with the same `packSkillDirectory` and applies the catalog
rules the packer cannot know: a name already declared in `presets.yaml`, a category that file does
not declare, an order the shared contract rejects, and a directory name that disagrees with the
manifest. It is read-only, and `pnpm presets:generate` with `pnpm check` remain the gate.
