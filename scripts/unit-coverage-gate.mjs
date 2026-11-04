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
import { isInsideMeasuredProject, isMeasuredSourcePath } from "./coverage-scope.mjs";

export const SUPPORTED_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

const EXCLUDED_DIRECTORY_NAMES = new Set(["coverage", "dist", "node_modules"]);
const EXCLUDED_ROOT_NAMES = new Set(["e2e", "scripts"]);
const TOOLING_CONFIG_FILE_PATTERN = /^[^/]+\.config\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/;

function normalizePath(value) {
  return posix.normalize(String(value).replaceAll("\\", "/").replace(/^\.\//, ""));
}

/**
 * Source outside every measured workspace: code that belongs to no coverage project yet, such as a new
 * workspace. It is judged, so a changed line there reads as "missing coverage entry" and blocks until
 * the workspace is added to `coverage-scope.mjs`, rather than going unmeasured without anyone noticing.
 * Repository tooling (`scripts`, `e2e`, top-level `*.config.*`) and build output are not source.
 */
function isUnownedSourcePath(path) {
  const segments = path.split("/");
  if (EXCLUDED_ROOT_NAMES.has(segments[0])) return false;
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return false;
  const name = segments.at(-1) ?? "";
  if (segments.length === 1 && TOOLING_CONFIG_FILE_PATTERN.test(name)) return false;
  if (/\.d\.(?:cts|mts|ts)$/.test(name)) return false;
  if (/\.(?:test|spec)\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(name)) return false;
  return SUPPORTED_SOURCE_EXTENSIONS.has(extname(name).toLowerCase());
}

/**
 * Whether the gate judges a changed file. Inside a measured workspace this is exactly what the coverage
 * run instruments, read from the scope the measurement itself uses, so a test helper, smoke harness or
 * tooling config is never judged, and a judged file without a coverage entry really went unmeasured.
 */
export function isSupportedSourcePath(value) {
  const path = normalizePath(value);
  return isInsideMeasuredProject(path) ? isMeasuredSourcePath(path) : isUnownedSourcePath(path);
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
/**
 * The post-change path of a `+++` header: `+++ b/<path>`, Git's C-style quoted `+++ "b/<path>"`, or
 * `undefined` for a deletion (`+++ /dev/null`). `null` when the line is not such a header. Both the
 * changed-line and the surviving-target readers use this one decoder, so they agree on every path.
 */
function parseDiffFileHeader(line) {
  if (line === "+++ /dev/null") return undefined;
  if (line.startsWith("+++ b/")) return line.slice(6);
  if (line.startsWith('+++ "b/')) return unquoteGitPath(line.slice(4)).slice(2);
  return null;
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
  // A missing or non-string diff is a wiring bug, not an empty patch: refuse it instead of
  // coercing it into the explicit no-executable-lines pass, which would read as a green gate.
  if (typeof diffText !== "string") {
    throw new Error(`A unified diff string is required, received ${diffText === null ? "null" : typeof diffText}`);
  }
  const changed = new Map();
  let currentFile;
  let nextLine;

  for (const rawLine of diffText.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const header = parseDiffFileHeader(line);
    if (header !== null) {
      currentFile = header;
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

/** Undo Git's C-style quoting of a path that holds special characters (`"a\\303\\251.ts"`). */
function unquoteGitPath(value) {
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
  const bytes = [];
  const body = value.slice(1, -1);
  const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== "\\") {
      bytes.push(...Buffer.from(character, "utf8"));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else {
      bytes.push(simple[body[index + 1]] ?? body.charCodeAt(index + 1));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Every path that exists after the change, whether or not it gained a line: the `+++ b/` target of a
 * modified or added file, and the `rename to` / `copy to` target of a rename or copy, which a pure
 * rename emits with no hunk at all. Deleted files (`+++ /dev/null`) are not targets.
 */
export function extractChangedTargets(diffText) {
  if (typeof diffText !== "string") {
    throw new Error(`A unified diff string is required, received ${diffText === null ? "null" : typeof diffText}`);
  }
  const targets = new Set();
  for (const rawLine of diffText.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const header = parseDiffFileHeader(line);
    const target =
      header !== null
        ? header
        : /^(?:rename|copy) to /.test(line)
          ? unquoteGitPath(line.replace(/^(?:rename|copy) to /, ""))
          : undefined;
    if (target) targets.add(normalizePath(target));
  }
  return targets;
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
  if (!isSupportedSourcePath(file)) return { covered: 0, total: 0, uncovered: [], unmeasured: false };
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
  // A judged file without an entry was not measured, whatever its changed lines contain: the provider
  // reports a type-only file too, with an empty statement map, so its absence is the failure itself.
  return { covered, total, uncovered, unmeasured: !instrumented };
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
  // A surviving file with no added line, such as a pure rename, contributes nothing to the percentage,
  // but it must still have been measured: a rename that dropped out of coverage reads as green otherwise.
  for (const file of extractChangedTargets(diff)) {
    if (changedLines.has(file) || !isSupportedSourcePath(file) || lineHitsByFile.has(file)) continue;
    unmeasured.push(file);
  }

  // A changed file the run should have measured but did not blocks on its own, whatever the
  // percentage, and even when nothing in the patch is executable: neither a covered remainder nor an
  // all-declaration patch may hide a package that stopped being measured.
  const measured = unmeasured.length === 0;
  if (total === 0) {
    return {
      covered: 0,
      passed: measured,
      percent: 100,
      reason: "no executable changed lines",
      total,
      uncovered,
      unmeasured,
    };
  }

  const percent = (covered / total) * 100;
  return { covered, passed: percent >= threshold && measured, percent, total, uncovered, unmeasured };
}
