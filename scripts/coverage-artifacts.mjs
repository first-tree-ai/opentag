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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidStatement(statement) {
  if (!isRecord(statement) || !isRecord(statement.start) || !isRecord(statement.end)) return false;
  const { line: start } = statement.start;
  const { line: end } = statement.end;
  return Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(end) && end >= start;
}

function assertIstanbulEntry(coverage, file) {
  if (!isRecord(coverage) || !isRecord(coverage.statementMap) || !isRecord(coverage.s)) {
    throw new Error(`Invalid Istanbul coverage entry: ${file}`);
  }
  const statements = Object.entries(coverage.statementMap);
  if (statements.length !== Object.keys(coverage.s).length) {
    throw new Error(`Invalid Istanbul coverage entry: ${file} (statement/hit keys differ)`);
  }
  for (const [id, statement] of statements) {
    if (
      !Object.hasOwn(coverage.s, id) ||
      !isValidStatement(statement) ||
      !Number.isFinite(coverage.s[id]) ||
      coverage.s[id] < 0
    ) {
      throw new Error(`Invalid Istanbul coverage entry: ${file} (statement ${id})`);
    }
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

/**
 * The measured source roots of a project, validated.
 *
 * A project may declare more than one root (`packages/server/src` and `packages/server/scripts`), so a
 * coverage artifact has to be attributed to exactly one of them. The list is rejected rather than
 * coerced when it is empty or holds something that is not a plain repository-relative path: an artifact
 * consumer that silently guesses ownership would attribute a report to the wrong workspace.
 */
export function projectSourceRoots(project) {
  const declared = Array.isArray(project?.sources) ? project.sources : [project?.sources];
  const roots = [];
  for (const root of declared) {
    if (typeof root !== "string" || root.length === 0) {
      throw new Error(`Coverage project ${project?.name ?? "(unknown)"} declares an invalid source root`);
    }
    const normalized = root.replaceAll("\\", "/").replace(/\/+$/, "");
    if (
      normalized.startsWith("/") ||
      normalized.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`Coverage project ${project.name} declares an unsafe source root: ${root}`);
    }
    if (!roots.includes(normalized)) roots.push(normalized);
  }
  if (roots.length === 0) throw new Error(`Coverage project ${project.name} declares no source roots`);
  return roots;
}

/**
 * Attribute one artifact path to the project's declared source root it belongs to.
 *
 * The deepest matching root wins, so a project that measures both a directory and a subdirectory of it
 * cannot attribute a nested entry to the shorter marker. An entry that matches no root, an empty suffix,
 * a `.`/`..` segment, or a resolve that escapes the root is rejected: the artifact consumer fails closed
 * instead of importing a file another workspace owns.
 */
export function coverageFilePath(file, project, repositoryRoot) {
  const normalized = String(file).replaceAll("\\", "/");
  const roots = projectSourceRoots(project);
  const matches = roots
    .map((root) => ({ index: normalized.lastIndexOf(`/${root}/`), root }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => right.root.length - left.root.length);
  const match = matches[0];
  if (!match) throw new Error(`Coverage entry outside ${project.name}: ${file}`);
  const suffix = normalized.slice(match.index + match.root.length + 2);
  if (!suffix || suffix.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`Invalid coverage entry: ${file}`);
  }
  const path = resolve(repositoryRoot, match.root, suffix);
  const escapeMarker = `${resolve(repositoryRoot, match.root)}/`;
  if (!path.startsWith(escapeMarker)) throw new Error(`Invalid coverage entry: ${file}`);
  return path;
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
