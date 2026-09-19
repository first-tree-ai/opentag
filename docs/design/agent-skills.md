# Agent Skills

> **Status: only the shared contract is delivered at this commit.**
>
> This commit delivers the `@opentag/shared` runtime schemas, constants, HTTP path templates, the
> manifest parser, and this document — the contract layer. The Server, Client/CLI and Web lanes are
> planned and not implemented here.
>
> Delivered now: `packages/shared/src/skill.ts`, the Agent Skill entries in
> `packages/shared/src/http-paths.ts`, their public exports, and unit tests.
>
> Not yet delivered: the `agent_skills` table and its migration, the `SkillObjectStore` and its S3
> adapter, the three HTTP route surfaces, CLI `skill` commands, Web UI, and runtime materialization
> on a Computer. Nothing in this repository serves or consumes a Skill yet.

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
faithfully rather than guessing. **`name` and `description` must be strings.** A collection value is
rejected the way the Agent Skills reference validator rejects it — a flow list or map
(`description: [read, write]`, `description: {purpose: read files}`) and a block sequence or mapping
after the key (`description:` followed by `- item` lines or `purpose: read files`). Folding a
collection into a string first would accept a `SKILL.md` that is not a valid Skill manifest. The
manifest description is trimmed of leading and trailing whitespace, because a block scalar's chomping
indicator otherwise leaves a trailing newline in a value that is stored and shown as a single line.

Because the Server re-packs deterministically, **the stored `sha256` is the Server's, not the
uploader's.** The `x-opentag-skill-sha256` header is an integrity check on the transfer, not a claim
the Server copies into the row.

## Object storage

**Skills are stored in S3-compatible object storage behind a `SkillObjectStore` interface**
(`put`/`get`/`head`/`delete`), with an S3 adapter built on `aws4fetch` and an in-memory fake for
tests — the same interface/adapter/fake shape as `WorkspaceObjectStore` in
`packages/server/src/services/sandboxes/workspace-object-store.ts`.

`aws4fetch` is chosen over the AWS SDK v3 because it is SigV4 over `fetch` with zero transitive
dependencies and no default-checksum behaviour, which several S3-compatible services reject. The
adapter supports path-style addressing for services that require it.

**Object keys are derived server-side and never supplied by a caller:**

```
<prefix>/accounts/<accountId>/agents/<agentId>/skills/<skillId>/<sha256>.tar.gz
```

Keying by content hash makes a replace safe without a lock: write the new key, update the row, then
best-effort delete the old key. A reader either sees the old row with the old key or the new row with
the new key; it never sees a torn object, and an orphaned object left by a failed delete is harmless
and can be swept later.

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
always the one the session proof resolves to, and a request can never name a different Agent.

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
```

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

Names are 1–64 characters of lowercase letters, numbers, and single hyphens; they may not start or
end with a hyphen and may not contain consecutive hyphens (`SkillNameSchema`). Ten names are reserved
because OpenTag already ships them and an upload must not shadow them: the six `context-tree-*`
skills plus `git`, `gh`, `lark-cli`, and `slack`. The reserved list is copied from the Client's runner
skill directories and the Client lane adds a parity test, because `@opentag/shared` may not depend on
the Client package.

## Error codes

| Key | Code | Category | HTTP status |
| --- | --- | --- | --- |
| `NOT_FOUND` | `SKILL_NOT_FOUND` | deterministic | 404 |
| `NAME_CONFLICT` | `SKILL_NAME_CONFLICT` | deterministic | 409 |
| `LIMIT_REACHED` | `SKILL_LIMIT_REACHED` | deterministic | 409 |
| `NAME_RESERVED` | `SKILL_NAME_RESERVED` | validation | 400 |
| `MANIFEST_INVALID` | `SKILL_MANIFEST_INVALID` | validation | 400 |
| `ARCHIVE_INVALID` | `SKILL_ARCHIVE_INVALID` | validation | 400 |
| `HASH_MISMATCH` | `SKILL_HASH_MISMATCH` | validation | 400 |
| `ARCHIVE_TOO_LARGE` | `SKILL_ARCHIVE_TOO_LARGE` | validation | 413 |
| `STORAGE_UNAVAILABLE` | `SKILL_STORAGE_UNAVAILABLE` | transient | 503 |

The categories carry the retry meaning the rest of the platform uses: `validation` and
`deterministic` failures will fail again unchanged, while `transient` failures are worth retrying.

## Verification

Unit tests in `packages/shared/src/__tests__/skill.test.ts` (no network, no database):

| Area | What is asserted |
| --- | --- |
| Name rules | 64-character names accepted; uppercase, leading/trailing hyphen, consecutive hyphens, 65-character, empty, underscore, and space names rejected; every reserved name rejected and an ordinary name accepted |
| Manifest parser | Plain (including multi-line, folded like `>`) and single-/double-quoted (including doubled quotes and escapes) scalars; folded `>` and literal `|` block scalars; `-`/`+` chomping; paragraph breaks; CRLF endings; unknown top-level keys ignored with nested maps and block sequences; block-scalar descriptions trimmed of leading and trailing whitespace; a `|` block containing `- item` lines is still a string |
| Manifest rejection | Missing frontmatter, unterminated frontmatter, an indented line with no preceding key, missing `name` or `description`, a duplicate `name`/`description`, an inline comment on a plain value, a collection value for `name`/`description` (flow list/map or block sequence/mapping), invalid name, over-long, empty or whitespace-only description, and input past `SKILL_MANIFEST_MAX_BYTES`, each with a specific reason; malformed input never throws |
| Resource schemas | Round trips for `SkillSchema`, `SkillDetailSchema`, `ListAgentSkillsResponseSchema`, `RuntimeSkillManifestSchema` and `SkillInstallMarkerSchema`; rejection of a bad sha, `revision: 0`, an over-limit archive, an over-limit runtime list, and unknown keys |
| Error codes | Every code has metadata, every metadata key is a known code, and each status/category matches the table |
| HTTP paths | Each builder produces the expected string and percent-encodes arguments containing spaces and slashes |

`packages/shared/src/__tests__/public-exports.test.ts` additionally asserts that every new symbol is
part of the public `@opentag/shared` export surface via the checked-in snapshot.

Server, Client/CLI and Web tests do not exist yet because those lanes are not implemented. When they
land, the verification they owe is an end-to-end path: upload a Skill through each of the three
surfaces, and observe a Local Computer materialize it into the provider's skill directory at runtime
start.
