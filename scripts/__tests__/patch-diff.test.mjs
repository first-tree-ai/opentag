import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW_PATH = join(REPOSITORY_ROOT, ".github/workflows/coverage.yml");

/**
 * Lift the exact inline program the "Enforce changed-line coverage" step pipes into Node, so the
 * gate regression below executes what CI executes instead of a hand-copied invocation that could
 * drift back to passing `diff.stdout`. Extraction is bounded to the named step and fails loudly
 * unless the NODE heredoc is found and terminated inside it.
 */
function extractEnforceChangedLineCoverageProgram(workflow) {
  const stepHeader = "- name: Enforce changed-line coverage";
  const headerIndex = workflow.indexOf(stepHeader);
  assert.ok(headerIndex !== -1, "coverage.yml is missing the Enforce changed-line coverage step");
  assert.equal(workflow.lastIndexOf(stepHeader), headerIndex, "the step name must appear exactly once");

  const lineStart = workflow.lastIndexOf("\n", headerIndex) + 1;
  const stepIndent = workflow.slice(lineStart, headerIndex);
  assert.match(stepIndent, /^ +$/, "the step header must be indented with spaces only");
  const afterHeader = workflow.slice(headerIndex);
  const stepEndMatch = new RegExp(`\\n {0,${stepIndent.length}}(?=\\S)`).exec(afterHeader);
  const step = workflow.slice(headerIndex, stepEndMatch ? headerIndex + stepEndMatch.index : workflow.length);

  const openerMatch = /^(?<pad> +)node --input-type=module <<'NODE'$/m.exec(step);
  assert.ok(openerMatch, "the step must pipe an inline program into node through a NODE heredoc");
  const pad = openerMatch.groups.pad;
  const closing = `\n${pad}NODE`;
  const trimmedStep = step.trimEnd();
  assert.ok(trimmedStep.endsWith(closing), "the NODE heredoc must terminate at the end of the step");
  const bodyStart = openerMatch.index + openerMatch[0].length + 1;
  const body = trimmedStep.slice(bodyStart, trimmedStep.length - closing.length);

  const program = body
    .split("\n")
    .map((line) => {
      if (line.trim().length === 0) return "";
      assert.ok(line.startsWith(pad), `heredoc lines must keep the step indentation, received: ${line}`);
      return line.slice(pad.length);
    })
    .join("\n");
  assert.ok(program.includes("captureMergeBaseDiff"), "the extracted program must capture the merge-base diff");
  assert.ok(program.includes("evaluatePatchCoverage"), "the extracted program must evaluate patch coverage");
  return program;
}

test("the workflow's inline gate program fails an uncovered changed line and passes a covered one", async () => {
  const program = extractEnforceChangedLineCoverageProgram(await readFile(WORKFLOW_PATH, "utf8"));

  await withRepository(async (repository) => {
    // A spawned child resolves process.cwd() to the canonical path (macOS maps /var to
    // /private/var), so coverage entries the child normalizes must be keyed by that same root.
    const repositoryRoot = await realpath(repository);

    // The inline program imports ./scripts/* relative to its working directory, exactly as in CI.
    await mkdir(join(repository, "scripts"), { recursive: true });
    await copyFile(join(REPOSITORY_ROOT, "scripts/patch-diff.mjs"), join(repository, "scripts/patch-diff.mjs"));
    await copyFile(
      join(REPOSITORY_ROOT, "scripts/unit-coverage-gate.mjs"),
      join(repository, "scripts/unit-coverage-gate.mjs"),
    );

    const sourceFile = "packages/shared/src/workflow-gate-fixture.ts";
    await mkdir(join(repository, "packages/shared/src"), { recursive: true });
    await writeFile(join(repository, sourceFile), "export const original = 1;\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "base"]);
    const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();

    await writeFile(join(repository, sourceFile), "export const original = 1;\nexport const added = 2;\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "add an executable line"]);

    const writeCoverage = async (hits) => {
      await mkdir(join(repository, "coverage/unit"), { recursive: true });
      await writeFile(
        join(repository, "coverage/unit/coverage-final.json"),
        JSON.stringify({
          [join(repositoryRoot, sourceFile)]: {
            path: join(repositoryRoot, sourceFile),
            s: { 0: hits },
            statementMap: { 0: { start: { line: 2, column: 0 }, end: { line: 2, column: 24 } } },
          },
        }),
      );
    };

    const runWorkflowProgram = () =>
      spawnSync(process.execPath, ["--input-type=module"], {
        cwd: repository,
        encoding: "utf8",
        env: { ...gitEnvironment, BASE_SHA: baseSha, PATCH_COVERAGE_THRESHOLD: "80" },
        input: program,
      });

    await writeCoverage(0);
    const uncovered = runWorkflowProgram();
    assert.equal(
      uncovered.status,
      1,
      `a changed line with zero hits must fail the gate:\nstdout:\n${uncovered.stdout}\nstderr:\n${uncovered.stderr}`,
    );
    assert.match(
      uncovered.stdout,
      /Patch coverage: 0\/1 lines/,
      "the gate must count the real changed line (nonzero denominator), not read the diff as empty",
    );
    assert.match(uncovered.stdout, /workflow-gate-fixture\.ts:2/);
    assert.doesNotMatch(uncovered.stdout, /no executable changed lines/);

    await writeCoverage(1);
    const covered = runWorkflowProgram();
    assert.equal(
      covered.status,
      0,
      `a covered changed line must pass the gate:\nstdout:\n${covered.stdout}\nstderr:\n${covered.stderr}`,
    );
    assert.match(covered.stdout, /Patch coverage: 1\/1 lines/, "the nonzero denominator must survive a pass too");
  });
});
