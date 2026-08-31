import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePatchCoverage, isSupportedSourcePath, SUPPORTED_SOURCE_EXTENSIONS } from "../unit-coverage-gate.mjs";

function statementCoverage(file, line, hits) {
  return {
    path: file,
    s: { 0: hits },
    statementMap: {
      0: { start: { line, column: 0 }, end: { line, column: 20 } },
    },
  };
}

test("an added executable line with zero hits fails the patch gate", () => {
  const diff = [
    "diff --git a/src/example.ts b/src/example.ts",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,0 +2 @@",
    "+export const uncovered = 1;",
    "",
  ].join("\n");
  const result = evaluatePatchCoverage({
    diff,
    coverage: { "src/example.ts": statementCoverage("src/example.ts", 2, 0) },
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(result.total, 1);
  assert.equal(result.covered, 0);
  assert.equal(result.passed, false);
  assert.deepEqual(result.uncovered, ["src/example.ts:2"]);
});

test("renamed files use the new path and brand-new files use absolute coverage paths", () => {
  const renamed = evaluatePatchCoverage({
    diff: [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 80%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-export const oldValue = 1;",
      "+export const newValue = 1;",
      "",
    ].join("\n"),
    coverage: { "./src/new.ts": statementCoverage("./src/new.ts", 1, 1) },
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(renamed.passed, true);
  assert.equal(renamed.total, 1);

  const created = evaluatePatchCoverage({
    diff: [
      "diff --git a/src/new.mjs b/src/new.mjs",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.mjs",
      "@@ -0,0 +1 @@",
      "+export const created = 1;",
      "",
    ].join("\n"),
    coverage: { "/repo/src/new.mjs": statementCoverage("/repo/src/new.mjs", 1, 1) },
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(created.passed, true);
  assert.equal(created.total, 1);
});

test("CRLF diff lines are parsed without changing the new-line numbers", () => {
  const diff = [
    "diff --git a/src/example.tsx b/src/example.tsx",
    "--- a/src/example.tsx",
    "+++ b/src/example.tsx",
    "@@ -1,0 +4 @@",
    "+export const rendered = true;",
    "",
  ].join("\r\n");
  const result = evaluatePatchCoverage({
    diff,
    coverage: { "src/example.tsx": statementCoverage("src/example.tsx", 4, 1) },
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(result.passed, true);
  assert.equal(result.total, 1);
});

test("a changed executable line missing from coverage-final.json fails closed", () => {
  const result = evaluatePatchCoverage({
    diff: ["--- a/src/missing.ts", "+++ b/src/missing.ts", "@@ -1,0 +7 @@", "+export const missing = 1;", ""].join(
      "\n",
    ),
    coverage: {},
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(result.total, 1);
  assert.equal(result.passed, false);
  assert.deepEqual(result.uncovered, ["src/missing.ts:7 (missing coverage entry)"]);
});

test("an uncovered changed line counts against the threshold without imposing 100 percent", () => {
  // The threshold is a threshold: a line the provider measured and found unrun is reported and
  // counted, and the patch still passes while enough of it is covered.
  const diff = [
    "--- a/src/threshold.ts",
    "+++ b/src/threshold.ts",
    "@@ -0,0 +1,5 @@",
    "+export const one = 1;",
    "+export const two = 2;",
    "+export const three = 3;",
    "+export const four = 4;",
    "+export const unrun = 5;",
    "",
  ].join("\n");
  const coverage = {
    "src/threshold.ts": {
      path: "src/threshold.ts",
      s: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 0 },
      statementMap: Object.fromEntries(
        [1, 2, 3, 4, 5].map((line, index) => [index, { start: { line, column: 0 }, end: { line, column: 21 } }]),
      ),
    },
  };
  const result = evaluatePatchCoverage({ diff, coverage, repositoryRoot: "/repo", threshold: 80 });
  assert.equal(result.covered, 4);
  assert.equal(result.total, 5);
  assert.equal(result.percent, 80);
  assert.equal(result.passed, true);
  assert.deepEqual(result.uncovered, ["src/threshold.ts:5"]);
});

test("a diff with no executable changes passes explicitly", () => {
  const result = evaluatePatchCoverage({
    diff: [
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-// old comment",
      "+// new comment",
      "",
    ].join("\n"),
    coverage: {},
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(result.total, 0);
  assert.equal(result.covered, 0);
  assert.equal(result.passed, true);
  assert.equal(result.reason, "no executable changed lines");
});

test("supported script extensions are included while coverage artifacts remain excluded", () => {
  for (const extension of [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]) {
    assert.equal(SUPPORTED_SOURCE_EXTENSIONS.has(extension), true, extension);
    assert.equal(isSupportedSourcePath(`src/example${extension}`), true, extension);
  }
  assert.equal(isSupportedSourcePath("dist/generated.js"), false);
  assert.equal(isSupportedSourcePath("scripts/toolchain-check.mjs"), false);
  assert.equal(isSupportedSourcePath("src/example.test.ts"), false);
  assert.equal(isSupportedSourcePath("src/example.d.ts"), false);
});

test("package test infrastructure is excluded without excluding unrelated __tests__ folders", () => {
  assert.equal(isSupportedSourcePath("apps/web/src/__tests__/support/app-fixtures.tsx"), false);
  assert.equal(isSupportedSourcePath("packages/server/src/services/tasks/__tests__/fixture.ts"), false);
  assert.equal(isSupportedSourcePath("src/__tests__/production.ts"), true);
  assert.equal(isSupportedSourcePath("tools/__tests__/production.ts"), true);
});

test("a declaration the provider emits no statement for is not blamed for being uncoverable", () => {
  // A TypeScript interface member and a bare JSX text child both vanish at compile time, so the
  // instrumented file carries no statement for either line. Counting them would fail a pull request
  // for adding a type or changing a string, with nothing its author could write to satisfy the gate.
  const diff = [
    "diff --git a/src/example.tsx b/src/example.tsx",
    "--- a/src/example.tsx",
    "+++ b/src/example.tsx",
    "@@ -1,0 +2,3 @@",
    "+  readonly agentCount: number;",
    "+      Your Computer",
    "+export const rendered = true;",
    "",
  ].join("\n");
  const result = evaluatePatchCoverage({
    diff,
    coverage: { "src/example.tsx": statementCoverage("src/example.tsx", 4, 1) },
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(result.total, 1);
  assert.equal(result.covered, 1);
  assert.deepEqual(result.uncovered, []);
  assert.equal(result.passed, true);
});

test("an instrumented line with zero hits is still uncovered, whatever it contains", () => {
  // Skipping lines the provider omitted must not become a way to skip lines it measured as unrun.
  const diff = [
    "diff --git a/src/example.tsx b/src/example.tsx",
    "--- a/src/example.tsx",
    "+++ b/src/example.tsx",
    "@@ -1,0 +2 @@",
    "+  return renderNothing();",
    "",
  ].join("\n");
  const result = evaluatePatchCoverage({
    diff,
    coverage: { "src/example.tsx": statementCoverage("src/example.tsx", 2, 0) },
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(result.total, 1);
  assert.equal(result.passed, false);
  assert.deepEqual(result.uncovered, ["src/example.tsx:2"]);
});

test("a changed line inside an unrun multi-line statement is judged by that statement", () => {
  // The current provider emits single-line statements, so this case is theoretical today. Recording
  // the span keeps the skip rule meaning "no statement covers this line": a provider that reported
  // ranges would otherwise let an unrun statement's inner lines pass as uncoverable.
  const diff = [
    "diff --git a/src/example.ts b/src/example.ts",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,0 +12 @@",
    "+    unreachableArgument,",
    "",
  ].join("\n");
  const spanning = {
    path: "src/example.ts",
    s: { 0: 0 },
    statementMap: { 0: { start: { line: 10, column: 0 }, end: { line: 14, column: 3 } } },
  };
  const result = evaluatePatchCoverage({
    diff,
    coverage: { "src/example.ts": spanning },
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(result.total, 1);
  assert.equal(result.passed, false);
  assert.deepEqual(result.uncovered, ["src/example.ts:12"]);
});
