import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * The candidate checker answers, before a bundle enters `packages/skill-presets`, the questions the
 * generator would otherwise answer only after the bundle and its `presets.yaml` row are already in
 * the tree. These tests drive it as a process with a fixture repository, which is also how the
 * `presets:check-candidate` script runs it, including the `--tsconfig` that resolves its
 * `@opentag/shared` import to source: the check may run before `packages/shared/dist` exists.
 */

const repositoryRoot = join(import.meta.dirname, "..", "..");
const checker = join(import.meta.dirname, "..", "check-skill-preset-candidate.mjs");
const tsconfig = join(import.meta.dirname, "..", "tsconfig.scripts.json");
const tsx = join(repositoryRoot, "node_modules", ".bin", "tsx");

const catalogYaml = [
  "categories:",
  "  - id: getting-started",
  "    order: 10",
  "",
  "presets:",
  "  - name: existing-skill",
  "    category: getting-started",
  "    order: 10",
  "",
].join("\n");

/**
 * A fixture repository with a catalog, plus a candidate directory that lives outside it. The
 * candidate starts with a valid manifest named after its directory; a test can override either.
 */
function fixture(t, { name = "new-skill", manifest = manifestFor(name), extra = () => {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), "opentag-skill-preset-candidate-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repo");
  mkdirSync(join(root, "packages", "skill-presets"), { recursive: true });
  writeFileSync(join(root, "packages", "skill-presets", "presets.yaml"), catalogYaml);
  const candidate = join(base, "candidates", name);
  mkdirSync(candidate, { recursive: true });
  if (manifest !== null) writeFileSync(join(candidate, "SKILL.md"), manifest);
  extra(candidate);
  return { root, candidate };
}

function manifestFor(name) {
  return [
    "---",
    `name: ${name}`,
    "description: Record this bundle in the preset catalog when asked.",
    "---",
    "",
    "# Body",
    "",
  ].join("\n");
}

function run(args) {
  const result = spawnSync(tsx, ["--tsconfig", tsconfig, checker, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Run the checker and assert it refused the candidate, naming the problem. */
function assertRejected(t, expected, options, args = []) {
  const { root, candidate } = fixture(t, options);
  const result = run([candidate, "--root", root, ...args]);
  assert.notEqual(result.status, 0, `expected a failure, got:\n${result.stdout}`);
  assert.match(result.stderr, /\[skill-preset-candidate\]/);
  assert.match(result.stderr, expected);
  return result;
}

/** Every file under a directory, as `[relative path, contents]` pairs, for write detection. */
function snapshot(directory) {
  const entries = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else entries.push([relative(directory, path), readFileSync(path).toString("base64")]);
    }
  };
  walk(directory);
  return entries;
}

test("accepts a candidate with a category and order", (t) => {
  const { root, candidate } = fixture(t);
  const result = run([candidate, "--root", root, "--category", "getting-started", "--order", "30"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /candidate is ready to enter the catalog/);
  assert.match(result.stdout, /name: new-skill/);
  assert.match(result.stdout, /sha256: [0-9a-f]{64}/);
  assert.match(result.stdout, /archive bytes: \d+/);
  assert.match(result.stdout, /file count: 1/);
  assert.match(result.stdout, /declared categories: getting-started/);
});

test("accepts a candidate with no category and still reports the declared categories", (t) => {
  const { root, candidate } = fixture(t);
  const result = run([candidate, "--root", root]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /declared categories: getting-started/);
});

test("rejects a candidate without a manifest", (t) => {
  const { root, candidate } = fixture(t, { manifest: null });
  const result = run([candidate, "--root", root]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest_missing/);
});

test("rejects a manifest whose name disagrees with the candidate directory", (t) => {
  assertRejected(t, /does not match the candidate directory name "wrong-dir"/, {
    name: "wrong-dir",
    manifest: manifestFor("new-skill"),
  });
});

test("rejects a name the platform reserves", (t) => {
  assertRejected(t, /name_reserved/, { name: "git", manifest: manifestFor("git") });
});

test("rejects a symlink member", (t) => {
  assertRejected(t, /may not contain symlinks/, {
    extra: (candidate) => symlinkSync("/etc/hosts", join(candidate, "escape")),
  });
});

test("rejects a bundle whose packed archive exceeds the ceiling", (t) => {
  assertRejected(t, /archive_too_large/, {
    extra: (candidate) => writeFileSync(join(candidate, "random.bin"), randomBytes(17 * 1024 * 1024)),
  });
});

test("rejects a name already declared in presets.yaml", (t) => {
  assertRejected(t, /name "existing-skill" is already declared in/, {
    name: "existing-skill",
    manifest: manifestFor("existing-skill"),
  });
});

test("rejects a category that is not a catalog category id", (t) => {
  assertRejected(t, /--category: "not-a-category" is not a catalog category id/, {}, ["--category", "not-a-category"]);
});

test("rejects a category the catalog does not declare", (t) => {
  assertRejected(t, /--category: "engineering" is not declared in/, {}, ["--category", "engineering"]);
});

test("rejects an order the shared contract does not accept", (t) => {
  const { root, candidate } = fixture(t);
  const result = run([candidate, "--root", root, "--order", "1.5"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--order:/);
  assert.match(result.stderr, /expected int/);
});

test("rejects an option flag that carries no value", (t) => {
  assertRejected(t, /--category: requires a value/, {}, ["--category"]);
  assertRejected(t, /--order: requires a value/, {}, ["--order"]);

  const { candidate } = fixture(t);
  const result = run([candidate, "--root"]);
  assert.notEqual(result.status, 0, `expected a failure, got:\n${result.stdout}`);
  assert.match(result.stderr, /--root: requires a value/);
});

test("writes nothing, accepted or rejected", (t) => {
  const accepted = fixture(t);
  const rejected = fixture(t, { manifest: manifestFor("other-name") });
  const acceptedRootBefore = snapshot(accepted.root);
  const acceptedCandidateBefore = snapshot(accepted.candidate);
  const rejectedRootBefore = snapshot(rejected.root);
  const rejectedCandidateBefore = snapshot(rejected.candidate);

  const acceptedResult = run([accepted.candidate, "--root", accepted.root, "--category", "getting-started"]);
  assert.equal(acceptedResult.status, 0, acceptedResult.stderr);
  const rejectedResult = run([rejected.candidate, "--root", rejected.root]);
  assert.notEqual(rejectedResult.status, 0);

  assert.deepEqual(snapshot(accepted.root), acceptedRootBefore);
  assert.deepEqual(snapshot(accepted.candidate), acceptedCandidateBefore);
  assert.deepEqual(snapshot(rejected.root), rejectedRootBefore);
  assert.deepEqual(snapshot(rejected.candidate), rejectedCandidateBefore);
});
