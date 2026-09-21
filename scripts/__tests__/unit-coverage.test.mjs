import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNTIME_COVERAGE_INCLUDE,
  assertCoverageArtifacts,
  COVERAGE_REPORTER_FLAGS,
  concatenateCoverageMaps,
  evaluateCoverageFloors,
  formatTestFailureLines,
  projectCoverageInclude,
  ratchetCoverageFloors,
  summarizeTestResults,
  validateCoverageManifest,
  validateRepositoryCoverageManifest,
  writeAggregateReports,
} from "../unit-coverage.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fileCoverage(path, line, hits) {
  return {
    path,
    s: { 0: hits },
    statementMap: {
      0: { start: { column: 0, line }, end: { column: 10, line } },
    },
  };
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "opentag-unit-coverage-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the patch-coverage gate still reads the concatenated detailed map", async () => {
  const workflow = await readFile(join(repoRoot, ".github/workflows/coverage.yml"), "utf8");
  assert.match(workflow, /coverage\/unit\/coverage-final\.json/);
});

test("coverage reporter flags restate json so the CLI override still writes coverage-final.json", async () => {
  assert.deepEqual(COVERAGE_REPORTER_FLAGS, [
    "--coverage.reporter=json",
    "--coverage.reporter=json-summary",
    "--coverage.reporter=text-summary",
  ]);
  const source = await readFile(join(repoRoot, "scripts/unit-coverage.mjs"), "utf8");
  assert.match(source, /\.\.\.COVERAGE_REPORTER_FLAGS/);
});

test("concatenateCoverageMaps unions disjoint Istanbul maps and keeps statement hits", () => {
  const serverFile = "/repo/packages/server/src/db/schema/agents.ts";
  const webFile = "/repo/apps/web/src/routes/index.tsx";
  const concatenated = concatenateCoverageMaps([
    { [serverFile]: fileCoverage(serverFile, 4, 3) },
    { [webFile]: fileCoverage(webFile, 12, 0) },
  ]);

  assert.equal(concatenated[serverFile].s["0"], 3);
  assert.equal(concatenated[serverFile].statementMap["0"].start.line, 4);
  assert.equal(concatenated[webFile].s["0"], 0);
  assert.equal(Object.keys(concatenated).length, 2);
});

test("concatenateCoverageMaps refuses a second copy of the same file instead of merging hits", () => {
  const file = "/repo/packages/server/src/db/schema/agents.ts";
  assert.throws(
    () => concatenateCoverageMaps([{ [file]: fileCoverage(file, 4, 3) }, { [file]: fileCoverage(file, 4, 0) }]),
    /collision/,
  );
});

test("assertCoverageArtifacts requires both the summary and the detailed Istanbul report", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "server"), { recursive: true });
    const reportsDirectory = join(directory, "server");

    assert.throws(() => assertCoverageArtifacts(reportsDirectory, "server"), /no summary/);

    await writeFile(join(reportsDirectory, "coverage-summary.json"), "{}\n");
    assert.throws(() => assertCoverageArtifacts(reportsDirectory, "server"), /no detailed report/);

    await writeFile(join(reportsDirectory, "coverage-final.json"), "{}\n");
    const paths = assertCoverageArtifacts(reportsDirectory, "server");
    assert.equal(paths.summaryPath, join(reportsDirectory, "coverage-summary.json"));
    assert.equal(paths.detailedPath, join(reportsDirectory, "coverage-final.json"));
  });
});

test("writeAggregateReports emits the concatenated detailed map the patch-coverage gate reads", async () => {
  await withTemporaryDirectory(async (directory) => {
    const serverFile = "/repo/packages/server/src/db/schema/agents.ts";
    const webFile = "/repo/apps/web/src/routes/index.tsx";
    const summary = {
      total: { lines: { covered: 1, pct: 50, total: 2 } },
    };

    const detailed = writeAggregateReports({
      coverageRoot: directory,
      detailedMaps: [{ [serverFile]: fileCoverage(serverFile, 4, 3) }, { [webFile]: fileCoverage(webFile, 12, 0) }],
      summary,
    });

    const written = JSON.parse(await readFile(join(directory, "coverage-final.json"), "utf8"));
    const writtenSummary = JSON.parse(await readFile(join(directory, "coverage-summary.json"), "utf8"));

    assert.deepEqual(written, detailed);
    assert.equal(written[serverFile].statementMap["0"].start.line, 4);
    assert.equal(written[webFile].s["0"], 0);
    assert.equal(writtenSummary.total.lines.pct, 50);
  });
});

function summary(lines, statements = lines, functions = lines, branches = lines) {
  return {
    total: {
      lines: { pct: lines },
      statements: { pct: statements },
      functions: { pct: functions },
      branches: { pct: branches },
    },
  };
}

test("coverage floor breaches name the package and the signed delta", () => {
  const breaches = evaluateCoverageFloors(
    { server: summary(94, 94, 94, 94) },
    { server: { lines: 95, statements: 95, functions: 95, branches: 95 } },
  );
  assert.equal(breaches.length, 4);
  assert.match(breaches[0].message, /package "server"/);
  assert.equal(breaches[0].delta, -1);
  assert.match(breaches[0].message, /delta -1(?:\.00)?/);
});

test("coverage floors tolerate variance within the configured band and breach beyond it", () => {
  const floors = {
    tolerance: 0.75,
    projects: { server: { lines: 97, statements: 97, functions: 97, branches: 97 } },
  };
  assert.deepEqual(evaluateCoverageFloors({ server: summary(96.3) }, floors), []);
  const breaches = evaluateCoverageFloors({ server: summary(96.2) }, floors);
  assert.equal(breaches.length, 4);
  assert.match(breaches[0].message, /below floor 97\.00% \(tolerance 0\.75pp\)/);
});

test("coverage manifest validation reports source files without an intentional owner", () => {
  const result = validateCoverageManifest({
    sourceFiles: ["packages/client/src/runtime/owned.ts", "packages/client/src/runtime/missing.ts"],
    includePatterns: ["packages/client/src/runtime/owned.ts"],
  });
  assert.deepEqual(result.missing, ["packages/client/src/runtime/missing.ts"]);
  assert.deepEqual(result.unmatchedPatterns, []);
});

test("Agent Runtime coverage include owns Pi runtime-policy like the other providers", () => {
  for (const provider of ["claude-code", "codex", "pi"]) {
    assert.equal(
      AGENT_RUNTIME_COVERAGE_INCLUDE.includes(`src/providers/${provider}/runtime-policy.ts`),
      true,
      `missing src/providers/${provider}/runtime-policy.ts`,
    );
  }
  const result = validateRepositoryCoverageManifest(repoRoot);
  assert.deepEqual(result.agentRuntime.missing, []);
  assert.deepEqual(result.agentRuntime.unmatchedPatterns, []);
});

test("coverage floor ratchets reject decreases and permit them only with an explicit override", () => {
  const existing = { client: { lines: 96, statements: 96, functions: 96, branches: 96 } };
  const current = { client: summary(95, 95, 95, 95) };
  assert.throws(() => ratchetCoverageFloors({ existing, summaries: current }), /ratchet.*decrease.*client.*lines/i);
  const lowered = ratchetCoverageFloors({ existing, summaries: current, allowDecrease: true });
  assert.equal(lowered.client.lines, 95);
});

test("test-result summaries report duration and retried-then-passed tests as flaky", () => {
  const result = summarizeTestResults({
    numTotalTests: 2,
    numTotalTestSuites: 1,
    testResults: [
      {
        assertionResults: [
          { status: "passed", retryCount: 2, flaky: true },
          { status: "failed", retryCount: 1 },
        ],
        endTime: 1_250,
        name: "suite.test.ts",
        startTime: 1_000,
      },
    ],
  });
  assert.deepEqual(result, {
    durationMs: 250,
    failedAfterRetryCount: 1,
    flakyCount: 1,
    retryCount: 3,
    testCount: 2,
    testFileCount: 1,
  });
});

test("a failed run names the failed tests and their assertion messages from the JSON report", () => {
  const lines = formatTestFailureLines({
    report: {
      testResults: [
        {
          assertionResults: [
            {
              ancestorTitles: ["agent turn runner"],
              failureMessages: ["AssertionError: expected 'aborted' to be 'running'\n    at runTest (file.ts:1:1)"],
              fullName: "agent turn runner aborts an in-flight turn",
              status: "failed",
              title: "aborts an in-flight turn",
            },
            { fullName: "agent turn runner completes a turn", status: "passed", title: "completes a turn" },
          ],
          name: "/repo/packages/client/src/runtime/agent-turn-runner.test.ts",
          status: "failed",
        },
        {
          assertionResults: [{ fullName: "http paths builds a path", status: "passed" }],
          name: "/repo/packages/shared/src/http-paths.test.ts",
          status: "passed",
        },
      ],
    },
    status: 1,
  });
  const output = lines.join("\n");
  assert.match(output, /agent-turn-runner\.test\.ts > agent turn runner aborts an in-flight turn/);
  assert.match(output, /AssertionError: expected 'aborted' to be 'running'/);
  assert.doesNotMatch(output, /completes a turn/);
  assert.doesNotMatch(output, /http-paths\.test\.ts/);
});

test("a failed assertion without a failure message is still named", () => {
  const lines = formatTestFailureLines({
    report: {
      testResults: [
        {
          assertionResults: [{ fullName: "flaky retry gives up", retryCount: 2, status: "failed" }],
          name: "/repo/packages/server/src/retry.test.ts",
          status: "failed",
        },
      ],
    },
    status: 1,
  });
  assert.match(lines.join("\n"), /retry\.test\.ts > flaky retry gives up/);
});

test("a suite that fails without assertions surfaces its file-level error", () => {
  const lines = formatTestFailureLines({
    report: {
      testResults: [
        {
          assertionResults: [],
          message: "Cannot find module './missing' imported from broken.test.ts",
          name: "/repo/packages/server/src/broken.test.ts",
          status: "failed",
        },
      ],
    },
    status: 1,
  });
  const output = lines.join("\n");
  assert.match(output, /broken\.test\.ts/);
  assert.match(output, /Cannot find module '\.\/missing'/);
});

test("a crashed run without a usable report falls back to captured stderr", () => {
  const lines = formatTestFailureLines({
    report: undefined,
    status: 1,
    stderr: " ⎯⎯ Unhandled Rejection ⎯⎯\nError: database connection refused\n",
    stdout: "",
  });
  const output = lines.join("\n");
  assert.match(output, /stderr/);
  assert.match(output, /Unhandled Rejection/);
  assert.match(output, /database connection refused/);
});

test("a nonzero exit whose report names no failure still surfaces captured stderr", () => {
  const lines = formatTestFailureLines({
    report: {
      testResults: [
        {
          assertionResults: [{ fullName: "works", status: "passed" }],
          name: "/repo/packages/client/src/fine.test.ts",
          status: "passed",
        },
      ],
    },
    status: 1,
    stderr: "FATAL ERROR: Reached heap limit Allocation failed",
    stdout: "",
  });
  const output = lines.join("\n");
  assert.match(output, /heap limit/);
  assert.doesNotMatch(output, /fine\.test\.ts/);
});

test("stdout is the fallback when a failed run left no report and stderr is empty", () => {
  const lines = formatTestFailureLines({
    report: undefined,
    status: 1,
    stderr: "",
    stdout: "Segmentation fault (core dumped)",
  });
  assert.match(lines.join("\n"), /Segmentation fault/);
});

test("a run that dies without any captured output reports the process exit", () => {
  const lines = formatTestFailureLines({ report: undefined, signal: "SIGKILL", status: null, stderr: "", stdout: "" });
  assert.match(lines.join("\n"), /SIGKILL/);
});

test("a spawn failure is reported instead of being hidden", () => {
  const lines = formatTestFailureLines({ error: new Error("spawn pnpm ENOENT"), report: undefined, status: null });
  assert.match(lines.join("\n"), /spawn pnpm ENOENT/);
});

test("captured process errors remain visible alongside assertion failures", () => {
  const output = formatTestFailureLines({
    status: 1,
    report: {
      testResults: [
        {
          name: "test.ts",
          status: "failed",
          assertionResults: [
            { fullName: "assertion fails", status: "failed", failureMessages: ["expected 1 to equal 2"] },
          ],
        },
      ],
    },
    stderr: "Unhandled Rejection: cleanup failed",
  }).join("\n");
  assert.match(output, /expected 1 to equal 2/);
  assert.match(output, /Unhandled Rejection: cleanup failed/);
});

test("successful test runs do not produce failure diagnostics", () => {
  assert.deepEqual(formatTestFailureLines({ status: 0, stdout: "Tests passed", stderr: "warning" }), []);
});

const sharedProject = { name: "shared", root: "packages/shared", sources: "packages/shared/src" };

test("coverage include is project-relative so Vitest resolves it against the project root", () => {
  assert.equal(projectCoverageInclude(sharedProject, null), "src/**/*.{ts,tsx}");
});

test("a repository-relative scope has its workspace prefix stripped", () => {
  assert.equal(projectCoverageInclude(sharedProject, "packages/shared/src/http-paths.ts"), "src/http-paths.ts");
});

test("an already project-relative scope is passed through untouched", () => {
  assert.equal(projectCoverageInclude(sharedProject, "src/**/*.ts"), "src/**/*.ts");
});

test("a scope belonging to another workspace keeps its prefix rather than being mangled", () => {
  assert.equal(projectCoverageInclude(sharedProject, "packages/server/src/**/*.ts"), "packages/server/src/**/*.ts");
});

test("no project's default include still carries its own workspace prefix", () => {
  for (const project of [
    { name: "cli", root: "apps/cli", sources: "apps/cli/src" },
    { name: "web", root: "apps/web", sources: "apps/web/src" },
    sharedProject,
    { name: "client", root: "packages/client", sources: "packages/client/src" },
    { name: "server", root: "packages/server", sources: "packages/server/src" },
  ]) {
    const include = projectCoverageInclude(project, null);
    assert.ok(
      !include.startsWith(`${project.root}/`),
      `${project.name} include ${include} would resolve under ${project.root}/${project.root}`,
    );
  }
});
