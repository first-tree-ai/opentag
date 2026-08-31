#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMPLEXITY_RULE = "lint/complexity/noExcessiveCognitiveComplexity";
const DEFAULTS = {
  baselinePath: "scripts/complexity-baseline.json",
  exceptionsPath: "scripts/file-size-exceptions.json",
};

function fail(message) {
  throw new Error(`Complexity ratchet: ${message}`);
}

function readJson(filePath, description) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${description} does not exist: ${filePath}`);
    if (error instanceof SyntaxError) fail(`${description} is not valid JSON: ${filePath}`);
    throw error;
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function relativePath(rootDirectory, filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized.startsWith("/")) return relative(rootDirectory, normalized).replaceAll("\\", "/");
  return normalized.replace(/^\.\//, "");
}

function parseComplexity(message) {
  const match = /complexity\s+of\s+(\d+)/i.exec(message ?? "");
  return match ? Number(match[1]) : null;
}

function declarationName(line) {
  const patterns = [
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\*?/,
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    /\bclass\s+([A-Za-z_$][\w$]*)/,
    /^(?:\s*)(?:(?:public|private|protected|static|async|get|set|readonly|abstract|override)\s+)*([#$A-Za-z_$][\w$]*)\s*\(/,
  ];
  const ignored = new Set(["if", "for", "while", "switch", "catch", "with"]);
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (match && !ignored.has(match[1])) return match[1];
  }
  return null;
}

function stableSymbol(rootDirectory, path, diagnostic) {
  const sourcePath = resolve(rootDirectory, path);
  let lines = [];
  try {
    lines = readFileSync(sourcePath, "utf8").split(/\r?\n/);
  } catch {
    // A reporter can contain a generated or deleted path. The source line still provides
    // a deterministic identity without making the ratchet depend on line numbers.
  }
  const targetLine = Math.max(0, Number(diagnostic.location?.start?.line ?? 1) - 1);
  for (let index = Math.min(targetLine, lines.length - 1); index >= Math.max(0, targetLine - 200); index -= 1) {
    const name = declarationName(lines[index] ?? "");
    if (name) return name;
    if (lines[index]?.includes("=>")) return "callback";
  }
  const line = (lines[targetLine] ?? diagnostic.message ?? "").replace(/\s+/g, " ").trim();
  const digest = createHash("sha256").update(line).digest("hex").slice(0, 12);
  return `anonymous-${digest}`;
}

function sourceFingerprint(rootDirectory, path, diagnostic) {
  const sourcePath = resolve(rootDirectory, path);
  try {
    const lines = readFileSync(sourcePath, "utf8").split(/\r?\n/);
    const targetLine = Math.max(0, Number(diagnostic.location?.start?.line ?? 1) - 1);
    let declarationLine = -1;
    for (let index = Math.min(targetLine, lines.length - 1); index >= Math.max(0, targetLine - 200); index -= 1) {
      if (declarationName(lines[index] ?? "") || lines[index]?.includes("=>")) {
        declarationLine = index;
        break;
      }
    }
    let source = lines[targetLine] ?? diagnostic.message ?? "";
    if (declarationLine >= 0) {
      let depth = 0;
      let opened = false;
      let end = declarationLine;
      for (; end < lines.length; end += 1) {
        const line = lines[end];
        for (const character of line) {
          if (character === "{") {
            opened = true;
            depth += 1;
          } else if (character === "}" && opened) {
            depth -= 1;
          }
        }
        if (opened && depth === 0) break;
      }
      source = lines.slice(declarationLine, end + 1).join("\n");
    }
    return createHash("sha256").update(source.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
  } catch {
    return createHash("sha256")
      .update(String(diagnostic.message ?? ""))
      .digest("hex")
      .slice(0, 12);
  }
}

function readReport({ rootDirectory, reportPath }) {
  if (reportPath) return readJson(reportPath, "Biome JSON report");
  const result = spawnSync("pnpm", ["exec", "biome", "lint", ".", "--reporter=json"], {
    cwd: rootDirectory,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = result.stdout ?? "";
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) {
    fail(`Biome JSON reporter did not produce a JSON document${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch (error) {
    fail(`Biome JSON report could not be parsed: ${error.message}`);
  }
}

function currentWarnings(report, rootDirectory) {
  const diagnostics = Array.isArray(report) ? report : report?.diagnostics;
  if (!Array.isArray(diagnostics)) fail("Biome report diagnostics must be an array");
  const candidates = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic?.severity !== "warning" || diagnostic.category !== COMPLEXITY_RULE) continue;
    const path = relativePath(rootDirectory, String(diagnostic.location?.path ?? "unknown"));
    const symbol = stableSymbol(rootDirectory, path, diagnostic);
    candidates.push({
      baseId: `${path}#${symbol}`,
      fingerprint: sourceFingerprint(rootDirectory, path, diagnostic),
      path,
      symbol,
      complexity: parseComplexity(diagnostic.message),
    });
  }
  const groups = new Map();
  for (const candidate of candidates) {
    const group = groups.get(candidate.baseId) ?? [];
    group.push(candidate);
    groups.set(candidate.baseId, group);
  }
  const warnings = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
    group.forEach((candidate, index) => {
      warnings.push({
        id: index === 0 ? candidate.baseId : `${candidate.baseId}~${index + 1}`,
        path: candidate.path,
        symbol: candidate.symbol,
        complexity: candidate.complexity,
      });
    });
  }
  return warnings.sort((left, right) => left.id.localeCompare(right.id));
}

function validateWarnings(warnings, description) {
  if (!Array.isArray(warnings)) fail(`${description} warnings must be an array`);
  return warnings.map((warning, index) => {
    if (!warning || typeof warning !== "object") fail(`${description} warning ${index} is invalid`);
    if (typeof warning.id !== "string" || typeof warning.path !== "string" || typeof warning.symbol !== "string") {
      fail(`${description} warning ${index} must have id, path, and symbol`);
    }
    if (!Number.isInteger(warning.complexity)) fail(`${description} warning ${warning.id} has invalid complexity`);
    return {
      id: warning.id,
      path: warning.path,
      symbol: warning.symbol,
      complexity: warning.complexity,
    };
  });
}

function readBaseline(baselinePath, update) {
  if (!existsSync(baselinePath)) {
    if (update) return { version: 1, rule: COMPLEXITY_RULE, warnings: [], initial: true };
    fail(`complexity baseline does not exist: ${baselinePath}`);
  }
  const baseline = readJson(baselinePath, "complexity baseline");
  if (baseline?.version !== 1 || baseline.rule !== COMPLEXITY_RULE) {
    fail(`complexity baseline must have version 1 and rule ${COMPLEXITY_RULE}`);
  }
  return { ...baseline, warnings: validateWarnings(baseline.warnings, "baseline"), initial: false };
}

function countByPath(warnings) {
  const counts = new Map();
  for (const warning of warnings) counts.set(warning.path, (counts.get(warning.path) ?? 0) + 1);
  return counts;
}

function compareWarnings(baselineWarnings, current) {
  const baseline = new Map(baselineWarnings.map((warning) => [warning.id, warning]));
  const newWarnings = current.filter((warning) => !baseline.has(warning.id));
  const baselineCounts = countByPath(baselineWarnings);
  const currentCounts = countByPath(current);
  const countRegressions = [];
  for (const [path, count] of currentCounts) {
    const previous = baselineCounts.get(path) ?? 0;
    if (count > previous) countRegressions.push({ path, previous, current: count });
  }
  const complexityRegressions = current
    .filter((warning) => baseline.has(warning.id) && warning.complexity > baseline.get(warning.id).complexity)
    .map((warning) => ({ warning, previous: baseline.get(warning.id).complexity }));
  const improvedWarningCount = baselineWarnings.filter((warning) => {
    const next = current.find((candidate) => candidate.id === warning.id);
    return !next || next.complexity < warning.complexity;
  }).length;
  return { newWarnings, countRegressions, complexityRegressions, improvedWarningCount };
}

function readExceptions(exceptionsPath) {
  if (!existsSync(exceptionsPath)) return { version: 1, maxLines: 500, exceptions: [] };
  const value = readJson(exceptionsPath, "file-size exceptions");
  if (value?.version !== 1 || !Array.isArray(value.exceptions)) {
    fail("file-size exceptions must have version 1 and an exceptions array");
  }
  for (const [index, exception] of value.exceptions.entries()) {
    if (
      !exception ||
      typeof exception.path !== "string" ||
      !Number.isInteger(exception.lines) ||
      typeof exception.owner !== "string" ||
      typeof exception.expires !== "string"
    ) {
      fail(`file-size exception ${index} must have path, integer lines, owner, and expiry`);
    }
  }
  return value;
}

function checkExceptions({ rootDirectory, exceptionsPath, today, update, acceptCurrent, files }) {
  const data = readExceptions(exceptionsPath);
  const failures = [];
  const acceptedEntries = [];
  let improved = false;
  let changed = false;
  const allowedFiles = files ? new Set(files.map((file) => relativePath(rootDirectory, file))) : null;
  const exceptions = data.exceptions.map((exception) => {
    const path = relativePath(rootDirectory, exception.path);
    if (exception.expires < today) {
      failures.push(`Expired file-size exception for ${path}; owner ${exception.owner}, expired ${exception.expires}`);
    }
    const filePath = resolve(rootDirectory, path);
    if (!existsSync(filePath)) {
      failures.push(`File-size exception path does not exist: ${path} (owner ${exception.owner})`);
      return { ...exception, path };
    }
    if (allowedFiles && !allowedFiles.has(path)) return { ...exception, path };
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/).length - 1;
    if (lines > exception.lines) {
      if (acceptCurrent) {
        acceptedEntries.push(`file-size ${path} (baseline ${exception.lines}, current ${lines})`);
        changed = true;
        return { ...exception, path, lines };
      }
      failures.push(`File-size exception grew for ${path}: baseline ${exception.lines}, current ${lines}`);
    } else if (update && lines < exception.lines && exception.expires >= today) {
      improved = true;
      changed = true;
      return { ...exception, path, lines };
    }
    return { ...exception, path };
  });
  if (update && changed && failures.length === 0) writeJson(exceptionsPath, { ...data, exceptions });
  return { failures, improved, acceptedEntries };
}

function evaluateWarningChanges(comparison, acceptCurrent) {
  const failures = [];
  const acceptedEntries = [];
  for (const warning of comparison.newWarnings) {
    const diagnostic = `complexity ${warning.id} (new, current ${warning.complexity})`;
    if (acceptCurrent) acceptedEntries.push(diagnostic);
    else failures.push(`New complexity warning ${warning.id} (complexity ${warning.complexity})`);
  }
  for (const regression of comparison.countRegressions) {
    if (!acceptCurrent) {
      failures.push(
        `Complexity warning count increased for ${regression.path}: baseline ${regression.previous}, current ${regression.current}`,
      );
    }
  }
  for (const regression of comparison.complexityRegressions) {
    const diagnostic = `complexity ${regression.warning.id} (baseline ${regression.previous}, current ${regression.warning.complexity})`;
    if (acceptCurrent) acceptedEntries.push(diagnostic);
    else {
      failures.push(
        `Complexity warning worsened for ${regression.warning.id}: baseline ${regression.previous}, current ${regression.warning.complexity}`,
      );
    }
  }
  return { failures, acceptedEntries };
}

export function checkComplexityRatchet({
  rootDirectory = process.cwd(),
  report,
  reportPath,
  baselinePath = join(rootDirectory, DEFAULTS.baselinePath),
  exceptionsPath = join(rootDirectory, DEFAULTS.exceptionsPath),
  update = false,
  acceptCurrent = false,
  today = new Date().toISOString().slice(0, 10),
  files,
} = {}) {
  const root = resolve(rootDirectory);
  const resolvedBaselinePath = resolve(root, baselinePath);
  const resolvedExceptionsPath = resolve(root, exceptionsPath);
  const current = currentWarnings(report ?? readReport({ rootDirectory: root, reportPath }), root);
  const baseline = readBaseline(resolvedBaselinePath, update);
  const comparison = baseline.initial
    ? { newWarnings: [], countRegressions: [], complexityRegressions: [], improvedWarningCount: 0 }
    : compareWarnings(baseline.warnings, current);
  if (acceptCurrent) update = true;
  const warningResult = evaluateWarningChanges(comparison, acceptCurrent);
  const failures = [...warningResult.failures];
  const acceptedEntries = [...warningResult.acceptedEntries];
  const exceptionResult = checkExceptions({
    rootDirectory: root,
    exceptionsPath: resolvedExceptionsPath,
    today,
    update,
    acceptCurrent,
    files,
  });
  failures.push(...exceptionResult.failures);
  acceptedEntries.push(...exceptionResult.acceptedEntries);
  if (failures.length > 0) fail(`\n${failures.map((failure) => `- ${failure}`).join("\n")}`);

  if (update) {
    writeJson(resolvedBaselinePath, {
      version: 1,
      rule: COMPLEXITY_RULE,
      warnings: current,
    });
  }
  return {
    warningCount: current.length,
    baselineWarningCount: baseline.warnings.length,
    improvedWarningCount: comparison.improvedWarningCount,
    updated: update,
    acceptedEntries,
  };
}

function parseArgs(argv) {
  const options = { update: false };
  const optionKeys = {
    "--root": "rootDirectory",
    "--report": "reportPath",
    "--baseline": "baselinePath",
    "--exceptions": "exceptionsPath",
    "--today": "today",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--update") {
      options.update = true;
      continue;
    }
    if (arg === "--accept-current") {
      options.acceptCurrent = true;
      options.update = true;
      continue;
    }
    const key = optionKeys[arg];
    if (!key) fail(`unknown argument ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
    options[key] = value;
  }
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = checkComplexityRatchet(parseArgs(process.argv.slice(2)));
    for (const entry of result.acceptedEntries) console.log(`Accepted current baseline entry: ${entry}`);
    console.log(
      `Complexity ratchet passed: ${result.warningCount} warning(s), ${result.improvedWarningCount} improvement(s).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
