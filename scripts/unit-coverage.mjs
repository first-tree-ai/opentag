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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

/** CLI reporter flags. Passing any `--coverage.reporter` replaces the config list, so json must be restated. */
export const COVERAGE_REPORTER_FLAGS = [
  "--coverage.reporter=json",
  "--coverage.reporter=json-summary",
  "--coverage.reporter=text-summary",
];

function parseArguments(argv) {
  const options = { project: null, scope: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--project") {
      options.project = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--scope") {
      options.scope = argv[index + 1];
      index += 1;
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

  const include = scope ?? `${project.sources}/**/*.{ts,tsx}`;
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
    ],
    { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    const { detailedPath, summaryPath } = assertCoverageArtifacts(reportsDirectory, project.name);
    return {
      detailed: JSON.parse(readFileSync(detailedPath, "utf8")),
      failed: result.status !== 0,
      summary: JSON.parse(readFileSync(summaryPath, "utf8")),
    };
  } catch (error) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw error;
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const selected = options.project ? PROJECTS.filter((entry) => entry.name === options.project) : PROJECTS;

  if (selected.length === 0) {
    throw new Error(`Unknown project "${options.project}". Known: ${PROJECTS.map((p) => p.name).join(", ")}`);
  }

  const aggregate = {};
  const detailedMaps = [];
  const perProject = [];
  let anyFailed = false;

  for (const project of selected) {
    process.stdout.write(`\n── ${project.name} ──\n`);
    const { detailed, failed, summary } = runProject(project, options.scope);
    anyFailed ||= failed;
    detailedMaps.push(detailed);

    for (const [file, metrics] of Object.entries(summary)) {
      if (file !== "total") {
        aggregate[file] = metrics;
      }
    }
    perProject.push({ lines: summary.total.lines, name: project.name });
    const { covered, total, pct } = summary.total.lines;
    process.stdout.write(`   lines ${pct}% (${covered}/${total})${failed ? "  [tests failed]" : ""}\n`);
  }

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
