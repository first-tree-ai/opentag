#!/usr/bin/env node

/**
 * Measures unit-test line coverage one workspace at a time.
 *
 * Running every Vitest project in a single pass and letting the coverage provider merge the results
 * under-reports: the `include` list spans all five workspaces, so each project's `all: true` sweep
 * emits a zero-coverage entry for every *other* workspace's files, and the merge does not reliably
 * keep the covered lines a different project already recorded. Files that are fully executed the
 * moment they are imported showed the damage most clearly -- the Drizzle table declarations in
 * `packages/server/src/db/schema` reported between 49% and 83% merged, and 100% on their own.
 *
 * So each project runs alone here, with `include` narrowed to the workspace that project actually
 * tests. Every file is then measured exactly once, by the only suite that can execute it, and the
 * per-workspace summaries and detailed Istanbul maps are concatenated rather than merged. The
 * detailed map at `coverage/unit/coverage-final.json` is what the pull-request patch-coverage gate
 * walks for per-line hits; a provider-merged pass must not be used to produce it.
 *
 * Usage:
 *   node scripts/unit-coverage.mjs                 # every workspace, then the aggregate table
 *   node scripts/unit-coverage.mjs --project server  # one workspace, for a fast inner loop
 *   node scripts/unit-coverage.mjs --scope 'packages/server/src/services/im-bindings/**'
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export {
  buildLineHitsByFile,
  evaluatePatchCoverage,
  extractChangedLines,
  isSupportedSourcePath,
  normalizeCoveragePath,
  SUPPORTED_SOURCE_EXTENSIONS,
} from "./unit-coverage-gate.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Each Vitest project alongside the workspace whose sources it is the only suite able to execute. */
const PROJECTS = [
  { name: "cli", sources: "apps/cli/src" },
  { name: "web", sources: "apps/web/src" },
  { name: "shared", sources: "packages/shared/src" },
  { name: "client", sources: "packages/client/src" },
  { name: "server", sources: "packages/server/src" },
];

const COVERAGE_ROOT = resolve(repositoryRoot, "coverage/unit");
export const COVERAGE_FLOORS_PATH = resolve(repositoryRoot, "scripts/coverage-floors.json");
export const COVERAGE_METRICS = ["lines", "statements", "functions", "branches"];

const ROOT_COVERAGE_INCLUDE_PATTERNS = [
  "apps/cli/src/**/*.{ts,tsx}",
  "apps/web/src/**/*.{ts,tsx}",
  "packages/shared/src/**/*.{ts,tsx}",
  "packages/client/src/**/*.{ts,tsx}",
  "packages/server/src/**/*.{ts,tsx}",
];

const ROOT_COVERAGE_EXCLUDE_PATTERNS = ["**/src/__tests__/**", "**/src/smoke/**", "**/src/paraglide/**"];

/** The focused Agent Runtime manifest is deliberately explicit and source-tree checked. */
export const AGENT_RUNTIME_COVERAGE_INCLUDE = [
  "src/agent-runtime/**/*.ts",
  "src/providers/claude-code/agent-runtime.ts",
  "src/providers/claude-code/hosted-tool-bridge.ts",
  "src/providers/claude-code/process-wire.ts",
  "src/providers/claude-code/runtime-policy.ts",
  "src/providers/codex/agent-runtime.ts",
  "src/providers/codex/app-server-wire.ts",
  "src/providers/codex/runtime-policy.ts",
  "src/providers/pi/agent-runtime.ts",
  "src/providers/pi/rpc-wire.ts",
  "src/providers/process-owner.ts",
  "src/runtime/agent-runtime-availability-tester.ts",
  "src/runtime/agent-runtime-provider-registry.ts",
  "src/runtime/agent-turn-runner.ts",
  "src/runtime/client-runtime-composition.ts",
  "src/runtime/runtime-durability.ts",
  "src/runtime/session-runtime-manager.ts",
];

const AGENT_RUNTIME_SCOPE_PREFIXES = [
  "agent-runtime/",
  "providers/claude-code/",
  "providers/codex/",
  "providers/pi/",
  "providers/process-owner.ts",
  "runtime/agent-runtime-availability-tester.ts",
  "runtime/agent-runtime-provider-registry.ts",
  "runtime/agent-turn-runner.ts",
  "runtime/client-runtime-composition.ts",
  "runtime/runtime-durability.ts",
  "runtime/session-runtime-manager.ts",
];

/** CLI reporter flags. Passing any `--coverage.reporter` replaces the config list, so json must be restated. */
export const COVERAGE_REPORTER_FLAGS = [
  "--coverage.reporter=json",
  "--coverage.reporter=json-summary",
  "--coverage.reporter=text-summary",
];

export const TEST_REPORTER_FLAGS = (outputFile) => ["--reporter=json", `--outputFile=${outputFile}`];

function floorProjects(floors) {
  if (floors && typeof floors === "object" && floors.projects && typeof floors.projects === "object") {
    return floors.projects;
  }
  return floors ?? {};
}

function summaryMetric(summary, metric) {
  const value = summary?.total?.[metric]?.pct ?? summary?.[metric];
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function roundedPercentage(value) {
  return Number(Number(value).toFixed(2));
}

function evaluatePackageFloors(packageName, packageFloors, summary) {
  return COVERAGE_METRICS.flatMap((metric) => {
    const floor = Number(packageFloors?.[metric]);
    if (!Number.isFinite(floor)) return [];
    const current = summaryMetric(summary, metric);
    if (current !== undefined && current >= floor) return [];
    const delta = current === undefined ? Number.NEGATIVE_INFINITY : roundedPercentage(current - floor);
    const observed = current === undefined ? "missing" : `${current.toFixed(2)}%`;
    const signedDelta = current === undefined ? "-Infinity" : delta.toFixed(2);
    return [
      {
        current,
        delta,
        floor,
        message:
          `Coverage floor breach for package "${packageName}": ${metric} ${observed} is ` +
          `${signedDelta} percentage points (delta ${signedDelta}) below floor ${floor.toFixed(2)}%`,
        metric,
        packageName,
      },
    ];
  });
}

export function evaluateCoverageFloors(summaries, floors) {
  return Object.entries(floorProjects(floors)).flatMap(([packageName, packageFloors]) =>
    evaluatePackageFloors(packageName, packageFloors, summaries?.[packageName]),
  );
}

export function assertCoverageFloors(summaries, floors) {
  const breaches = evaluateCoverageFloors(summaries, floors);
  if (breaches.length > 0) throw new Error(breaches.map((breach) => breach.message).join("\n"));
  return true;
}

/** Return updated floors, refusing to lower any existing floor unless explicitly allowed. */
function ratchetPackageFloors(packageName, packageFloors, summary, allowDecrease) {
  const updated = { ...packageFloors };
  for (const metric of COVERAGE_METRICS) {
    const previous = Number(packageFloors?.[metric]);
    const current = summaryMetric(summary, metric);
    if (!Number.isFinite(previous) || current === undefined) continue;
    const next = roundedPercentage(current);
    const delta = roundedPercentage(next - previous);
    if (delta < 0 && !allowDecrease) {
      throw new Error(
        `Coverage floor ratchet would decrease package "${packageName}" ${metric} ` +
          `by ${Math.abs(delta).toFixed(2)} percentage points (delta ${delta.toFixed(2)}); ` +
          "pass --allow-floor-decrease only for an explicit decrease",
      );
    }
    updated[metric] = next;
  }
  return updated;
}

function newPackageFloors(summary) {
  return Object.fromEntries(
    COVERAGE_METRICS.flatMap((metric) => {
      const value = summaryMetric(summary, metric);
      return value === undefined ? [] : [[metric, roundedPercentage(value)]];
    }),
  );
}

export function ratchetCoverageFloors({ existing, summaries, allowDecrease = false }) {
  const currentProjects = summaries ?? {};
  const existingProjects = floorProjects(existing);
  const updated = Object.fromEntries(
    Object.entries(existingProjects).map(([packageName, packageFloors]) => [
      packageName,
      ratchetPackageFloors(packageName, packageFloors, currentProjects[packageName], allowDecrease),
    ]),
  );
  for (const [packageName, summary] of Object.entries(currentProjects)) {
    if (!updated[packageName]) updated[packageName] = newPackageFloors(summary);
  }
  return updated;
}

function normalizeManifestPath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

function globToRegExp(pattern) {
  let source = "";
  const normalized = normalizeManifestPath(pattern);
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "{") {
      const end = normalized.indexOf("}", index);
      if (end === -1) source += "\\{";
      else {
        source += `(?:${normalized
          .slice(index + 1, end)
          .split(",")
          .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        index = end;
      }
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function validateCoverageManifest({ sourceFiles, includePatterns, excludePatterns = [] }) {
  const files = [...new Set(sourceFiles.map(normalizeManifestPath))].sort();
  const includes = includePatterns.map(globToRegExp);
  const excludes = excludePatterns.map(globToRegExp);
  const isExcluded = (file) => excludes.some((pattern) => pattern.test(file));
  const missing = files.filter((file) => !isExcluded(file) && !includes.some((pattern) => pattern.test(file)));
  const unmatchedPatterns = includePatterns.filter(
    (pattern) => !files.some((file) => globToRegExp(pattern).test(file)),
  );
  return { missing, unmatchedPatterns };
}

function sourceFilesUnder(directory, relativeTo = directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (["node_modules", "dist", "coverage"].includes(entry.name)) continue;
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) {
        files.push(normalizeManifestPath(relative(relativeTo, absolute)));
      }
    }
  };
  visit(resolve(directory));
  return files.sort();
}

export function validateRepositoryCoverageManifest(root = repositoryRoot) {
  const projectSources = ROOT_COVERAGE_INCLUDE_PATTERNS.flatMap((pattern) => {
    const prefix = pattern.split("/src/")[0];
    return sourceFilesUnder(resolve(root, `${prefix}/src`), root);
  });
  const rootResult = validateCoverageManifest({
    excludePatterns: ROOT_COVERAGE_EXCLUDE_PATTERNS,
    includePatterns: ROOT_COVERAGE_INCLUDE_PATTERNS,
    sourceFiles: projectSources,
  });
  const clientRoot = resolve(root, "packages/client/src");
  const clientFiles = sourceFilesUnder(clientRoot, clientRoot).filter((file) =>
    AGENT_RUNTIME_SCOPE_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix)),
  );
  const agentResult = validateCoverageManifest({
    includePatterns: AGENT_RUNTIME_COVERAGE_INCLUDE.map((pattern) => pattern.replace(/^src\//, "")),
    sourceFiles: clientFiles,
  });
  return { agentRuntime: agentResult, root: rootResult };
}

export function assertRepositoryCoverageManifest(root = repositoryRoot) {
  const result = validateRepositoryCoverageManifest(root);
  const failures = [
    ...result.root.missing.map((file) => `root manifest missing source owner: ${file}`),
    ...result.root.unmatchedPatterns.map((pattern) => `root manifest pattern matches no source: ${pattern}`),
    ...result.agentRuntime.missing.map((file) => `Agent Runtime manifest missing source owner: ${file}`),
    ...result.agentRuntime.unmatchedPatterns.map(
      (pattern) => `Agent Runtime manifest pattern matches no source: ${pattern}`,
    ),
  ];
  if (failures.length > 0) throw new Error(`Coverage manifest validation failed:\n${failures.join("\n")}`);
  return result;
}

function parseArguments(argv) {
  const options = { allowFloorDecrease: false, project: null, scope: null, updateFloors: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--project") {
      options.project = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--scope") {
      options.scope = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--update-floors") {
      options.updateFloors = true;
    } else if (argv[index] === "--allow-floor-decrease" || argv[index] === "--allow-decrease") {
      options.allowFloorDecrease = true;
    }
  }
  return options;
}

export function assertCoverageArtifacts(reportsDirectory, projectName) {
  const summaryPath = resolve(reportsDirectory, "coverage-summary.json");
  const detailedPath = resolve(reportsDirectory, "coverage-final.json");
  if (!existsSync(summaryPath)) {
    throw new Error(`Coverage run for project "${projectName}" produced no summary`);
  }
  if (!existsSync(detailedPath)) {
    throw new Error(`Coverage run for project "${projectName}" produced no detailed report`);
  }
  return { detailedPath, summaryPath };
}

export function summarizeTestResults(report, elapsedMs = 0) {
  const files = Array.isArray(report?.testResults) ? report.testResults : [];
  const assertions = files.flatMap((file) => (Array.isArray(file?.assertionResults) ? file.assertionResults : []));
  const retryCount = assertions.reduce((total, assertion) => total + (Number(assertion?.retryCount) || 0), 0);
  const flakyCount = assertions.filter(
    (assertion) =>
      assertion?.flaky === true || ((Number(assertion?.retryCount) || 0) > 0 && assertion?.status === "passed"),
  ).length;
  const failedAfterRetryCount = assertions.filter(
    (assertion) => (Number(assertion?.retryCount) || 0) > 0 && assertion?.status !== "passed",
  ).length;
  const starts = files.map((file) => Number(file?.startTime)).filter(Number.isFinite);
  const ends = files
    .map((file) => {
      const start = Number(file?.startTime);
      const duration = Number(file?.duration);
      const end = Number(file?.endTime);
      return Number.isFinite(end)
        ? end
        : Number.isFinite(start) && Number.isFinite(duration)
          ? start + duration
          : undefined;
    })
    .filter(Number.isFinite);
  const reportDurationMs = starts.length > 0 && ends.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0;
  return {
    durationMs: roundedPercentage(reportDurationMs > 0 ? reportDurationMs : elapsedMs),
    failedAfterRetryCount,
    flakyCount,
    retryCount,
    testCount: Number(report?.numTotalTests) || assertions.length,
    testFileCount: Number(report?.numTotalTestSuites) || files.length,
  };
}

/**
 * Concatenate per-workspace Istanbul maps. Each file must appear in exactly one map: a second copy
 * is the merged-pass collision this script exists to avoid, not a number to max() or last-write.
 */
export function concatenateCoverageMaps(maps) {
  const aggregate = {};
  const owners = new Map();
  for (const [index, map] of maps.entries()) {
    if (map === null || typeof map !== "object" || Array.isArray(map)) {
      throw new Error(`Coverage map ${index} is not an Istanbul file map`);
    }
    for (const [file, coverage] of Object.entries(map)) {
      const owner = owners.get(file);
      if (owner !== undefined) {
        throw new Error(
          `Coverage map collision for ${file} (already recorded from map ${owner}, also in map ${index}). ` +
            "Per-workspace measurement must record each file once.",
        );
      }
      aggregate[file] = coverage;
      owners.set(file, index);
    }
  }
  return aggregate;
}

export function writeAggregateReports({ coverageRoot, detailedMaps, summary }) {
  mkdirSync(coverageRoot, { recursive: true });
  const detailed = concatenateCoverageMaps(detailedMaps);
  writeFileSync(resolve(coverageRoot, "coverage-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(resolve(coverageRoot, "coverage-final.json"), `${JSON.stringify(detailed)}\n`);
  return detailed;
}

function runProject(project, scope) {
  const reportsDirectory = resolve(COVERAGE_ROOT, project.name);
  mkdirSync(reportsDirectory, { recursive: true });
  const testResultsPath = resolve(reportsDirectory, "test-results.json");

  const include = scope ?? `${project.sources}/**/*.{ts,tsx}`;
  const startedAt = performance.now();
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.coverage.config.ts",
      "--project",
      project.name,
      `--coverage.include=${include}`,
      ...COVERAGE_REPORTER_FLAGS,
      `--coverage.reportsDirectory=${reportsDirectory}`,
      ...TEST_REPORTER_FLAGS(testResultsPath),
    ],
    { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    const { detailedPath, summaryPath } = assertCoverageArtifacts(reportsDirectory, project.name);
    return {
      detailed: JSON.parse(readFileSync(detailedPath, "utf8")),
      failed: result.status !== 0,
      testReport: existsSync(testResultsPath) ? JSON.parse(readFileSync(testResultsPath, "utf8")) : undefined,
      summary: JSON.parse(readFileSync(summaryPath, "utf8")),
      timing: summarizeTestResults(
        existsSync(testResultsPath) ? JSON.parse(readFileSync(testResultsPath, "utf8")) : undefined,
        performance.now() - startedAt,
      ),
    };
  } catch (error) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw error;
  }
}

function runSelectedProjects(selected, scope) {
  const aggregate = {};
  const detailedMaps = [];
  const perProject = [];
  const summaries = {};
  const timings = [];
  let anyFailed = false;
  for (const project of selected) {
    process.stdout.write(`\n── ${project.name} ──\n`);
    const { detailed, failed, summary, timing } = runProject(project, scope);
    anyFailed ||= failed;
    detailedMaps.push(detailed);
    summaries[project.name] = summary;
    timings.push({ ...timing, name: project.name });
    for (const [file, metrics] of Object.entries(summary)) {
      if (file !== "total") aggregate[file] = metrics;
    }
    perProject.push({ lines: summary.total.lines, name: project.name });
    const { covered, total, pct } = summary.total.lines;
    process.stdout.write(
      `   lines ${pct}% (${covered}/${total})${failed ? "  [tests failed]" : ""}; ` +
        `duration ${timing.durationMs.toFixed(0)}ms; retries ${timing.retryCount} (flaky ${timing.flakyCount})\n`,
    );
  }
  return { aggregate, anyFailed, detailedMaps, perProject, summaries, timings };
}

function enforceFloors({ floorDocument, options, selected, summaries }) {
  if (options.updateFloors) {
    if (options.project || options.scope) {
      throw new Error("--update-floors requires a full coverage run without --project or --scope");
    }
    floorDocument.projects = ratchetCoverageFloors({
      allowDecrease: options.allowFloorDecrease,
      existing: floorDocument.projects,
      summaries,
    });
    writeFileSync(COVERAGE_FLOORS_PATH, `${JSON.stringify(floorDocument, null, 2)}\n`);
    process.stdout.write(`Updated coverage floors in ${COVERAGE_FLOORS_PATH}\n`);
  }
  const selectedFloors = Object.fromEntries(selected.map(({ name }) => [name, floorProjects(floorDocument)[name]]));
  assertCoverageFloors(summaries, selectedFloors);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const selected = options.project ? PROJECTS.filter((entry) => entry.name === options.project) : PROJECTS;

  if (selected.length === 0) {
    throw new Error(`Unknown project "${options.project}". Known: ${PROJECTS.map((p) => p.name).join(", ")}`);
  }

  assertRepositoryCoverageManifest();
  const floorDocument = JSON.parse(readFileSync(COVERAGE_FLOORS_PATH, "utf8"));

  const { aggregate, anyFailed, detailedMaps, perProject, summaries, timings } = runSelectedProjects(
    selected,
    options.scope,
  );
  enforceFloors({ floorDocument, options, selected, summaries });

  const totals = Object.values(aggregate).reduce(
    (accumulator, metrics) => ({
      branchesCovered: accumulator.branchesCovered + metrics.branches.covered,
      branchesTotal: accumulator.branchesTotal + metrics.branches.total,
      functionsCovered: accumulator.functionsCovered + metrics.functions.covered,
      functionsTotal: accumulator.functionsTotal + metrics.functions.total,
      linesCovered: accumulator.linesCovered + metrics.lines.covered,
      linesTotal: accumulator.linesTotal + metrics.lines.total,
    }),
    {
      branchesCovered: 0,
      branchesTotal: 0,
      functionsCovered: 0,
      functionsTotal: 0,
      linesCovered: 0,
      linesTotal: 0,
    },
  );

  const percentage = (covered, total) => (total === 0 ? 100 : Number(((100 * covered) / total).toFixed(2)));
  aggregate.total = {
    branches: {
      covered: totals.branchesCovered,
      pct: percentage(totals.branchesCovered, totals.branchesTotal),
      total: totals.branchesTotal,
    },
    functions: {
      covered: totals.functionsCovered,
      pct: percentage(totals.functionsCovered, totals.functionsTotal),
      total: totals.functionsTotal,
    },
    lines: {
      covered: totals.linesCovered,
      pct: percentage(totals.linesCovered, totals.linesTotal),
      total: totals.linesTotal,
    },
    statements: {
      covered: totals.linesCovered,
      pct: percentage(totals.linesCovered, totals.linesTotal),
      total: totals.linesTotal,
    },
  };

  if (!options.project && !options.scope) {
    const detailed = writeAggregateReports({
      coverageRoot: COVERAGE_ROOT,
      detailedMaps,
      summary: aggregate,
    });
    process.stdout.write(`   detailed ${Object.keys(detailed).length} files -> coverage/unit/coverage-final.json\n`);
    writeFileSync(
      resolve(COVERAGE_ROOT, "coverage-run.json"),
      `${JSON.stringify({ packages: timings, version: 1 }, null, 2)}\n`,
    );
  }

  process.stdout.write("\n=== unit line coverage ===\n");
  for (const entry of perProject) {
    process.stdout.write(
      `${entry.name.padEnd(8)} ${String(entry.lines.pct).padStart(6)}%  ${entry.lines.covered}/${entry.lines.total}\n`,
    );
  }
  process.stdout.write(
    `${"TOTAL".padEnd(8)} ${String(aggregate.total.lines.pct).padStart(6)}%  ` +
      `${aggregate.total.lines.covered}/${aggregate.total.lines.total}\n`,
  );

  if (anyFailed) {
    process.stderr.write("\nAt least one project reported failing tests.\n");
    process.exitCode = 1;
  }
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main();
}
