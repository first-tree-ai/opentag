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
 * per-workspace reports are concatenated rather than merged.
 *
 * Usage:
 *   node scripts/unit-coverage.mjs                 # every workspace, then the aggregate table
 *   node scripts/unit-coverage.mjs --project server  # one workspace, for a fast inner loop
 *   node scripts/unit-coverage.mjs --scope 'packages/server/src/services/im-bindings/**'
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
      "--coverage.reporter=json",
      "--coverage.reporter=json-summary",
      "--coverage.reporter=text-summary",
      `--coverage.reportsDirectory=${reportsDirectory}`,
    ],
    { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  const summaryPath = resolve(reportsDirectory, "coverage-summary.json");
  const coveragePath = resolve(reportsDirectory, "coverage-final.json");
  if (!existsSync(summaryPath) || !existsSync(coveragePath)) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`Coverage run for project "${project.name}" produced incomplete reports`);
  }

  return {
    coverage: JSON.parse(readFileSync(coveragePath, "utf8")),
    failed: result.status !== 0,
    summary: JSON.parse(readFileSync(summaryPath, "utf8")),
  };
}

function mergeCoverage(aggregateCoverage, projectCoverage) {
  for (const [file, metrics] of Object.entries(projectCoverage)) {
    if (Object.hasOwn(aggregateCoverage, file)) {
      throw new Error(`Coverage file was measured by more than one project: ${file}`);
    }
    aggregateCoverage[file] = metrics;
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const selected = options.project ? PROJECTS.filter((entry) => entry.name === options.project) : PROJECTS;

  if (selected.length === 0) {
    throw new Error(`Unknown project "${options.project}". Known: ${PROJECTS.map((p) => p.name).join(", ")}`);
  }

  const aggregate = {};
  const aggregateCoverage = {};
  const perProject = [];
  let anyFailed = false;

  for (const project of selected) {
    process.stdout.write(`\n── ${project.name} ──\n`);
    const { coverage, failed, summary } = runProject(project, options.scope);
    anyFailed ||= failed;
    mergeCoverage(aggregateCoverage, coverage);

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
    mkdirSync(COVERAGE_ROOT, { recursive: true });
    writeFileSync(resolve(COVERAGE_ROOT, "coverage-final.json"), `${JSON.stringify(aggregateCoverage, null, 2)}\n`);
    writeFileSync(resolve(COVERAGE_ROOT, "coverage-summary.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
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

main();
