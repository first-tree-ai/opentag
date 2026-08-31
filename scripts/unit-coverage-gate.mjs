/**
 * Pure helpers for enforcing coverage on executable lines changed by a pull request.
 *
 * The coverage provider may omit files or statements that it could not instrument. Omissions are
 * treated as uncovered for changed executable lines, which keeps the gate fail closed.
 */

import { readFileSync } from "node:fs";
import { extname, isAbsolute, posix, relative, resolve } from "node:path";
import ts from "typescript";

export const SUPPORTED_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

const EXCLUDED_DIRECTORY_NAMES = new Set(["coverage", "dist", "node_modules"]);
const EXCLUDED_ROOT_NAMES = new Set(["e2e", "scripts"]);
const NON_EXECUTABLE_NODE_KINDS = new Set([
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.TypeLiteral,
]);
const nonExecutableLineCache = new Map();

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
  if (/^vitest(?:\..+)?\.config\.(?:cjs|cts|js|mjs|mts|ts)$/.test(name)) return false;
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

/** TypeScript's AST is needed for multiline type/import declarations; their lines do not produce runtime code. */
function nonExecutableSourceLines(file, repositoryRoot) {
  const cacheKey = `${repositoryRoot}\0${file}`;
  const cached = nonExecutableLineCache.get(cacheKey);
  if (cached) return cached;

  const lines = new Set();
  try {
    const sourcePath = resolve(repositoryRoot, file);
    const source = readFileSync(sourcePath, "utf8");
    const sourceFile = ts.createSourceFile(
      sourcePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.getScriptKindFromFileName(file),
    );
    const visit = (node) => {
      if (NON_EXECUTABLE_NODE_KINDS.has(node.kind)) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        for (let line = start; line <= end; line += 1) lines.add(line);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  } catch {
    // Synthetic diffs used by the pure gate tests have no source file to parse.
  }
  nonExecutableLineCache.set(cacheKey, lines);
  return lines;
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

function evaluateChangedFile({ file, lines, lineHits, repositoryRoot }) {
  if (!isSupportedSourcePath(file)) return { covered: 0, total: 0, uncovered: [] };
  const uncovered = [];
  let covered = 0;
  let total = 0;
  const nonExecutableLines = nonExecutableSourceLines(file, repositoryRoot);
  for (const { content, line } of lines) {
    if (nonExecutableLines.has(line) || !isExecutableSourceLine(content)) continue;
    total += 1;
    if (!lineHits?.has(line)) {
      uncovered.push(`${file}:${line} (missing coverage entry)`);
    } else if (lineHits.get(line) > 0) {
      covered += 1;
    } else {
      uncovered.push(`${file}:${line}`);
    }
  }
  return { covered, total, uncovered };
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
    const result = evaluateChangedFile({ file, lineHits: lineHitsByFile.get(file), lines, repositoryRoot });
    covered += result.covered;
    total += result.total;
    uncovered.push(...result.uncovered);
  }

  if (total === 0) {
    return { covered: 0, passed: true, percent: 100, reason: "no executable changed lines", total, uncovered };
  }

  const percent = (covered / total) * 100;
  return { covered, passed: uncovered.length === 0 && percent >= threshold, percent, total, uncovered };
}
