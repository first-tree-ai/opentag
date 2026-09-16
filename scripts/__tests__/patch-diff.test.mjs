import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureMergeBaseDiff } from "../patch-diff.mjs";
import { evaluatePatchCoverage } from "../unit-coverage-gate.mjs";

const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: gitEnvironment, encoding: "utf8" });
}

async function withRepository(run) {
  const directory = await mkdtemp(join(tmpdir(), "opentag-patch-diff-test-"));
  try {
    git(directory, ["init", "--initial-branch=main"]);
    git(directory, ["config", "user.name", "Fixture"]);
    git(directory, ["config", "user.email", "fixture@example.invalid"]);
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const LINE_COUNT = 20000;
const FIXTURE_FILE = "packages/shared/src/patch-diff-fixture.ts";

function sourceLines(prefix) {
  return `${Array.from({ length: LINE_COUNT }, (_, index) => `export const ${prefix}${index} = "${"x".repeat(32)}";`).join("\n")}\n`;
}

test("a patch beyond the old spawn buffer reaches the evaluator untruncated", async () => {
  await withRepository(async (repository) => {
    await mkdir(join(repository, "packages/shared/src"), { recursive: true });
    await writeFile(join(repository, FIXTURE_FILE), sourceLines("before"));
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "base"]);
    const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(join(repository, FIXTURE_FILE), sourceLines("after"));
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "change"]);

    const leftoverBefore = (await readdir(tmpdir())).filter((name) => name.startsWith("opentag-patch-diff-"));
    const diff = captureMergeBaseDiff({ baseSha, repositoryRoot: repository });
    const leftoverAfter = (await readdir(tmpdir())).filter((name) => name.startsWith("opentag-patch-diff-"));
    assert.deepEqual(leftoverAfter, leftoverBefore, "the temporary patch file is cleaned up");
    // The previous capture stopped at 1,114,112 bytes with ENOBUFS before returning the full patch.
    assert.ok(
      diff.length > 1_114_112,
      `expected a patch beyond the observed spawn-buffer failure, got ${diff.length} bytes`,
    );
    assert.ok(diff.includes(`+export const after${LINE_COUNT - 1} =`), "the final changed line survived untruncated");

    const coverage = {
      [FIXTURE_FILE]: {
        path: FIXTURE_FILE,
        s: { 0: 1 },
        statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: LINE_COUNT, column: 0 } } },
      },
    };
    const result = evaluatePatchCoverage({ coverage, diff, repositoryRoot: repository, threshold: 80 });
    assert.equal(result.total, LINE_COUNT);
    assert.equal(result.covered, LINE_COUNT);
    assert.equal(result.passed, true);
  });
});

test("an unknown base ref fails closed instead of reading as an empty patch", async () => {
  await withRepository(async (repository) => {
    await writeFile(join(repository, "file.txt"), "initial\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "base"]);
    assert.throws(() => captureMergeBaseDiff({ baseSha: "f".repeat(40), repositoryRoot: repository }), /git diff/);
  });
});

test("a malformed base ref is rejected before git runs", () => {
  assert.throws(() => captureMergeBaseDiff({ baseSha: "main...HEAD", repositoryRoot: "." }), /base SHA/);
});

test("an empty merge-base comparison returns an empty patch and the gate still passes explicitly", async () => {
  await withRepository(async (repository) => {
    await writeFile(join(repository, "file.txt"), "initial\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "base"]);
    const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();
    const diff = captureMergeBaseDiff({ baseSha, repositoryRoot: repository });
    assert.equal(diff, "");
    const result = evaluatePatchCoverage({ coverage: {}, diff, repositoryRoot: repository, threshold: 80 });
    assert.equal(result.total, 0);
    assert.equal(result.passed, true);
  });
});
