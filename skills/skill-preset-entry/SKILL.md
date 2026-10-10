---
name: skill-preset-entry
description: Record a new Skill in this repository's preset catalog under packages/skill-presets. Use when a task adds or checks a preset bundle, when a first-party Skill must ship as a discoverable preset, or when someone asks to 录入 Skill, 上架 Skill, 添加预设 Skill, add a preset Skill, or verify that a preset bundle is ready to enter.
---

# Skill preset entry

The preset catalog is committed repository data, not a service. Recording a Skill means placing a
bundle under `packages/skill-presets/skills/`, declaring it in `presets.yaml`, and letting the
generator compile an installable archive — the same archive an upload would store.

This bundle is itself a root `skills/<name>/` bundle and is not part of the catalog; it ships the
procedure, not a preset.

| Source | Holds |
| --- | --- |
| `packages/skill-presets/presets.yaml` | the declared category ids and one row per preset: `name`, `category`, `order` |
| `packages/skill-presets/skills/<name>/SKILL.md` | the bundle itself: the manifest plus supporting files |

`packages/skill-presets/src/presets.gen.ts` is generated. Never edit it by hand:
`pnpm presets:generate` writes it, and `pnpm check` runs the same script with `--check` to reject
drift.

## Step 1 — Bring a candidate bundle that already packs

A preset bundle has the same shape as any Skill: a root `SKILL.md` with YAML frontmatter and any
supporting files. The catalog reads only `name` and `description` from the manifest:

| Field | Rules |
| --- | --- |
| `name` | 1–64 characters of lowercase letters, digits, and single hyphens; no leading, trailing, or doubled hyphen; must equal the bundle directory name; unique in the catalog; never one of the ten platform-reserved names (`context-tree-connect`, `context-tree-create`, `context-tree-publish`, `context-tree-read`, `context-tree-setup`, `context-tree-write`, `git`, `gh`, `lark-cli`, `slack`) |
| `description` | one line, at most 1024 characters; it is the card text a person reads when choosing a preset, so write it as the reason to install the Skill |

The manifest parser is strict about YAML structure, not YAML features: write each field as a plain
single-line scalar, or quote it if the sentence needs a `: `. A value that parses as a boolean,
number, date, or null is rejected, as is a flow/block collection and an inline comment on a plain
value. Unknown top-level keys are ignored, so advisory metadata may stay.

The bundle content is decided by the same packer an upload runs: symlinks are refused,
`.git`/`node_modules`/`.DS_Store` are excluded from the archive, and the entry-count, path-length,
unpacked-size, and packed-size ceilings are enforced. A preset that needs an example or a long
reference should carry it as a supporting file rather than inflate the manifest.

## Step 2 — Pre-flight the candidate

```sh
pnpm presets:check-candidate <candidate-directory> [--category <id>] [--order <n>]
```

The checker is read-only and drives the same `packSkillDirectory` the upload and the generator use.
It reports the manifest name, archive sha256, archive bytes, file count, and the categories
`presets.yaml` declares, and it refuses: a candidate the packer rejects; a manifest name that
disagrees with the candidate directory name; a name already declared in `presets.yaml`; a supplied
category that is not a catalog category or is not declared; and a supplied order the shared
contract rejects. Fix everything it names before touching the repository. This is a pre-flight, not
the gate — `pnpm check` still decides.

## Step 3 — Choose the identity

- `name` — the manifest name; it becomes the preset identity and a directory name. Check it against
  the reserved list and against the names already declared in `presets.yaml`.
- `category` — one of the ids `presets.yaml` declares, drawn from the shared taxonomy
  (`SKILL_PRESET_CATEGORY_IDS` in `packages/shared/src/skill-preset.ts`). Reuse an existing category
  when one fits. `presets.yaml` may declare only categories that presets use, so a newly declared
  category must arrive with its first preset in the same change; a *new taxonomy id* is a contract
  change — the shared constant, the Web category labels, and the catalog move together.
- `order` — a display sort key within the category, not an index. Read the neighbours and keep the
  gaps you find; equal values fall back to name order.

## Step 4 — Place the bundle

Create `packages/skill-presets/skills/<name>/` and put the candidate's files there, with the root
`SKILL.md` first. The directory name must equal the manifest name: the catalog addresses the bundle
by its directory, and the generator refuses a bundle whose two names disagree.

## Step 5 — Declare it in `presets.yaml`

```yaml
- name: <name>
  category: <category>
  order: <order>
```

The row carries no title, description, or icon: the card text is the manifest's own
`name`/`description`, and category labels already exist for every taxonomy id.

## Step 6 — Compile and gate

```sh
pnpm presets:generate
pnpm --filter @opentag/skill-presets test
pnpm check
```

`pnpm presets:generate` repacks every bundle and rewrites `presets.gen.ts`; commit the result. The
package test asserts the decoded archives match the generated metadata. `pnpm check` is the full
gate: biome, the generator's `--check`, the root bundle checker, and the repository policy scripts.
When the gate is red for unrelated local reasons, name the failing step and prove yours is green on
its own rather than reporting the gate as passing.

## What the generator refuses

- a bundle the packer refuses — missing or unreadable `SKILL.md`, a reserved name, a symlink, an
  unsupported entry, or an entry/path/unpacked/packed ceiling;
- a manifest name that does not match the preset name or the bundle directory;
- a preset that names a category `presets.yaml` does not declare;
- a declared category that no preset uses;
- a duplicate preset name;
- a preset whose bundle directory is missing, or a bundle no preset references;
- a catalog whose archives exceed the total budget;
- a generated module that does not match its sources.

## What a preset entry does not touch

No Server API, no database, no migration, and no message catalog. The Server consumes the generated
module, and the discovery surfaces render whatever the catalog carries; a new preset needs no UI
change. A new category id, a new catalog field, or a manifest-contract change is a contract change,
not an entry: the shared schema, the generator, its tests, the consuming surfaces, and the design
documentation all move together.

## Rules

- Never edit `presets.gen.ts`, an archive's bytes, or a recorded sha256 by hand; regenerate.
- Keep the change to the bundle, its `presets.yaml` row, and any metadata its entry requires.
- Treat an existing preset as someone's reviewed decision: change it only with evidence, and say
  which evidence.
- Report the pre-flight facts — name, category, order, sha256 — so a reviewer can confirm the entry
  without repeating the work.
