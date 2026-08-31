import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "check-doc-mirrors.mjs");

function runGit(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

function fixture({ marker = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "opentag-doc-mirrors-"));
  runGit(root, "init", "--quiet");
  runGit(root, "config", "user.email", "test@example.invalid");
  runGit(root, "config", "user.name", "Doc Mirror Test");
  const canonical = marker
    ? "# Guide\n\n## Intentional section\n\n<!-- doc-mirror: allow-divergence -->\n\nOriginal text.\n"
    : "# Guide\n\n## Section\n\nOriginal text.\n";
  writeFileSync(join(root, "guide.md"), canonical);
  writeFileSync(join(root, "guide.zh-CN.md"), "# 指南\n\n原始文本。\n");
  runGit(root, "add", "guide.md", "guide.zh-CN.md");
  runGit(root, "commit", "--quiet", "-m", "initial");
  const base = runGit(root, "rev-parse", "HEAD");
  return { root, base, canonicalPath: "guide.md", mirrorPath: "guide.zh-CN.md" };
}

function finishFixture(fixtureData, { changeMirror = false, text = "Updated text." } = {}) {
  const canonicalPath = join(fixtureData.root, fixtureData.canonicalPath);
  const current = readFileSync(canonicalPath, "utf8");
  writeFileSync(canonicalPath, text.includes("\n") ? `${text}\n` : current.replace("Original text.", text));
  if (changeMirror) writeFileSync(join(fixtureData.root, fixtureData.mirrorPath), "# 指南\n\n更新文本。\n");
  runGit(fixtureData.root, "add", fixtureData.canonicalPath, ...(changeMirror ? [fixtureData.mirrorPath] : []));
  runGit(fixtureData.root, "commit", "--quiet", "-m", "change docs");
  return runGit(fixtureData.root, "rev-parse", "HEAD");
}

function runChecker(root, base, head) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, "--base", base, "--head", head], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

test("changed canonical document without its mirror fails and names both paths", () => {
  const fixtureData = fixture();
  try {
    const head = finishFixture(fixtureData);
    const result = runChecker(fixtureData.root, fixtureData.base, head);
    assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /guide\.md/);
    assert.match(output, /guide\.zh-CN\.md/);
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true });
  }
});

test("changing canonical and mirror documents together passes", () => {
  const fixtureData = fixture();
  try {
    const head = finishFixture(fixtureData, { changeMirror: true });
    const result = runChecker(fixtureData.root, fixtureData.base, head);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true });
  }
});

test("the divergence marker suppresses the mirror requirement for its section", () => {
  const fixtureData = fixture({ marker: true });
  try {
    const head = finishFixture(fixtureData, { text: "Changed text." });
    const result = runChecker(fixtureData.root, fixtureData.base, head);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true });
  }
});
