import assert from "node:assert/strict";
import test from "node:test";
import { isMeasuredSourcePath } from "../coverage-scope.mjs";
import {
  evaluatePatchCoverage,
  extractChangedTargets,
  isSupportedSourcePath,
  SUPPORTED_SOURCE_EXTENSIONS,
} from "../unit-coverage-gate.mjs";

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

test("a measured file missing from coverage-final.json fails closed even when the percentage passes", () => {
  // Diluted on purpose: nine covered lines and one line in a file the run should have measured but
  // did not. 90% clears the threshold, so only the fail-closed rule can fail this patch.
  const covered = "packages/shared/src/covered.ts";
  const missing = "packages/shared/src/missing.ts";
  const diff = [
    `--- a/${covered}`,
    `+++ b/${covered}`,
    "@@ -0,0 +1,9 @@",
    ...Array.from({ length: 9 }, (_, index) => `+export const value${index} = ${index};`),
    `--- a/${missing}`,
    `+++ b/${missing}`,
    "@@ -1,0 +7 @@",
    "+export const missing = 1;",
    "",
  ].join("\n");
  const coverage = {
    [covered]: {
      path: covered,
      s: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index, 1])),
      statementMap: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          index,
          { start: { line: index + 1, column: 0 }, end: { line: index + 1, column: 20 } },
        ]),
      ),
    },
  };
  const result = evaluatePatchCoverage({ diff, coverage, repositoryRoot: "/repo", threshold: 80 });
  assert.equal(result.total, 10);
  assert.equal(result.covered, 9);
  assert.equal(result.percent, 90);
  assert.equal(result.passed, false);
  assert.deepEqual(result.unmeasured, [missing]);
  assert.deepEqual(result.uncovered, [`${missing}:7 (missing coverage entry)`]);
});

test("a changed line in a file coverage never instruments neither counts nor blocks", () => {
  // The same diluted shape, with the tenth line in a shared test helper: excluded by configuration,
  // so no test could ever give it an entry, and the gate must not demand one.
  const covered = "packages/shared/src/covered.ts";
  const helper = "apps/web/src/__tests__/support/router.tsx";
  const diff = [
    `--- a/${covered}`,
    `+++ b/${covered}`,
    "@@ -0,0 +1 @@",
    "+export const value = 1;",
    `--- a/${helper}`,
    `+++ b/${helper}`,
    "@@ -9,0 +10 @@",
    "+export const route = true;",
    "",
  ].join("\n");
  const coverage = {
    [covered]: {
      path: covered,
      s: { 0: 1 },
      statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } } },
    },
  };
  const result = evaluatePatchCoverage({ diff, coverage, repositoryRoot: "/repo", threshold: 80 });
  assert.equal(result.total, 1);
  assert.equal(result.passed, true);
  assert.deepEqual(result.unmeasured, []);
});

test("inside a measured workspace the gate judges exactly what coverage instruments", () => {
  for (const path of [
    "packages/client/src/smoke/pi-agent-runtime-e2e.ts",
    "packages/skill-presets/src/__tests__/fixture.ts",
    "packages/mcp-presets/src/__tests__/fixture.ts",
    "apps/web/src/paraglide/messages.js",
    "packages/shared/src/legacy.mjs",
    "packages/client/scripts/tool.ts",
    "apps/web/src/vite-env.d.ts",
  ]) {
    assert.equal(isSupportedSourcePath(path), false, path);
    assert.equal(isMeasuredSourcePath(path), false, path);
  }
  for (const path of [
    "packages/server/scripts/check.ts",
    "packages/skill-presets/src/index.ts",
    "apps/web/src/page.tsx",
    // Coverage excludes only `src/__tests__`, so a nested `__tests__` fixture is instrumented and judged.
    "packages/server/src/services/tasks/__tests__/fixture.ts",
  ]) {
    assert.equal(isSupportedSourcePath(path), true, path);
    assert.equal(isMeasuredSourcePath(path), true, path);
  }
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
    // Measured, with nothing executable on the changed line.
    coverage: { "src/example.ts": { path: "src/example.ts", s: {}, statementMap: {} } },
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(result.total, 0);
  assert.equal(result.covered, 0);
  assert.equal(result.passed, true);
  assert.deepEqual(result.unmeasured, []);
  assert.equal(result.reason, "no executable changed lines");
});

const typeOnlyFile = "packages/shared/src/types.ts";
const typeOnlyDiff = [
  `--- a/${typeOnlyFile}`,
  `+++ b/${typeOnlyFile}`,
  "@@ -0,0 +1,2 @@",
  "+export type Value = string;",
  "+export interface Shape { readonly value: Value }",
];

test("a type-only change in an unmeasured file fails closed beside a covered change", () => {
  // Diluted: one covered executable line elsewhere makes the percentage 100%. The type-only file
  // has no executable line, but the provider reports even such a file with an empty statement map,
  // so its missing entry means it was not measured.
  const covered = "packages/shared/src/covered.ts";
  const diff = [
    `--- a/${covered}`,
    `+++ b/${covered}`,
    "@@ -0,0 +1 @@",
    "+export const value = 1;",
    ...typeOnlyDiff,
    "",
  ].join("\n");
  const coverage = {
    [covered]: {
      path: covered,
      s: { 0: 1 },
      statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } } },
    },
  };
  const result = evaluatePatchCoverage({ diff, coverage, repositoryRoot: "/repo", threshold: 80 });
  assert.equal(result.total, 1);
  assert.equal(result.percent, 100);
  assert.equal(result.passed, false);
  assert.deepEqual(result.unmeasured, [typeOnlyFile]);
});

test("an all-type-only patch in an unmeasured file fails closed despite zero executable lines", () => {
  const result = evaluatePatchCoverage({
    diff: [...typeOnlyDiff, ""].join("\n"),
    coverage: {},
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(result.total, 0);
  assert.equal(result.reason, "no executable changed lines");
  assert.equal(result.passed, false);
  assert.deepEqual(result.unmeasured, [typeOnlyFile]);

  // The same patch against the empty entry the provider emits for a type-only file passes.
  const measured = evaluatePatchCoverage({
    diff: [...typeOnlyDiff, ""].join("\n"),
    coverage: { [typeOnlyFile]: { path: typeOnlyFile, s: {}, statementMap: {} } },
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(measured.passed, true);
  assert.deepEqual(measured.unmeasured, []);
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

test("package test infrastructure is excluded", () => {
  assert.equal(isSupportedSourcePath("apps/web/src/__tests__/support/app-fixtures.tsx"), false);
  assert.equal(isSupportedSourcePath("src/__tests__/production.ts"), true);
  assert.equal(isSupportedSourcePath("tools/__tests__/production.ts"), true);

  const result = evaluatePatchCoverage({
    diff: [
      "--- a/apps/web/src/__tests__/support/app-fixtures.tsx",
      "+++ b/apps/web/src/__tests__/support/app-fixtures.tsx",
      "@@ -0,0 +1 @@",
      "+export const fixture = true;",
      "",
    ].join("\n"),
    coverage: {},
    repositoryRoot: "/repo",
    threshold: 80,
  });
  assert.equal(result.reason, "no executable changed lines");
  assert.equal(result.passed, true);
});

test("root and package tooling config modules are excluded without excluding source config modules", () => {
  for (const path of [
    "vitest.coverage.config.ts",
    "packages/client/vitest.agent-runtime.config.ts",
    "packages/mcp-presets/vitest.config.ts",
    "apps/web/vite.config.ts",
    "packages/server/drizzle.config.ts",
  ]) {
    assert.equal(isSupportedSourcePath(path), false, path);
  }
  assert.equal(isSupportedSourcePath("apps/web/src/vite.config.ts"), true);
  assert.equal(isSupportedSourcePath("packages/server/src/config.ts"), true);
  assert.equal(isSupportedSourcePath("packages/mcp-presets/src/scaffold/main.ts"), true);
  assert.equal(isSupportedSourcePath("tools/vitest.config.ts"), true);
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

test("a missing or non-string diff is rejected instead of passing as an empty patch", () => {
  // The workflow once handed the gate `diff.stdout` of a string — undefined — and the parser
  // coerced it to "", producing the explicit no-executable-lines pass on a pull request full of
  // real changes. That wiring bug must throw, whatever shape the non-string takes.
  for (const diff of [undefined, null, false, 0, {}, { stdout: "+export const covered = 1;" }, ["+line"]]) {
    assert.throws(
      () => evaluatePatchCoverage({ diff, coverage: {}, repositoryRoot: "/repo", threshold: 80 }),
      /^Error: A unified diff string is required/,
      `diff of type ${diff === null ? "null" : typeof diff} must be rejected`,
    );
  }
  assert.throws(
    () => evaluatePatchCoverage({ coverage: {}, repositoryRoot: "/repo", threshold: 80 }),
    /^Error: A unified diff string is required/,
    "an omitted diff property must be rejected",
  );
});

test("a legitimately empty diff string keeps the explicit no-executable-lines pass", () => {
  // An empty string is a real diff: the merge-base comparison found nothing to change.
  const result = evaluatePatchCoverage({ diff: "", coverage: {}, repositoryRoot: "/repo", threshold: 80 });
  assert.equal(result.total, 0);
  assert.equal(result.covered, 0);
  assert.equal(result.passed, true);
  assert.equal(result.reason, "no executable changed lines");
});

test("surviving targets include renames, copies and quoted paths, but not deletions", () => {
  const diff = [
    "diff --git a/packages/shared/src/a.ts b/packages/shared/src/b.ts",
    "similarity index 100%",
    "rename from packages/shared/src/a.ts",
    "rename to packages/shared/src/b.ts",
    "diff --git a/packages/shared/src/c.ts b/packages/shared/src/d.ts",
    "copy from packages/shared/src/c.ts",
    "copy to packages/shared/src/d.ts",
    "--- a/packages/shared/src/gone.ts",
    "+++ /dev/null",
    '+++ "b/packages/shared/src/caf\\303\\251.ts"',
    "--- a/packages/shared/src/kept.ts",
    "+++ b/packages/shared/src/kept.ts",
    "",
  ].join("\n");
  assert.deepEqual(
    [...extractChangedTargets(diff)].sort(),
    [
      "packages/shared/src/b.ts",
      "packages/shared/src/café.ts",
      "packages/shared/src/d.ts",
      "packages/shared/src/kept.ts",
    ].sort(),
  );
});
