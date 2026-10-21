# Agent Skills: verification and acceptance

Test and acceptance material for [Agent Skills](../../docs/system/capabilities/agent-skills.md).

## Verification

Unit tests in `packages/shared/src/__tests__/skill.test.ts` (no network, no database):

| Area | What is asserted |
| --- | --- |
| Name rules | 64-character names accepted; uppercase, leading/trailing hyphen, consecutive hyphens, 65-character, empty, underscore, and space names rejected; every reserved name rejected and an ordinary name accepted |
| Manifest parser | Plain (including multi-line, folded like `>`) and single-/double-quoted (including doubled quotes and escapes) scalars, with a quoted scalar starting on the key line or a continuation line and spanning lines; folded `>` and literal `|` block scalars; `-`/`+` chomping; paragraph breaks; CRLF endings; unknown top-level keys ignored with nested maps and block sequences; block-scalar descriptions trimmed of leading and trailing whitespace; a `|` block containing `- item` or `key: value` lines is still a string |
| Manifest rejection | Missing frontmatter, unterminated frontmatter, an indented line with no preceding key, missing `name` or `description`, a duplicate `name`/`description`, an inline comment on a plain value, a structurally collection-valued `name`/`description` (every plain-scalar start indicator, block sequence/mapping, explicit `? key`/`: value`, flow list/map on the key line or a continuation line, a mapping key after a quote), a plain value containing `: ` or ending in `:`, a plain value that YAML resolves to null/boolean/number/date, invalid name, over-long, empty or whitespace-only description, and input past `SKILL_MANIFEST_MAX_BYTES`, each with a specific reason; malformed input never throws |
| Resource schemas | Round trips for `SkillSchema`, `SkillDetailSchema`, `ListAgentSkillsResponseSchema`, `RuntimeSkillManifestSchema` and `SkillInstallMarkerSchema`; rejection of a bad sha, `revision: 0`, an over-limit archive, an over-limit runtime list, and unknown keys |
| Error codes | Every code has metadata, every metadata key is a known code, and each status/category matches the table; a `SKILL_REVISION_CONFLICT` failure round-trips through the shared error envelope |
| HTTP paths | Each builder produces the expected string and percent-encodes arguments containing spaces and slashes |

`packages/shared/src/__tests__/public-exports.test.ts` additionally asserts that every new symbol is
part of the public `@opentag/shared` export surface via the checked-in snapshot.

The Server and Web lanes add the coverage those layers owe:

| Suite | What is asserted |
| --- | --- |
| `packages/server/src/__tests__/skill-service.test.ts` | Ownership isolation, CRUD and limits, the three surfaces' views, storage degradation, and that a replace leaves the previous object for the GC rather than deleting it inline |
| `packages/server/src/__tests__/skill-service-concurrency.test.ts` | The "a committed row never points at a deleted object" invariant across racing writers and store failures, including the post-commit restore |
| `packages/server/src/__tests__/skills-route.test.ts` | Auth on all three surfaces, the Skill error envelope (including `SKILL_REVISION_CONFLICT`), upload preconditions, and `content-disposition` on the account, computer, and runtime bundle responses plus the fallback for a hostile name |
| `packages/server/src/__tests__/s3-skill-object-store.test.ts` | Signing, path-/virtual-hosted URLs, status mapping, secret redaction, and the `list` request shape, XML parsing (including an escaped key), continuation, and malformed/invalid responses |
| `packages/server/src/__tests__/skill-object-gc.test.ts` | Deleting an old orphan, keeping a young or referenced object, keeping a key that becomes referenced between listing and deletion, ignoring non-Skill keys, the exact-prefix binding (a live object under a nested prefix and an adjacent sibling are never collected, across two databases), collecting an orphan under a slash-spelled prefix, pagination, the per-run cap, a failed delete continuing the run, and the replace→collect round trip |
| `packages/server/src/__tests__/skill-object-prefix.test.ts` | The bound key matcher (exact match, extra namespace segment, different prefix with a valid tail, a string-prefix of the first segment, malformed tail) and the normalizer (leading/trailing/repeated slashes, empty and all-slash rejected, traversal rejected) |
| `packages/server/src/__tests__/skill-preset-service.test.ts` | Per-Agent preset state, install/update semantics and provenance on both install surfaces over a real `SkillService`, and that a user upload landing between the catalog read and the preset write survives — the preset replaces only the row it read |
| `packages/server/src/__tests__/integration/skills-api.test.ts` | The account lifecycle and Computer manifest over real HTTP and PostgreSQL, with the bundle headers |
| `packages/server/src/__tests__/integration/skill-object-write-concurrency.test.ts` | Actual PostgreSQL writes with a local object-store fixture: a GC DELETE already past its final reference check, a losing writer's cleanup DELETE finishing after another successful same-content replacement, concurrent identical replacements, and legacy hash-key reads and collection. Each race verifies the current bundle's actual bytes and hash after deletion completes |
| `apps/web/src/features/skills/*.test.ts(x)` | The error-code map is exhaustive over the contract, an upload/toggle revision conflict reports the new sentence without opening the Replace dialog, and every other page rule |

## Physical object identity regressions

The object-write concurrency suite pauses only external DELETE completion or a real conditional SQL
update. It does not simulate the losing writer's revision conflict: a separate connection commits a
newer revision first. Both formerly destructive schedules must leave the current archive readable
after the delayed DELETE completes, even when its bytes match an earlier upload.

Identical replacements use independent keys while retaining one current row, the revision CAS,
enabled state, source, and archive hash. Legacy content-hash filenames are seeded as existing objects:
they remain readable and protected while referenced, then become ordinary GC candidates after a
replacement. The unit lifecycle, exact-prefix, remote/preset install, and local HTTP S3-adapter suites
cover rollback cleanup, uncertain commits, HEAD restoration, source routing, hash signing and namespace
isolation. No live S3/GCS or production state is needed. Older writers in a mixed deployment remain
outside the independent-key guarantee; no historical missing object is repaired by these tests.

The remaining end-to-end path is owned by the Client lane: upload a Skill through each of the three
surfaces and observe a Local Computer materialize it into the provider's skill directory at runtime
start.


## Concurrent final admission

`integration/skills-api.test.ts` drives actual SkillService account and Agent entry points on
independent migrated PostgreSQL connections. A barrier after both real object PUTs forces both
uploads to pass the old 63-row fast check. Exactly one distinct-name upload succeeds, the other
returns `SKILL_LIMIT_REACHED`, and both the runtime schema and authenticated Computer API return
64 Skills. The same-name case retains `SKILL_NAME_CONFLICT`; replacing at capacity preserves
id/revision CAS, source and disabled state. A separate check counts disabled Skills toward admission.
The PUT barrier also permits an independent Agent row lock, proving storage does not hold it.

Actual Agent deletion and operator transfer during PUT reject stale final admission and remove the
unreferenced object. A real SQL trigger verifies rollback cleanup; lost commit acknowledgement and
an unreadable cleanup recheck preserve committed objects and downloadable archives. The unit object
lifecycle harness injects failures into the actual admission transaction, including after commit.
All storage and credentials are fixtures. Existing historical over-limit rows are neither collected
nor hidden by manifest truncation; this validation does not measure production prevalence.


The final combined capability-write checks passed on Node 24.20.0: 691 script tests, 10,098 package
tests, Runtime coverage (650 tests, all metrics 100%) and migrated PostgreSQL (64 files, 901 tests).
Changed-line coverage was 101/101 (100%). See the
[shared validation record](mcp-server-integration.md#module-07-local-validation--2026-10-20)
for the initial PostgreSQL timeouts and unchanged-source/configuration reruns. These checks do not
establish production data prevalence or live acceptance.
