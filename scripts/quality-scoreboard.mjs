import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_REPORT_SCRIPT = "scripts/report-bundle-sizes.mjs";
const DEFAULT_COVERAGE_PATH = "coverage/unit/coverage-final.json";
const DEFAULT_BUNDLE_DIRECTORY = "apps/web/dist/assets";
const DEFAULT_TEST_DURATION_PATH = "quality/test-duration.json";
const DEFAULT_HIGH_RISK_PATH = ".github/high-risk-items.json";
const IGNORED_DIRECTORY_NAMES = new Set([".git", ".turbo", "coverage", "dist", "node_modules"]);

function measured(value, note) {
  return note ? { value, status: "measured", note } : { value, status: "measured" };
}

function skipped(note) {
  return { value: null, status: "skipped", note };
}

function percentage(covered, total) {
  return total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));
}

function coverageMetric(total = 0, covered = 0) {
  return { total, covered, percent: percentage(covered, total) };
}

function normalizeCoverageSummary(total) {
  return {
    lines: coverageMetric(Number(total.lines?.total ?? 0), Number(total.lines?.covered ?? 0)),
    statements: coverageMetric(Number(total.statements?.total ?? 0), Number(total.statements?.covered ?? 0)),
    functions: coverageMetric(Number(total.functions?.total ?? 0), Number(total.functions?.covered ?? 0)),
    branches: coverageMetric(Number(total.branches?.total ?? 0), Number(total.branches?.covered ?? 0)),
  };
}

function isNormalizedCoverage(value) {
  return Boolean(value?.lines && value?.statements && value?.functions && value?.branches);
}

function countValues(values) {
  const counts = Object.values(values ?? {});
  return { total: counts.length, covered: counts.filter((count) => Number(count) > 0).length };
}

function aggregateCoverageFile(file, totals, lines) {
  for (const [key, value] of Object.entries(countValues(file.s))) totals.statements[key] += value;
  for (const [key, value] of Object.entries(countValues(file.f))) totals.functions[key] += value;
  const branchValues = Object.values(file.b ?? {}).flat();
  const branchCount = countValues(Object.fromEntries(branchValues.map((value, index) => [index, value])));
  totals.branches.total += branchCount.total;
  totals.branches.covered += branchCount.covered;
  for (const [key, mapEntry] of Object.entries(file.statementMap ?? {})) {
    const line = Number(mapEntry.start?.line);
    if (Number.isInteger(line) && line > 0) {
      lines.set(line, Math.max(lines.get(line) ?? 0, Number(file.s?.[key] ?? 0)));
    }
  }
}

/** Aggregate either an Istanbul coverage-final map or a coverage-summary total object. */
export function summarizeCoverage(coverage) {
  if (isNormalizedCoverage(coverage)) return coverage;
  if (coverage?.total) return normalizeCoverageSummary(coverage.total);
  const totals = {
    statements: { total: 0, covered: 0 },
    functions: { total: 0, covered: 0 },
    branches: { total: 0, covered: 0 },
  };
  const lines = new Map();
  for (const file of Object.values(coverage ?? {})) aggregateCoverageFile(file, totals, lines);
  const lineCounts = countValues(Object.fromEntries(lines));
  return {
    lines: { ...lineCounts, percent: percentage(lineCounts.covered, lineCounts.total) },
    statements: { ...totals.statements, percent: percentage(totals.statements.covered, totals.statements.total) },
    functions: { ...totals.functions, percent: percentage(totals.functions.covered, totals.functions.total) },
    branches: { ...totals.branches, percent: percentage(totals.branches.covered, totals.branches.total) },
  };
}

export function parseHighRiskItems(input) {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (Array.isArray(input)) return input.filter(isOpenRiskItem).length;
  if (input && typeof input === "object") {
    if (Number.isFinite(Number(input.count))) return Number(input.count);
    if (Array.isArray(input.items)) return input.items.filter(isOpenRiskItem).length;
  }
  if (typeof input === "string") {
    return input
      .split("\n")
      .filter((line) => /^\s*[-*]\s+\[\s\]/.test(line) && /high[- ]risk|security|critical/i.test(line)).length;
  }
  return null;
}

function isOpenRiskItem(item) {
  if (!item || typeof item !== "object") return true;
  if (item.open === false || item.state === "closed") return false;
  return !["closed", "resolved", "done"].includes(String(item.status ?? "").toLowerCase());
}

export function countComplexityWarnings(report) {
  const parsed = typeof report === "string" ? JSON.parse(report) : report;
  return (parsed?.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.severity === "warning" && String(diagnostic.category ?? "").includes("complexity"),
  ).length;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function runBiome(repositoryRoot) {
  const result = spawnSync("pnpm", ["exec", "biome", "check", ".", "--reporter=json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.stdout) {
    try {
      const value = countComplexityWarnings(result.stdout);
      return measured(value, result.status === 0 ? undefined : `Biome exited with status ${result.status}`);
    } catch {
      // Fall through to an explicit skip note when the reporter output is incomplete.
    }
  }
  return skipped("Biome JSON reporter was unavailable");
}

function runBundleReport(repositoryRoot, bundleDirectory) {
  const directory = resolve(repositoryRoot, bundleDirectory);
  const script = resolve(repositoryRoot, BUNDLE_REPORT_SCRIPT);
  if (!existsSync(directory)) return skipped(`${bundleDirectory} was not found`);
  const result = spawnSync(process.execPath, [script, bundleDirectory], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) return skipped("bundle-size report script failed");
  try {
    return measured(JSON.parse(result.stdout));
  } catch {
    return skipped("bundle-size report was not valid JSON");
  }
}

function collectLargestFiles(repositoryRoot, limit = 10) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !IGNORED_DIRECTORY_NAMES.has(entry.name)) visit(join(directory, entry.name));
      else if (entry.isFile()) {
        const path = join(directory, entry.name);
        files.push({ path: toPosix(relative(repositoryRoot, path)), bytes: statSync(path).size });
      }
    }
  }
  visit(repositoryRoot);
  return files.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path)).slice(0, limit);
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function readTestDuration(repositoryRoot, path) {
  const value = readJson(resolve(repositoryRoot, path));
  const duration = typeof value === "number" ? value : value?.durationMs;
  return Number.isFinite(Number(duration)) ? measured(Number(duration)) : skipped(`${path} was not found`);
}

function readHighRisk(repositoryRoot, path) {
  const input = readJson(resolve(repositoryRoot, path));
  const count = parseHighRiskItems(input);
  return count === null ? skipped(`${path} was not found`) : measured(count);
}

function readCoverage(repositoryRoot, path) {
  const absolutePath = resolve(repositoryRoot, path);
  const input = readJson(absolutePath);
  if (!input) return skipped(`${path} was not found`);
  return measured(input);
}

function gitRevision(repositoryRoot) {
  const result = spawnSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

export function createScoreboard({
  repositoryRoot,
  generatedAt = new Date().toISOString(),
  revision = "unknown",
  complexityWarnings,
  coverage,
  testDurationMs,
  bundleReport,
  largestFiles = [],
  openHighRiskItems,
}) {
  return {
    version: 1,
    generatedAt,
    commit: revision,
    repository: repositoryRoot,
    metrics: {
      complexityWarnings:
        complexityWarnings === undefined
          ? skipped("Biome JSON reporter was unavailable")
          : measured(complexityWarnings),
      unitCoverage:
        coverage === null || coverage === undefined
          ? skipped("coverage-final.json was not found")
          : measured(summarizeCoverage(coverage)),
      testDurationMs:
        testDurationMs === null || testDurationMs === undefined
          ? skipped("test duration artifact was not found")
          : measured(testDurationMs),
      bundleSizes:
        bundleReport === null || bundleReport === undefined
          ? skipped("bundle-size report was unavailable")
          : measured(bundleReport),
      largestFiles: measured(largestFiles),
      openHighRiskItems:
        openHighRiskItems === null || openHighRiskItems === undefined
          ? skipped("high-risk item source was not found")
          : measured(openHighRiskItems),
    },
  };
}

function displayValue(name, metric) {
  if (metric.status === "skipped") return "Skipped";
  if (name === "unitCoverage") return `${metric.value.lines.percent.toFixed(2)}% lines`;
  if (name === "bundleSizes") return `${metric.value.totalBytes} bytes (${metric.value.chunks.length} chunks)`;
  if (name === "largestFiles") return `${metric.value.length} files`;
  if (name === "testDurationMs") return `${metric.value} ms`;
  return String(metric.value);
}

export function renderMarkdown(scoreboard) {
  const rows = Object.entries(scoreboard.metrics)
    .map(([name, metric]) => `| ${name} | ${displayValue(name, metric)} | ${metric.status} | ${metric.note ?? ""} |`)
    .join("\n");
  const bundle = scoreboard.metrics.bundleSizes.value;
  const chunks = bundle?.chunks?.length
    ? `\n### Bundle chunks\n\n| File | Bytes |\n| --- | ---: |\n${bundle.chunks.map((chunk) => `| ${chunk.file} | ${chunk.bytes} |`).join("\n")}\n`
    : "";
  const largest = scoreboard.metrics.largestFiles.value;
  const largestTable = largest?.length
    ? `\n### Largest files\n\n| File | Bytes |\n| --- | ---: |\n${largest.map((file) => `| ${file.path} | ${file.bytes} |`).join("\n")}\n`
    : "";
  return `# Quality scoreboard\n\nGenerated: ${scoreboard.generatedAt}\n\nCommit: ${scoreboard.commit}\n\n| Metric | Value | Status | Note |\n| --- | --- | --- | --- |\n${rows}\n${chunks}${largestTable}`;
}

export function writeScoreboard(scoreboard, { jsonPath, markdownPath }) {
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(scoreboard, null, 2)}\n`);
  writeFileSync(markdownPath, `${renderMarkdown(scoreboard)}\n`);
  return { jsonPath, markdownPath };
}

function collectScoreboard(repositoryRoot, options) {
  const biome = runBiome(repositoryRoot);
  const coverage = readCoverage(repositoryRoot, options.coveragePath);
  const testDuration = readTestDuration(repositoryRoot, options.testDurationPath);
  const bundle = runBundleReport(repositoryRoot, options.bundleDirectory);
  const highRisk = readHighRisk(repositoryRoot, options.highRiskPath);
  return createScoreboard({
    repositoryRoot,
    revision: options.revision || gitRevision(repositoryRoot),
    complexityWarnings: biome.status === "skipped" ? undefined : biome.value,
    coverage: coverage.status === "skipped" ? null : coverage.value,
    testDurationMs: testDuration.status === "skipped" ? null : testDuration.value,
    bundleReport: bundle.status === "skipped" ? null : bundle.value,
    largestFiles: collectLargestFiles(repositoryRoot),
    openHighRiskItems: highRisk.status === "skipped" ? null : highRisk.value,
  });
}

function parseArguments(argv) {
  const options = {
    root: process.cwd(),
    jsonPath: "quality-scoreboard.json",
    markdownPath: "quality-scoreboard.md",
    coveragePath: DEFAULT_COVERAGE_PATH,
    bundleDirectory: DEFAULT_BUNDLE_DIRECTORY,
    testDurationPath: DEFAULT_TEST_DURATION_PATH,
    highRiskPath: DEFAULT_HIGH_RISK_PATH,
    revision: "",
  };
  const names = new Set(Object.keys(options));
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!argument?.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2).replaceAll("-", "");
    const key = [...names].find((candidate) => candidate.replaceAll("-", "").toLowerCase() === name.toLowerCase());
    if (!key) throw new Error(`Unknown option: ${argument}`);
    const value = argv[++index];
    if (!value) throw new Error(`${argument} requires a value`);
    options[key] = value;
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/quality-scoreboard.mjs [--root <path>] [--json-path <path>] [--markdown-path <path>]\n",
    );
    return 0;
  }
  const root = resolve(options.root);
  writeScoreboard(collectScoreboard(root, options), {
    jsonPath: resolve(root, options.jsonPath),
    markdownPath: resolve(root, options.markdownPath),
  });
  process.stdout.write(`Quality scoreboard written to ${options.jsonPath} and ${options.markdownPath}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
