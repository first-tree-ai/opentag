import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { summarizeShardTimings } from "../ci-test-timing.mjs";
import { aggregateCoverageArtifacts, rebaseCoverageMap } from "../coverage-artifacts.mjs";
import { requiresPatchCoverage } from "../patch-coverage-plan.mjs";
import { COVERAGE_PROJECTS } from "../unit-coverage.mjs";
import { evaluatePatchCoverage } from "../unit-coverage-gate.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "opentag-ci-reporting-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("coverage planning skips non-source patches and keeps source changes conservative", () => {
  assert.equal(requiresPatchCoverage(["DEVELOPMENT.md", ".github/workflows/coverage.yml"]), false);
  assert.equal(
    requiresPatchCoverage(["apps/web/src/__tests__/fixture.ts", "scripts/tool.mjs", "vitest.coverage.config.ts"]),
    false,
  );
  assert.equal(requiresPatchCoverage(["apps/web/src/page.tsx"]), true);
  assert.equal(requiresPatchCoverage(["packages/server/src/new.ts"]), true);
  assert.equal(requiresPatchCoverage(["future-workspace/src/new.js"]), true);
  assert.throws(() => requiresPatchCoverage(undefined), /Changed paths/);
  assert.throws(() => requiresPatchCoverage([null]), /Changed paths/);
});

function createCoverageFixture(directory) {
  const floors = {};
  for (const project of COVERAGE_PROJECTS) {
    const reports = join(directory, `patch-coverage-${project.name}`);
    mkdirSync(reports);
    const path = `/producer/checkout/${project.sources}/fixture.ts`;
    const summary = {
      total: Object.fromEntries(
        ["lines", "statements", "functions", "branches"].map((metric) => [metric, { total: 1, covered: 1, pct: 100 }]),
      ),
    };
    summary[path] = { ...summary.total };
    writeFileSync(join(reports, "coverage-summary.json"), JSON.stringify(summary));
    writeFileSync(
      join(reports, "coverage-final.json"),
      JSON.stringify({ [path]: { path, s: { 0: 1 }, statementMap: { 0: { start: { line: 2 }, end: { line: 2 } } } } }),
    );
    writeFileSync(
      join(reports, "test-results.json"),
      JSON.stringify({
        success: true,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        numTotalTests: 1,
        testResults: [{ startTime: 1, endTime: 4, assertionResults: [{ status: "passed" }] }],
      }),
    );
    floors[project.name] = { lines: 80, statements: 80, branches: 80, functions: 80 };
  }
  return { coverageRoot: directory, repositoryRoot: "/consumer/checkout", floors };
}

test("coverage aggregation transports disjoint reports and keeps every hit and timing", () =>
  withFixture((directory) => {
    const options = createCoverageFixture(directory);
    const detailed = aggregateCoverageArtifacts(options);
    assert.equal(Object.keys(detailed).length, COVERAGE_PROJECTS.length);
    for (const project of COVERAGE_PROJECTS) {
      const path = `/consumer/checkout/${project.sources}/fixture.ts`;
      assert.equal(detailed[path].path, path);
      assert.equal(detailed[path].s[0], 1);
    }
    const summary = JSON.parse(readFileSync(join(directory, "coverage-summary.json")));
    assert.equal(summary.total.lines.covered, 5);
    assert.equal(summary["/consumer/checkout/apps/cli/src/fixture.ts"].lines.covered, 1);
    assert.equal(summary.total.lines.pct, 100);
    const run = JSON.parse(readFileSync(join(directory, "coverage-run.json")));
    assert.equal(run.packages.length, 5);
    assert.equal(run.packages[0].durationMs, 3);
  }));

test("coverage aggregation rejects missing workspace artifacts", () =>
  withFixture((directory) => {
    const options = createCoverageFixture(directory);
    rmSync(join(directory, "patch-coverage-server/coverage-final.json"));
    assert.throws(() => aggregateCoverageArtifacts(options), /server.*no detailed report/);
  }));

test("coverage aggregation rejects failed tests even if coverage reports exist", () =>
  withFixture((directory) => {
    const options = createCoverageFixture(directory);
    writeFileSync(
      join(directory, "patch-coverage-web/test-results.json"),
      JSON.stringify({ success: false, numFailedTests: 1, numFailedTestSuites: 1, numTotalTests: 1 }),
    );
    assert.throws(() => aggregateCoverageArtifacts(options), /did not pass for web/);
  }));

test("coverage aggregation preserves package floor enforcement", () =>
  withFixture((directory) => {
    const options = createCoverageFixture(directory);
    const path = join(directory, "patch-coverage-client/coverage-summary.json");
    const summary = JSON.parse(readFileSync(path));
    summary.total.lines = { covered: 0, total: 1, pct: 0 };
    writeFileSync(path, JSON.stringify(summary));
    assert.throws(() => aggregateCoverageArtifacts(options), /Coverage floor breach.*client/);
  }));

test("coverage rebasing rejects cross-workspace ownership, traversal, and collisions", () => {
  const project = COVERAGE_PROJECTS[0];
  assert.throws(() => rebaseCoverageMap({ "/repo/packages/server/src/file.ts": {} }, project, "/repo"), /outside cli/);
  assert.throws(
    () => rebaseCoverageMap({ "/repo/apps/cli/src/../file.ts": {} }, project, "/repo"),
    /Invalid coverage entry/,
  );
  assert.throws(
    () =>
      rebaseCoverageMap(
        {
          "/first/apps/cli/src/file.ts": { s: {}, statementMap: {} },
          "/second/apps/cli/src/file.ts": { s: {}, statementMap: {} },
        },
        project,
        "/repo",
      ),
    /collision/,
  );
  assert.throws(() => rebaseCoverageMap({}, project, "/repo"), /Missing coverage entries/);
});

const timings = ["1/3", "2/3", "3/3"].map((shard, index) => ({ shard, exitCode: 0, durationMs: (index + 1) * 100 }));

test("scoreboard timing reuses the slowest shard with explicit measurement provenance", () => {
  const summary = summarizeShardTimings(timings);
  assert.equal(summary.durationMs, 300);
  assert.match(summary.note, /Slowest Node 24 workspace unit shard/);
  assert.throws(() => summarizeShardTimings(timings.slice(1)), /All three/);
  assert.throws(() => summarizeShardTimings([timings[0], timings[0], timings[2]]), /All three/);
  assert.throws(() => summarizeShardTimings([...timings.slice(0, 2), { ...timings[2], exitCode: 1 }]), /failed/);
  assert.throws(() => summarizeShardTimings([...timings.slice(0, 2), { ...timings[2], durationMs: -1 }]), /Invalid/);
});

test("CI timing wrapper preserves a test command failure and writes its exit code", () =>
  withFixture((directory) => {
    const output = join(directory, "timing.json");
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/ci-test-timing.mjs"), output, "1/3", process.execPath, "-e", "process.exit(7)"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 7);
    const report = JSON.parse(readFileSync(output));
    assert.equal(report.exitCode, 7);
    assert.equal(report.shard, "1/3");
    assert.ok(report.durationMs >= 0);
  }));

function workflowShell(file, step) {
  const text = readFileSync(join(root, ".github/workflows", file), "utf8");
  const start = text.indexOf(`      - name: ${step}`);
  assert.ok(start >= 0);
  const end = text.indexOf("\n      - name:", start + 1);
  const block = text.slice(start, end < 0 ? undefined : end);
  return block
    .slice(block.indexOf("        run: |\n") + 15)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}

function runShell(program, env) {
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", program], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  }).status;
}

test("patch gate explicitly passes only the valid no-measurement case", () => {
  const program = workflowShell("coverage.yml", "Verify coverage prerequisites");
  assert.equal(
    runShell(program, { PLAN_RESULT: "success", COVERAGE_REQUIRED: "false", MEASUREMENT_RESULT: "skipped" }),
    0,
  );
  assert.equal(
    runShell(program, { PLAN_RESULT: "success", COVERAGE_REQUIRED: "true", MEASUREMENT_RESULT: "success" }),
    0,
  );
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    assert.equal(
      runShell(program, { PLAN_RESULT: "success", COVERAGE_REQUIRED: "true", MEASUREMENT_RESULT: result }),
      1,
    );
  }
  assert.equal(
    runShell(program, { PLAN_RESULT: "failure", COVERAGE_REQUIRED: "false", MEASUREMENT_RESULT: "skipped" }),
    1,
  );
  assert.equal(runShell(program, { PLAN_RESULT: "success", COVERAGE_REQUIRED: "", MEASUREMENT_RESULT: "skipped" }), 1);
});

test("CI requires the PR scoreboard but accepts its deliberate skip on main", () => {
  const program = workflowShell("ci.yml", "Verify required jobs");
  const env = Object.fromEntries(
    [
      "CHECKS_RESULT",
      "UNIT_TESTS_RESULT",
      "INTEGRATION_TESTS_RESULT",
      "AGENT_RUNTIME_COVERAGE_RESULT",
      "NODE_COMPATIBILITY_RESULT",
      "CLI_PACK_RESULT",
      "CONTAINER_RESULT",
      "BROWSER_SMOKE_RESULT",
      "WORKFLOW_VALIDATION_RESULT",
      "SECRET_SCAN_RESULT",
      "QUALITY_SCOREBOARD_RESULT",
    ].map((key) => [key, "success"]),
  );
  assert.equal(runShell(program, { ...env, EVENT_NAME: "pull_request" }), 0);
  assert.equal(runShell(program, { ...env, EVENT_NAME: "push", QUALITY_SCOREBOARD_RESULT: "skipped" }), 0);
  for (const key of Object.keys(env)) {
    assert.equal(runShell(program, { ...env, EVENT_NAME: "pull_request", [key]: "failure" }), 1);
  }
  assert.equal(runShell(program, { ...env, EVENT_NAME: "pull_request", QUALITY_SCOREBOARD_RESULT: "skipped" }), 1);
});

function writeCliCoverage(directory, entry) {
  writeFileSync(
    join(directory, "patch-coverage-cli/coverage-final.json"),
    JSON.stringify({ "/producer/checkout/apps/cli/src/fixture.ts": entry }),
  );
}

function evaluateArtifactPatch(options, content = "export const answer = 42;") {
  const coverage = aggregateCoverageArtifacts(options);
  return evaluatePatchCoverage({
    coverage,
    diff: ["--- a/apps/cli/src/fixture.ts", "+++ b/apps/cli/src/fixture.ts", "@@ -1,0 +2 @@", `+${content}`, ""].join(
      "\n",
    ),
    repositoryRoot: options.repositoryRoot,
    threshold: 80,
  });
}

const validStatement = { start: { line: 2 }, end: { line: 2 } };
const validEntry = { statementMap: { 0: validStatement }, s: { 0: 1 } };
const malformedEntries = [
  ["missing records", {}],
  ["array entry", []],
  ["array statement and hit records", { statementMap: [], s: [] }],
  ["array statement record", { ...validEntry, statementMap: [] }],
  ["array hit record", { ...validEntry, s: [] }],
  ["null statement record", { ...validEntry, statementMap: null }],
  ["primitive hit record", { ...validEntry, s: 1 }],
  ["missing hit key", { ...validEntry, s: {} }],
  ["orphaned hit key", { statementMap: {}, s: { 0: 1 } }],
  ["different statement and hit keys", { ...validEntry, s: { 1: 1 } }],
  ["extra hit key", { ...validEntry, s: { 0: 1, 1: 1 } }],
  ["null statement", { ...validEntry, statementMap: { 0: null } }],
  ["array statement", { ...validEntry, statementMap: { 0: [] } }],
  ["missing location", { ...validEntry, statementMap: { 0: {} } }],
  ["missing end", { ...validEntry, statementMap: { 0: { start: { line: 2 } } } }],
  ["zero start line", { ...validEntry, statementMap: { 0: { start: { line: 0 }, end: { line: 2 } } } }],
  ["negative start line", { ...validEntry, statementMap: { 0: { start: { line: -1 }, end: { line: 2 } } } }],
  ["fractional start line", { ...validEntry, statementMap: { 0: { start: { line: 1.5 }, end: { line: 2 } } } }],
  ["string start line", { ...validEntry, statementMap: { 0: { start: { line: "2" }, end: { line: 2 } } } }],
  ["reversed line range", { ...validEntry, statementMap: { 0: { start: { line: 2 }, end: { line: 1 } } } }],
  ["fractional end line", { ...validEntry, statementMap: { 0: { start: { line: 2 }, end: { line: 2.5 } } } }],
  ["unsafe end line", { ...validEntry, statementMap: { 0: { start: { line: 2 }, end: { line: 1e20 } } } }],
  ["negative hit count", { ...validEntry, s: { 0: -1 } }],
  ["null hit count", { ...validEntry, s: { 0: null } }],
  ["string hit count", { ...validEntry, s: { 0: "1" } }],
];

for (const [name, entry] of malformedEntries) {
  test(`artifact aggregation and patch evaluation reject ${name}`, () =>
    withFixture((directory) => {
      const options = createCoverageFixture(directory);
      writeCliCoverage(directory, entry);
      assert.throws(() => evaluateArtifactPatch(options), /Invalid Istanbul coverage entry/);
    }));
}

test("valid artifact statements still count executable changed lines", () =>
  withFixture((directory) => {
    const options = createCoverageFixture(directory);
    const covered = evaluateArtifactPatch(options);
    assert.equal(covered.total, 1);
    assert.equal(covered.covered, 1);
    assert.equal(covered.passed, true);

    writeCliCoverage(directory, { ...validEntry, s: { 0: 0 } });
    const summaryPath = join(directory, "patch-coverage-cli/coverage-summary.json");
    const summary = JSON.parse(readFileSync(summaryPath));
    for (const metrics of Object.values(summary)) {
      for (const metric of Object.values(metrics)) {
        metric.covered = 0;
        metric.pct = 0;
      }
    }
    writeFileSync(summaryPath, JSON.stringify(summary));
    options.floors.cli = { lines: 0, statements: 0, functions: 0, branches: 0 };
    const uncovered = evaluateArtifactPatch(options);
    assert.equal(uncovered.total, 1);
    assert.equal(uncovered.covered, 0);
    assert.equal(uncovered.passed, false);
    assert.deepEqual(uncovered.uncovered, ["apps/cli/src/fixture.ts:2"]);
  }));

test("valid empty statement records keep the explicit pass for type-only files", () =>
  withFixture((directory) => {
    const options = createCoverageFixture(directory);
    writeCliCoverage(directory, { statementMap: {}, s: {} });
    const result = evaluateArtifactPatch(options, "export interface Example { value: string }");
    assert.equal(result.total, 0);
    assert.equal(result.passed, true);
  }));

test("coverage records reject non-finite hit counts before patch evaluation", () => {
  for (const hits of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () =>
        rebaseCoverageMap(
          { "/repo/apps/cli/src/fixture.ts": { ...validEntry, s: { 0: hits } } },
          COVERAGE_PROJECTS[0],
          "/repo",
        ),
      /Invalid Istanbul coverage entry/,
    );
  }
});
