import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";

/**
 * The generator turns an invalid preset bundle or catalog into a failing `pnpm check` instead of a
 * broken install card. These tests drive it as a process, which is also how `pnpm check` runs it,
 * including the `--tsconfig` that resolves its `@opentag/shared` and Client imports to source:
 * `pnpm check` runs before `pnpm build`, so no `dist` exists when it runs.
 */

const repositoryRoot = join(import.meta.dirname, "..", "..");
const generator = join(import.meta.dirname, "..", "generate-skill-presets.mjs");
const tsconfig = join(import.meta.dirname, "..", "tsconfig.scripts.json");
const tsx = join(repositoryRoot, "node_modules", ".bin", "tsx");

function manifestFor(name, description = "A preset Skill for tests.") {
  return ["---", `name: ${name}`, `description: ${description}`, "---", "", "# Body", ""].join("\n");
}

function metadata({ categories, presets } = {}) {
  return {
    categories: categories ?? [{ id: "getting-started", order: 10 }],
    presets: presets ?? [{ name: "demo-skill", category: "getting-started", order: 10 }],
  };
}

/** A fixture repository holding only what the generator reads. */
function fixture(t, { catalog = metadata(), bundles } = {}) {
  const root = mkdtempSync(join(tmpdir(), "opentag-skill-presets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const presetsRoot = join(root, "packages/skill-presets");
  const skillsRoot = join(presetsRoot, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  writeFileSync(join(presetsRoot, "presets.yaml"), stringify(catalog));
  for (const [name, spec] of Object.entries(bundles ?? { "demo-skill": {} })) {
    const at = join(skillsRoot, name);
    if (spec?.file === true) {
      writeFileSync(at, "# notes\n");
      continue;
    }
    if (spec?.missing === true) continue;
    mkdirSync(at, { recursive: true });
    if (spec?.noManifest !== true) writeFileSync(join(at, "SKILL.md"), spec?.manifest ?? manifestFor(name));
    spec?.extra?.(at);
  }
  return {
    root,
    target: join(presetsRoot, "src/presets.gen.ts"),
    manifestPath: join(skillsRoot, "demo-skill/SKILL.md"),
  };
}

function runGenerator(root, ...args) {
  const result = spawnSync(tsx, ["--tsconfig", tsconfig, generator, "--root", root, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Run the generator and assert it refused the catalog, naming the problem. */
function assertRejected(t, expected, options) {
  const result = runGenerator(fixture(t, options).root);
  assert.notEqual(result.status, 0, `expected a failure, got:\n${result.stdout}`);
  assert.match(result.stderr, expected);
  return result;
}

test("writes a module carrying every category and preset", (t) => {
  const fixtureRoot = fixture(t, {
    catalog: metadata({
      categories: [
        { id: "getting-started", order: 10 },
        { id: "engineering", order: 20 },
      ],
      presets: [
        { name: "demo-skill", category: "getting-started", order: 10 },
        { name: "second-skill", category: "engineering", order: 20 },
      ],
    }),
    bundles: { "demo-skill": {}, "second-skill": {} },
  });
  const result = runGenerator(fixtureRoot.root);
  assert.equal(result.status, 0, result.stderr);
  const generated = readFileSync(fixtureRoot.target, "utf8");
  assert.match(generated, /export const PRESET_SKILL_CATEGORIES/);
  assert.match(generated, /export const PRESET_SKILL_ARCHIVES/);
  assert.match(generated, /A preset Skill for tests\./);
  assert.match(generated, /id: "getting-started"/);
  assert.match(generated, /name: "second-skill"/);
  assert.match(generated, /archiveBase64:/);
});

test("accepts a generated catalog under --check", (t) => {
  const fixtureRoot = fixture(t);
  assert.equal(runGenerator(fixtureRoot.root).status, 0);
  const checked = runGenerator(fixtureRoot.root, "--check");
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /generated module is current/);
});

test("rejects a bundle without a manifest", (t) => {
  assertRejected(t, /manifest_missing/, { bundles: { "demo-skill": { noManifest: true } } });
});

test("rejects a manifest whose name disagrees with the preset", (t) => {
  assertRejected(t, /manifest name "other-skill" does not match the preset name/, {
    bundles: { "demo-skill": { manifest: manifestFor("other-skill") } },
  });
});

test("rejects a name the platform reserves", (t) => {
  assertRejected(t, /name_reserved/, {
    catalog: metadata({ presets: [{ name: "git", category: "getting-started", order: 10 }] }),
    bundles: { git: {} },
  });
});

test("rejects a category outside the shared taxonomy", (t) => {
  assertRejected(t, /categories\[0\]/, {
    catalog: metadata({ categories: [{ id: "operations", order: 10 }] }),
  });
});

test("rejects a category declared but not used by any preset", (t) => {
  assertRejected(t, /category "engineering" is declared but no preset uses it/, {
    catalog: metadata({
      categories: [
        { id: "getting-started", order: 10 },
        { id: "engineering", order: 20 },
      ],
    }),
  });
});

test("rejects a preset naming a category that is not declared", (t) => {
  assertRejected(t, /"engineering" is not declared in presets\.yaml/, {
    catalog: metadata({ presets: [{ name: "demo-skill", category: "engineering", order: 10 }] }),
  });
});

test("rejects a duplicate preset name", (t) => {
  assertRejected(t, /duplicate preset name "demo-skill"/, {
    catalog: metadata({
      presets: [
        { name: "demo-skill", category: "getting-started", order: 10 },
        { name: "demo-skill", category: "getting-started", order: 20 },
      ],
    }),
  });
});

test("rejects a bundle no preset references", (t) => {
  assertRejected(t, /the bundle is not referenced by any preset/, {
    bundles: { "demo-skill": {}, "stowaway-skill": {} },
  });
});

test("rejects a referenced bundle that does not exist", (t) => {
  assertRejected(t, /the bundle directory does not exist/, {
    catalog: metadata({
      presets: [
        { name: "demo-skill", category: "getting-started", order: 10 },
        { name: "second-skill", category: "getting-started", order: 20 },
      ],
    }),
  });
});

test("rejects a non-directory member of skills/", (t) => {
  assertRejected(t, /only a Skill bundle directory may live under skills\//, {
    bundles: { "demo-skill": {}, "notes.md": { file: true } },
  });
});

test("rejects drift between the sources and the generated module", (t) => {
  const fixtureRoot = fixture(t);
  assert.equal(runGenerator(fixtureRoot.root).status, 0);
  writeFileSync(fixtureRoot.manifestPath, manifestFor("demo-skill", "A changed description."));
  const drifted = runGenerator(fixtureRoot.root, "--check");
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /out of date/);
});
