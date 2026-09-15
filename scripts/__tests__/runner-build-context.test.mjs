import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isCredentialPath,
  isInsideRoot,
  listStagedRelativeFiles,
  stageRunnerBuildContext,
} from "../runner/build-context.mjs";

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Disposable Git fixture: every source the tests stage is version-controlled in its own repo. */
async function fixture() {
  const source = await mkdtemp(join(tmpdir(), "opentag-ctx-src-"));
  const dest = await mkdtemp(join(tmpdir(), "opentag-ctx-dst-"));
  git(source, ["init", "-q"]);
  await writeFile(join(source, "keep.txt"), "ok\n");
  await mkdir(join(source, "src"));
  await writeFile(join(source, "src/index.ts"), "export {}\n");
  git(source, ["add", "-A"]);
  return { source, dest };
}

test("staged context copies the allowlist and omits identity-only extras", async () => {
  const { source, dest } = await fixture();
  try {
    await rm(dest, { recursive: true, force: true });
    await stageRunnerBuildContext({
      sourceRoot: source,
      destination: dest,
      allowlist: ["keep.txt", "src"],
      identity: { version: "0.0.5" },
    });
    const files = listStagedRelativeFiles(dest);
    assert.ok(files.includes("keep.txt"));
    assert.ok(files.includes("src/index.ts"));
    assert.ok(files.includes("runner-identity.json"));
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test("ignored and untracked local files never enter the staged context", async () => {
  const { source, dest } = await fixture();
  try {
    await writeFile(join(source, ".gitignore"), "*.log\n");
    git(source, ["add", ".gitignore"]);
    // Ignored canary (matches *.log) and an untracked-but-not-ignored file: both must be skipped.
    await writeFile(join(source, "src", "runtime.log"), "fake-canary-token\n");
    await writeFile(join(source, "src", "local-notes.txt"), "scratch\n");
    await rm(dest, { recursive: true, force: true });
    await stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["src"] });
    const files = listStagedRelativeFiles(dest);
    assert.deepEqual(files, ["src/index.ts"]);
    // A newly intended source file is included once it carries index intent (no commit needed).
    await writeFile(join(source, "src", "added.ts"), "export const added = 1\n");
    assert.equal(listStagedRelativeFiles(dest).includes("src/added.ts"), false);
    git(source, ["add", "-N", "src/added.ts"]);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["src"] });
    assert.ok(listStagedRelativeFiles(dest).includes("src/added.ts"));
    // Dirty development content of a tracked file still stages with its working-tree content.
    await writeFile(join(source, "src", "index.ts"), "export const dirty = true\n");
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["src"] });
    assert.equal(await readFile(join(dest, "src", "index.ts"), "utf8"), "export const dirty = true\n");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test("staging fails safely when source Git ownership cannot be established", async () => {
  const source = await mkdtemp(join(tmpdir(), "opentag-ctx-nogit-"));
  const dest = await mkdtemp(join(tmpdir(), "opentag-ctx-nogit-dst-"));
  try {
    await writeFile(join(source, "keep.txt"), "ok\n");
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["keep.txt"] }),
      /Git ownership/,
    );
    assert.equal(listStagedRelativeFiles(dest).length, 0);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test("an allowlisted file that is not version-controlled is rejected", async () => {
  const { source, dest } = await fixture();
  try {
    await writeFile(join(source, "draft.txt"), "untracked\n");
    await rm(dest, { recursive: true, force: true });
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["draft.txt"] }),
      /not version-controlled/,
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test("symlinks and credential files are rejected even in-root", async () => {
  const { source, dest } = await fixture();
  try {
    await writeFile(join(source, "src/auth.json"), '{"token":"x"}\n');
    git(source, ["add", "src/auth.json"]);
    await rm(dest, { recursive: true, force: true });
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["src"] }),
      /credential/,
    );
    assert.equal(isCredentialPath("src/auth.json"), true);
    await symlink(join(source, "keep.txt"), join(source, "link"));
    git(source, ["add", "link"]);
    await rm(dest, { recursive: true, force: true });
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["link"] }),
      /symlink/,
    );
    assert.equal(isInsideRoot(source, join(source, "keep.txt")), true);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test("denied names cannot be allowlisted and destinations cannot be reused", async () => {
  const { source, dest } = await fixture();
  try {
    await writeFile(join(source, ".env"), "SECRET=1\n");
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: [".env"] }),
      /denied/,
    );
    await writeFile(join(dest, "already"), "nope\n");
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["keep.txt"] }),
      /not empty/,
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test("symlink ancestor directories cannot smuggle outside files into the context", async () => {
  const { source, dest } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "opentag-ctx-out-"));
  try {
    await writeFile(join(outside, "code.ts"), "export const leaked = true\n");
    await symlink(outside, join(source, "src", "nested"));
    // Leaf lstat sees a regular file; the symlinked ancestor must still be rejected.
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["src/nested/code.ts"] }),
      /symlink ancestor/,
    );
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    // The symlinked directory itself stays rejected when allowlisted or scanned.
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["src/nested"] }),
      /symlink/,
    );
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["src"] }),
      /symlink/,
    );
    const staged = listStagedRelativeFiles(dest);
    assert.equal(
      staged.some((file) => file.includes("code.ts")),
      false,
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("destination symlink and physical overlap with the source tree are rejected", async () => {
  const { source, dest } = await fixture();
  const alias = await mkdtemp(join(tmpdir(), "opentag-ctx-alias-"));
  try {
    const linked = join(alias, "linked-dest");
    await symlink(dest, linked);
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: linked, allowlist: ["keep.txt"] }),
      /symlink/,
    );
    // A destination physically inside the canonical source tree is rejected even through an alias.
    const inner = join(source, "staged");
    await mkdir(inner, { recursive: true });
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: inner, allowlist: ["keep.txt"] }),
      /source tree/,
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
    await rm(alias, { recursive: true, force: true });
  }
});
