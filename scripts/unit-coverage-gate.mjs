/**
 * Pure helpers for enforcing coverage on executable lines changed by a pull request.
 *
 * The coverage provider may omit files or statements that it could not instrument. Omissions are
 * treated as uncovered for changed executable lines, which keeps the gate fail closed.
 */

import { extname, isAbsolute, posix, relative } from "node:path";

export const SUPPORTED_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

const EXCLUDED_DIRECTORY_NAMES = new Set(["coverage", "dist", "node_modules"]);

function normalizePath(value) {
  return posix.normalize(String(value).replaceAll("\\", "/").replace(/^\.\//, ""));
}

function fileName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isSupportedSourcePath(value) {
  const path = normalizePath(value);
  const segments = path.split("/");
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
export function extractChangedLines(diffText) {
  const changed = new Map();
  let currentFile;
  let nextLine;

  for (const rawLine of String(diffText ?? "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      currentFile = path === "/dev/null" ? undefined : path.startsWith("b/") ? path.slice(2) : path;
      nextLine = undefined;
      continue;
    }
    if (line.startsWith("@@")) {
      const match = line.match(/^@@[^+]*\+(\d+)(?:,(\d+))?/);
      if (!match) throw new Error(`Unable to parse diff hunk: ${line}`);
      nextLine = Number(match[1]);
      continue;
    }
    if (!currentFile || nextLine === undefined || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      if (!line.startsWith("+++")) {
        const lines = changed.get(normalizePath(currentFile)) ?? [];
        lines.push({ content: line.slice(1), line: nextLine });
        changed.set(normalizePath(currentFile), lines);
        nextLine += 1;
      }
      continue;
    }
    if (!line.startsWith("-")) nextLine += 1;
  }

  return changed;
}

export function normalizeCoveragePath(rawPath, repositoryRoot) {
  const value = String(rawPath).replaceAll("\\", "/");
  return normalizePath(isAbsolute(value) ? relative(repositoryRoot, value) : value);
}

/** Map each normalized repository path to its maximum Istanbul statement hit per source line. */
export function buildLineHitsByFile(coverage, repositoryRoot) {
  const lineHitsByFile = new Map();
  for (const [rawFile, fileCoverage] of Object.entries(coverage ?? {})) {
    const file = normalizeCoveragePath(rawFile, repositoryRoot);
    const lineHits = lineHitsByFile.get(file) ?? new Map();
    for (const [statementId, statement] of Object.entries(fileCoverage?.statementMap ?? {})) {
      const line = statement?.start?.line;
      if (!Number.isInteger(line)) continue;
      const hits = Number(fileCoverage?.s?.[statementId] ?? 0);
      lineHits.set(line, Math.max(lineHits.get(line) ?? 0, Number.isFinite(hits) ? hits : 0));
    }
    lineHitsByFile.set(file, lineHits);
  }
  return lineHitsByFile;
}

export function evaluatePatchCoverage({ diff, coverage, repositoryRoot, threshold = 80 }) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error(`Patch coverage threshold must be between 0 and 100, received ${threshold}`);
  }

  const changedLines = extractChangedLines(diff);
  const lineHitsByFile = buildLineHitsByFile(coverage, repositoryRoot);
  const uncovered = [];
  let covered = 0;
  let total = 0;

  for (const [file, lines] of changedLines) {
    if (!isSupportedSourcePath(file)) continue;
    const lineHits = lineHitsByFile.get(file);
    for (const { content, line } of lines) {
      if (!isExecutableSourceLine(content)) continue;
      total += 1;
      if (!lineHits || !lineHits.has(line)) {
        uncovered.push(`${file}:${line} (missing coverage entry)`);
      } else if (lineHits.get(line) > 0) {
        covered += 1;
      } else {
        uncovered.push(`${file}:${line}`);
      }
    }
  }

  if (total === 0) {
    return { covered: 0, passed: true, percent: 100, reason: "no executable changed lines", total, uncovered };
  }

  const percent = (covered / total) * 100;
  return { covered, passed: uncovered.length === 0 && percent >= threshold, percent, total, uncovered };
}
