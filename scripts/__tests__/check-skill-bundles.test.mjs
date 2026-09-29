import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The Skill bundle checker turns a manifest the Server would reject at upload time into a failing
 * `pnpm check`. These tests drive it as a process, which is also how `pnpm check` runs it.
 */

const repositoryRoot = join(import.meta.dirname, "..", "..");
const checker = join(import.meta.dirname, "..", "check-skill-bundles.mjs");
const tsx = join(repositoryRoot, "node_modules", ".bin", "tsx");

function fixture(t, { name = "mcp-onboarding", manifest, extra = () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "opentag-skill-bundles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, "skills", name);
  mkdirSync(bundle, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(bundle, "SKILL.md"), manifest);
  extra(bundle);
  return root;
}

/** A repository with a `skills/` directory and no bundle in it. */
function emptyFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "opentag-skill-bundles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "skills"), { recursive: true });
  return root;
}

function run(root) {
  const result = spawnSync(tsx, [checker, "--root", root], { cwd: repositoryRoot, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const validManifest = [
  "---",
  "name: mcp-onboarding",
  "description: Add MCP tools to this Agent when a task needs one.",
  "---",
  "",
  "# Body",
  "",
].join("\n");

/** Run the checker and assert it refused the bundle, naming the problem. */
function assertRejected(t, expected, options) {
  const result = run(fixture(t, options));
  assert.notEqual(result.status, 0, `expected a failure, got:\n${result.stdout}`);
  assert.match(result.stderr, expected);
}

test("accepts a bundle that matches the contract", (t) => {
  const result = run(fixture(t, { manifest: validManifest }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 bundle\(s\) match/);
});

test("accepts a repository with no Skills at all", (t) => {
  const result = run(emptyFixture(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no skills\/ directory|0 bundle\(s\)/);
});

test("rejects a bundle without a manifest", (t) => {
  assertRejected(t, /SKILL\.md is missing/, { manifest: undefined });
});

test("rejects a manifest whose name disagrees with the directory", (t) => {
  assertRejected(t, /does not match the directory name/, {
    manifest: validManifest.replace("name: mcp-onboarding", "name: something-else"),
  });
});

test("rejects a name the platform reserves", (t) => {
  assertRejected(t, /is reserved by the platform/, {
    name: "git",
    manifest: validManifest.replace("name: mcp-onboarding", "name: git"),
  });
});

test("rejects frontmatter the manifest parser cannot read faithfully", (t) => {
  assertRejected(t, /name|description/, {
    manifest: validManifest.replace("name: mcp-onboarding", "name: [mcp, onboarding]"),
  });
});

test("rejects a symlink member", (t) => {
  assertRejected(t, /symlinks are not permitted/, {
    manifest: validManifest,
    extra: (bundle) => symlinkSync("/etc/hosts", join(bundle, "escape")),
  });
});
