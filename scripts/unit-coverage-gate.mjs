/**
 * Pure helpers for enforcing coverage on executable lines changed by a pull request.
 *
 * A file the coverage provider never instrumented is treated as wholly uncovered, which keeps the
 * gate fail closed: a package that silently stopped being measured must not read as clean.
 *
 * Within a file it did instrument, the provider is the authority on which lines can be executed at
 * all. It emits no statement for a TypeScript interface member or a bare JSX text child, because
 * neither survives compilation as code, and no test can ever cover one. Counting those as uncovered
 * would fail a pull request for adding a type or changing a string, with nothing the author could
 * write to satisfy it — so a changed line an instrumented file has no statement for is skipped
 * rather than blamed.
 */

import { extname, isAbsolute, posix, relative } from "node:path";

export const SUPPORTED_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

const EXCLUDED_DIRECTORY_NAMES = new Set(["coverage", "dist", "node_modules"]);
const EXCLUDED_ROOT_NAMES = new Set(["e2e", "scripts"]);

function normalizePath(value) {
  return posix.normalize(String(value).replaceAll("\\", "/").replace(/^\.\//, ""));
}

function fileName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isSupportedSourcePath(value) {
  const path = normalizePath(value);
  const segments = path.split("/");
  if (EXCLUDED_ROOT_NAMES.has(segments[0])) return false;
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return false;
  if (segments.includes("paraglide") && segments.includes("src")) return false;
  const name = fileName(path);
  if (/\.d\.(?:cts|mts|ts)$/.test(name)) return false;
  if (/\.(?:test|spec)\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(name)) return false;
  return SUPPORTED_SOURCE_EXTENSIONS.has(extname(name).toLowerCase());
}

function isExecutableSourceLine(value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(?:\/\/|\/\*|\*|\*\/)/.test(trimmed)) return false;
  if (/^(?:import\s+type|export\s+(?:type|interface)\b|type\s+\w|interface\s+\w|declare\s+)/.test(trimmed)) {
    return false;
  }
  if (/^[{}[\]();,:]+$/.test(trimmed)) return false;
  return true;
}

/** Extract added lines from a unified diff, keyed by their post-change repository path. */
function parseDiffFileHeader(line) {
  if (!line.startsWith("+++ b/") && line !== "+++ /dev/null") return null;
  const path = line.slice(4);
  return path === "/dev/null" ? undefined : path.slice(0, 2) === "b/" ? path.slice(2) : path;
}

function parseDiffHunkStart(line) {
  if (!line.startsWith("@@")) return null;
  const match = line.match(/^@@[^+]*\+(\d+)(?:,(\d+))?/);
  if (!match) throw new Error(`Unable to parse diff hunk: ${line}`);
  return Number(match[1]);
}

function consumeDiffContent({ changed, currentFile, line, nextLine }) {
  if (!currentFile || nextLine === undefined || line.startsWith("\\")) return nextLine;
  if (line.startsWith("+")) {
    const normalizedFile = normalizePath(currentFile);
    const lines = changed.get(normalizedFile) ?? [];
    lines.push({ content: line.slice(1), line: nextLine });
    changed.set(normalizedFile, lines);
    return nextLine + 1;
  }
  return line.startsWith("-") ? nextLine : nextLine + 1;
}

export function extractChangedLines(diffText) {
  const changed = new Map();
  let currentFile;
  let nextLine;

  for (const rawLine of String(diffText ?? "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("+++ b/") || line === "+++ /dev/null") {
      currentFile = parseDiffFileHeader(line);
      nextLine = undefined;
      continue;
    }
    const hunkStart = parseDiffHunkStart(line);
    if (hunkStart !== null) {
      nextLine = hunkStart;
      continue;
    }
    nextLine = consumeDiffContent({ changed, currentFile, line, nextLine });
  }

  return changed;
}

export function normalizeCoveragePath(rawPath, repositoryRoot) {
  const value = String(rawPath).replaceAll("\\", "/");
  return normalizePath(isAbsolute(value) ? relative(repositoryRoot, value) : value);
}

/**
 * Record one statement's hits against every line it spans, keeping the highest count per line.
 *
 * A statement claims every line it covers, not just the one it starts on. The current provider
 * emits single-line statements, so today the result is the same either way; recording the span
 * means the gate can ask "does any statement cover this line", which is the question it means to
 * ask, rather than depending on a provider property nothing enforces.
 */
function recordStatementHits(lineHits, statement, rawHits) {
  const start = statement?.start?.line;
  if (!Number.isInteger(start)) return;
  const end = Number.isInteger(statement?.end?.line) ? Math.max(statement.end.line, start) : start;
  const hits = Number.isFinite(rawHits) ? rawHits : 0;
  for (let line = start; line <= end; line += 1) {
    lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits));
  }
}

/** Map each normalized repository path to its maximum statement hit per source line. */
export function buildLineHitsByFile(coverage, repositoryRoot) {
  const lineHitsByFile = new Map();
  for (const [rawFile, fileCoverage] of Object.entries(coverage ?? {})) {
    const file = normalizeCoveragePath(rawFile, repositoryRoot);
    const lineHits = lineHitsByFile.get(file) ?? new Map();
    for (const [statementId, statement] of Object.entries(fileCoverage?.statementMap ?? {})) {
      recordStatementHits(lineHits, statement, Number(fileCoverage?.s?.[statementId] ?? 0));
    }
    lineHitsByFile.set(file, lineHits);
  }
  return lineHitsByFile;
}

function evaluateChangedFile({ file, lines, lineHits }) {
  if (!isSupportedSourcePath(file)) return { covered: 0, total: 0, unmeasured: false, uncovered: [] };
  const instrumented = lineHits !== undefined;
  const uncovered = [];
  let covered = 0;
  let total = 0;
  for (const { content, line } of lines) {
    if (!isExecutableSourceLine(content)) continue;
    // The provider instrumented this file and no statement covers this line: it is a declaration or
    // a literal, not a statement a test could reach.
    if (instrumented && !lineHits.has(line)) continue;
    total += 1;
    if (!instrumented) {
      uncovered.push(`${file}:${line} (missing coverage entry)`);
    } else if (lineHits.get(line) > 0) {
      covered += 1;
    } else {
      uncovered.push(`${file}:${line}`);
    }
  }
  return { covered, total, unmeasured: !instrumented && total > 0, uncovered };
}

export function evaluatePatchCoverage({ diff, coverage, repositoryRoot, threshold = 80 }) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error(`Patch coverage threshold must be between 0 and 100, received ${threshold}`);
  }

  const changedLines = extractChangedLines(diff);
  const lineHitsByFile = buildLineHitsByFile(coverage, repositoryRoot);
  const uncovered = [];
  const unmeasured = [];
  let covered = 0;
  let total = 0;

  for (const [file, lines] of changedLines) {
    const result = evaluateChangedFile({ file, lineHits: lineHitsByFile.get(file), lines });
    covered += result.covered;
    total += result.total;
    uncovered.push(...result.uncovered);
    if (result.unmeasured) unmeasured.push(file);
  }

  if (total === 0) {
    return {
      covered: 0,
      passed: true,
      percent: 100,
      reason: "no executable changed lines",
      total,
      unmeasured,
      uncovered,
    };
  }

  /*
   * A percentage cannot speak for a file nothing measured. Enough covered lines elsewhere will
   * always outvote it, so a package that silently stopped being instrumented would read as clean
   * the moment its changed lines were a small enough share of the patch. That is the case the
   * fail-closed rule exists for, and it has to hold independently of the threshold.
   */
  const percent = (covered / total) * 100;
  return { covered, passed: percent >= threshold && unmeasured.length === 0, percent, total, unmeasured, uncovered };
}
