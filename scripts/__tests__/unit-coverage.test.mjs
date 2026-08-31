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
