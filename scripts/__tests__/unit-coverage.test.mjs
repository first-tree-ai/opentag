import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertCoverageArtifacts,
  COVERAGE_REPORTER_FLAGS,
  concatenateCoverageMaps,
  evaluateCoverageFloors,
  ratchetCoverageFloors,
  summarizeTestResults,
  validateCoverageManifest,
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

test("coverage manifest validation reports source files without an intentional owner", () => {
  const result = validateCoverageManifest({
    sourceFiles: ["packages/client/src/runtime/owned.ts", "packages/client/src/runtime/missing.ts"],
    includePatterns: ["packages/client/src/runtime/owned.ts"],
  });
  assert.deepEqual(result.missing, ["packages/client/src/runtime/missing.ts"]);
  assert.deepEqual(result.unmatchedPatterns, []);
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
