# Skills distribution

How an Account's skill library is stored on the Server, assigned to Agents, and synced to the Computers that run
them. This document covers the Server side (schema, storage, HTTP API, sync protocol); the Web UI and the daemon
sync are delivered separately and only depend on the contract described here.

## Goals

- Manage skills from the Web: upload, delete, download, and read `SKILL.md`. No online editing, and no way to read
  any file other than `SKILL.md` through the API.
- The list shows every skill's `name` and `description`, read from the `SKILL.md` frontmatter at upload time.
- One version per skill. Uploading the same name again replaces it.
- An Agent can publish a skill it created locally from inside a Session, without leaving the conversation.
- Each Agent receives only the skills assigned to it, and the daemon can decide offline whether anything changed.

## Package format

A skill is a zip archive containing a `SKILL.md` at the root, or exactly one top-level directory that contains it.
The wrapping directory is stripped; the frontmatter `name` is authoritative for the stored name and the local
directory name.

`SKILL.md` starts with a YAML frontmatter block:

```markdown
---
name: my-skill
description: One sentence about what the skill does.
---
```

`name` must match `^[a-z0-9][a-z0-9-]{0,63}$`; `description` is 1 to 1024 characters. Other frontmatter keys are
kept verbatim and not interpreted.

Validation rules applied to every upload, with the error code the API returns:

| Rule | Limit | Code |
| --- | --- | --- |
| Media type | `application/zip` | 415 `SKILL_ARCHIVE_UNSUPPORTED_MEDIA_TYPE` |
| Archive size | 5 MiB | 413 `SKILL_ARCHIVE_TOO_LARGE` |
| Expanded size | 20 MiB, checked against declared sizes before anything is inflated | 400 `SKILL_ARCHIVE_TOO_LARGE` |
| File count | 200 | 400 `SKILL_ARCHIVE_TOO_MANY_FILES` |
| Paths | no `..`, absolute paths, backslashes, control characters, empty segments; segment <= 255 bytes, path <= 1024 bytes; no symbolic links or non-regular entries; no case-insensitive duplicates | 400 `SKILL_ARCHIVE_INVALID_PATH` |
| Malformed zip | encrypted, zip64, multi-disk, or corrupt archives | 400 `SKILL_ARCHIVE_INVALID` |
| `SKILL.md` | required, UTF-8, <= 256 KiB, valid frontmatter | 400 `SKILL_MANIFEST_INVALID` with `details.field` |
| Name conflict | existing name without `?onConflict=replace` | 409 `SKILL_ALREADY_EXISTS` |
| Per-account quota | 200 skills | 400 `SKILL_QUOTA_EXCEEDED` |

File modes are normalized: regular files keep only the executable bit (`0755`) or become `0644`; setuid, setgid,
and sticky bits are dropped. `__MACOSX/` entries are ignored.

## Manifest and digests

After validation the Server repacks the files deterministically (sorted paths, fixed timestamps, Unix attributes,
deflate level 6), so equal content always yields an identical archive and `archiveSha256`.

The canonical manifest lists every file with its `sha256`, `size`, and `mode`, sorted by path in UTF-8 byte order:

```json
{ "schemaVersion": 1, "name": "my-skill", "files": [{ "path": "SKILL.md", "sha256": "…", "size": 812, "mode": "0644" }] }
```

- Skill digest: `sha256(JSON.stringify(canonical manifest))`. Independent of zip metadata; the daemon can recompute it
  from files on disk.
- Agent digest: `sha256(sorted("<name>:<digest>").join("\n"))` over the skills assigned to that Agent. An empty set
  yields `sha256("")` (`EMPTY_AGENT_SKILLS_DIGEST` in `@opentag/shared`).

Both are pure functions exported from `@opentag/shared` (`computeSkillDigest`, `computeAgentSkillsDigest`).

## Data model

Migration `0041_far_quentin_quire` adds three tables:

- `skills` — one row per `(owner_account_id, name)`: `description`, the full `skill_md`, `digest`, `archive_key`,
  `archive_bytes`, `archive_sha256`, `file_count`, `total_bytes`, `updated_by_kind` (`user` | `session`),
  `updated_by_id`, timestamps. Owner deletion cascades.
- `skill_files` — the manifest entries (`path`, `sha256`, `size`, `mode`) per skill; no file content.
- `agent_skills` — `(agent_id, skill_id, assigned_at)`, cascading from both sides.

Storing `SKILL.md` in the database lets the list and the viewer answer without touching object storage.

## Object storage

Archives live in an S3-compatible bucket at `<prefix><owner>/<skillId>/<digest>.zip`. Objects are content-addressed
and never rewritten: an upload writes the new object first, then commits the row in one transaction, then deletes
the previous object best-effort. A failed transaction deletes the object it just wrote. A daily sweeper
(`SkillOrphanSweeper`) lists the prefix and deletes objects older than one hour that no `archive_key` references.

Configuration (all optional as a group; without a bucket the skill routes answer 503 `SKILL_STORAGE_UNAVAILABLE`):

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENTAG_SKILL_STORAGE_S3_BUCKET` | — | Enables the feature. |
| `OPENTAG_SKILL_STORAGE_S3_ENDPOINT` | — | S3-compatible endpoint; leave empty for AWS. GCS: `https://storage.googleapis.com`. HTTPS required outside `dev`. |
| `OPENTAG_SKILL_STORAGE_S3_REGION` | `auto` | SigV4 region. GCS accepts any value. |
| `OPENTAG_SKILL_STORAGE_S3_ACCESS_KEY_ID` | — | Required with the bucket. GCS: the service account's HMAC access ID. |
| `OPENTAG_SKILL_STORAGE_S3_SECRET_ACCESS_KEY` | — | Required with the bucket. Never logged. |
| `OPENTAG_SKILL_STORAGE_S3_PREFIX` | `skills/` | Relative key prefix; a trailing `/` is added. |
| `OPENTAG_SKILL_STORAGE_S3_FORCE_PATH_STYLE` | `true` | Path-style addressing; needed by MinIO and GCS. |

The SDK client is created with `requestChecksumCalculation` and `responseChecksumValidation` set to `WHEN_REQUIRED`:
the CRC32 trailers newer AWS SDKs add by default are rejected by the Google Cloud Storage XML API, and archives are
already verified by `archiveSha256`. No tagging, ACLs, or SSE-KMS are used. Objects stay under 5 MiB, so no multipart.

Google Cloud Storage setup: create a bucket with uniform bucket-level access and no public access; create a service
account with `roles/storage.objectAdmin` on that bucket only; create an HMAC key for it under Cloud Storage
Settings > Interoperability; set the variables above. Use separate buckets for staging and production.

Local development: `docker run -p 9000:9000 minio/minio server /data` with `OPENTAG_SKILL_STORAGE_S3_ENDPOINT=http://127.0.0.1:9000`
and the MinIO root credentials, then create the bucket once.

## HTTP API

Account routes (cookie + CSRF or bearer; every query is scoped to the caller's Account, other Accounts' resources are 404):

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/v1/skills?cursor&limit` | `ListSkillsResponse`, ordered by name, `limit` 1..100 (default 50), cursor is the last name |
| POST | `/api/v1/skills?onConflict=fail|replace` | body `application/zip`; 201 created / 200 replaced with `SkillDetail` |
| GET | `/api/v1/skills/:name` | `SkillDetail` (summary plus manifest) |
| GET | `/api/v1/skills/:name/skill-md` | `text/markdown; charset=utf-8`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff` |
| GET | `/api/v1/skills/:name/archive` | zip download; `ETag: "<archiveSha256>"`, `Content-Length`, `If-None-Match` yields 304 |
| DELETE | `/api/v1/skills/:name` | 204; assignments are removed, the object is deleted |
| GET | `/api/v1/skills/:name/agents` | `SkillAgentsResponse` |
| GET | `/api/v1/agents/:agentId/skills` | `AgentSkillsResponse` with the Agent's digest |
| PUT | `/api/v1/agents/:agentId/skills` | body `{ skillNames: string[] }`, replaces the whole set; unknown names are 400 `SKILL_NOT_FOUND` with `details.missing` |

Computer routes (machine token):

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/v1/runtime/skills?agentId` | `RuntimeSkillsManifest`: every active Agent on the Computer with its digest and per-skill manifests |
| GET | `/api/v1/runtime/skills/:name/archive` | the archive, only when the skill is assigned to an Agent on that Computer; same ETag handling |
| POST | `/api/v1/runtime/sessions/:sessionId/skills?onConflict` | in-session push under the Session CLI proof header; the skill is stored for the Session's owner, recorded as `updatedBy: { kind: "session" }`, and assigned to the Session's Agent |

Path templates and helpers live in `@opentag/shared` (`skillByNamePath`, `runtimeSkillsPath`, and so on); clients
must use them rather than string templates.

## Sync protocol

- The effective runtime snapshot carries `skills: { digest }` for the Agent; it participates in the agent config hash,
  so a changed assignment set makes the next reconcile observable to the daemon.
- After an upload, replacement, deletion, or assignment change the Server sends `skills:changed { agents: [{ agentId,
  digest }] }` to the online Computers hosting the affected Agents, but only over connections that negotiated the
  `runtime.skillsSync` capability (version 1). Delivery is best effort; a daemon that misses a frame converges on its
  next reconcile or periodic check.
- The daemon compares the Agent digest, then per-skill digests, then per-file hashes, and downloads only what changed.

## Security

- Two independent hardened unpackers (Server and daemon) apply the same rules: traversal, absolute paths, links,
  control characters, declared-size checks before inflating, entry limits, mode normalization.
- Object storage credentials stay inside the Server process; browsers and daemons always go through the Server, and
  keys are generated by the Server without user input.
- A Computer can only read skills assigned to its own Agents; assignment requires the caller to own both the Agent
  and every skill; in-session pushes derive the owner from the proof, never from the request body.
- `SKILL.md` is served as markdown with `nosniff` and `inline`; archives as attachments.
- Skills contain code the Agent will run. Uploading from the Web and pushing from a Session both accept the content
  as-is; only trusted sources should be uploaded.
