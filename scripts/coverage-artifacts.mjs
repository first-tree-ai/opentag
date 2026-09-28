import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertCoverageArtifacts,
  assertCoverageFloors,
  assertRepositoryCoverageManifest,
  COVERAGE_METRICS,
  COVERAGE_PROJECTS,
  summarizeTestResults,
  writeAggregateReports,
} from "./unit-coverage.mjs";

function assertIstanbulEntry(coverage, file) {
  if (
    !coverage ||
    typeof coverage !== "object" ||
    !coverage.statementMap ||
    !coverage.s ||
    typeof coverage.statementMap !== "object" ||
    typeof coverage.s !== "object"
  ) {
    throw new Error(`Invalid Istanbul coverage entry: ${file}`);
  }
}

function assertMetricTotals(entry, metric) {
  if (
    !Number.isInteger(entry?.covered) ||
    !Number.isInteger(entry?.total) ||
    entry.covered < 0 ||
    entry.total < entry.covered
  ) {
    throw new Error(`Invalid ${metric} totals in coverage reports`);
  }
}

function coverageFilePath(file, project, repositoryRoot) {
  const normalized = file.replaceAll("\\", "/");
  const marker = `/${project.sources}/`;
  const index = normalized.lastIndexOf(marker);
  if (index < 0) throw new Error(`Coverage entry outside ${project.name}: ${file}`);
  const suffix = normalized.slice(index + marker.length);
  if (!suffix || suffix.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error(`Invalid coverage entry: ${file}`);
  }
  return resolve(repositoryRoot, project.sources, suffix);
}

/** Artifact producers may have different checkout roots; retain one owner per source file. */
export function rebaseCoverageMap(map, project, repositoryRoot) {
  if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length === 0) {
    throw new Error(`Missing coverage entries for ${project.name}`);
  }
  const rebased = {};
  for (const [file, coverage] of Object.entries(map)) {
    const path = coverageFilePath(file, project, repositoryRoot);
    if (rebased[path]) throw new Error(`Coverage map collision for ${path}`);
    assertIstanbulEntry(coverage, file);
    rebased[path] = { ...coverage, path };
  }
  return rebased;
}

function aggregateSummary(summaries, projects, repositoryRoot) {
  const aggregate = {};
  for (const project of projects) {
    for (const [file, metrics] of Object.entries(summaries[project.name])) {
      if (file !== "total") aggregate[coverageFilePath(file, project, repositoryRoot)] = metrics;
    }
  }
  const total = {};
  for (const metric of COVERAGE_METRICS) {
    const entries = Object.values(summaries).map((summary) => summary.total?.[metric]);
    for (const entry of entries) assertMetricTotals(entry, metric);
    const covered = entries.reduce((sum, entry) => sum + entry.covered, 0);
    const count = entries.reduce((sum, entry) => sum + entry.total, 0);
    total[metric] = { covered, total: count, pct: count === 0 ? 100 : Number(((covered / count) * 100).toFixed(2)) };
  }
  // Keep the aggregate summary contract used by the sequential baseline runner.
  total.statements = { ...total.lines };
  return { ...aggregate, total };
}

export function aggregateCoverageArtifacts({ coverageRoot, repositoryRoot, floors, projects = COVERAGE_PROJECTS }) {
  const maps = [];
  const summaries = {};
  const packages = [];
  for (const project of projects) {
    const directory = resolve(coverageRoot, `patch-coverage-${project.name}`);
    const { summaryPath, detailedPath } = assertCoverageArtifacts(directory, project.name);
    const report = JSON.parse(readFileSync(resolve(directory, "test-results.json"), "utf8"));
    if (
      report.success !== true ||
      report.numFailedTests !== 0 ||
      report.numFailedTestSuites !== 0 ||
      !(report.numTotalTests > 0)
    ) {
      throw new Error(`Coverage tests did not pass for ${project.name}`);
    }
    summaries[project.name] = JSON.parse(readFileSync(summaryPath, "utf8"));
    maps.push(rebaseCoverageMap(JSON.parse(readFileSync(detailedPath, "utf8")), project, repositoryRoot));
    packages.push({ ...summarizeTestResults(report), name: project.name });
  }
  assertCoverageFloors(summaries, floors);
  const detailed = writeAggregateReports({
    coverageRoot,
    detailedMaps: maps,
    summary: aggregateSummary(summaries, projects, repositoryRoot),
  });
  writeFileSync(resolve(coverageRoot, "coverage-run.json"), `${JSON.stringify({ version: 1, packages }, null, 2)}\n`);
  return detailed;
}

export function main() {
  assertRepositoryCoverageManifest();
  const repositoryRoot = process.cwd();
  aggregateCoverageArtifacts({
    repositoryRoot,
    coverageRoot: resolve(repositoryRoot, "coverage/unit"),
    floors: JSON.parse(readFileSync(resolve(repositoryRoot, "scripts/coverage-floors.json"), "utf8")),
  });
  console.log("Aggregated all workspace coverage reports; existing floors passed.");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
