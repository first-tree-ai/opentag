import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkComplexityRatchet } from "../check-complexity-ratchet.mjs";

const SCRIPT = join(import.meta.dirname, "..", "check-complexity-ratchet.mjs");

function warning(path, line, complexity) {
  return {
    severity: "warning",
    category: "lint/complexity/noExcessiveCognitiveComplexity",
    message: `Excessive complexity of ${complexity} detected (max: 15).`,
    location: { path, start: { line, column: 10 }, end: { line, column: 20 } },
  };
}

function fixture({ diagnostics, baselineWarnings, exceptions = [] }) {
  const root = mkdtempSync(join(tmpdir(), "opentag-complexity-ratchet-"));
  const sourcePath = join(root, "src/example.ts");
  const baselinePath = join(root, "baseline.json");
  const exceptionsPath = join(root, "exceptions.json");
  const reportPath = join(root, "biome.json");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    sourcePath,
    [
      "export function first(value: number) {",
      "  if (value > 0) return value;",
      "  return 0;",
      "}",
      "",
      "export function second(value: number) {",
      "  if (value > 0) return value;",
      "  return 0;",
      "}",
      "",
      "export function third(value: number) {",
      "  if (value > 0) return value;",
      "  return 0;",
      "}",
    ].join("\n"),
  );
  writeFileSync(reportPath, JSON.stringify({ diagnostics }, null, 2));
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ version: 1, rule: "lint/complexity/noExcessiveCognitiveComplexity", warnings: baselineWarnings }, null, 2)}\n`,
  );
  writeFileSync(exceptionsPath, `${JSON.stringify({ version: 1, maxLines: 500, exceptions }, null, 2)}\n`);
  return { root, sourcePath, baselinePath, exceptionsPath, reportPath };
}

function warningRecord(path, symbol, complexity) {
  return { id: `${path}#${symbol}`, path, symbol, complexity };
}

function run(paths, update = false, acceptCurrent = false) {
  return checkComplexityRatchet({
    rootDirectory: paths.root,
    reportPath: paths.reportPath,
    baselinePath: paths.baselinePath,
    exceptionsPath: paths.exceptionsPath,
    update,
    acceptCurrent,
    files: ["src/example.ts"],
    today: "2026-09-01",
  });
}

function runCli(paths, ...args) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--root",
      paths.root,
      "--report",
      paths.reportPath,
      "--baseline",
      paths.baselinePath,
      "--exceptions",
      paths.exceptionsPath,
      "--today",
      "2026-09-01",
      ...args,
    ],
    { encoding: "utf8" },
  );
}

test("fails a new complexity warning with its stable identity", () => {
  const paths = fixture({
    diagnostics: [warning("src/example.ts", 1, 22)],
    baselineWarnings: [],
  });
  try {
    assert.throws(() => run(paths), /New complexity warning.*src\/example\.ts#first/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("fails when a file has more complexity warnings than its baseline", () => {
  const paths = fixture({
    diagnostics: [warning("src/example.ts", 1, 22), warning("src/example.ts", 6, 21)],
    baselineWarnings: [warningRecord("src/example.ts", "first", 22)],
  });
  try {
    assert.throws(() => run(paths), /Complexity warning count increased.*src\/example\.ts.*1.*2/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("passes unchanged or improved complexity baselines", () => {
  const paths = fixture({
    diagnostics: [warning("src/example.ts", 1, 20)],
    baselineWarnings: [warningRecord("src/example.ts", "first", 20), warningRecord("src/example.ts", "second", 22)],
  });
  try {
    assert.equal(run(paths).improvedWarningCount, 1);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("--update records improvements but refuses regressions", () => {
  const paths = fixture({
    diagnostics: [warning("src/example.ts", 1, 20)],
    baselineWarnings: [warningRecord("src/example.ts", "first", 20), warningRecord("src/example.ts", "second", 22)],
  });
  try {
    run(paths, true);
    assert.deepEqual(JSON.parse(readFileSync(paths.baselinePath, "utf8")).warnings, [
      warningRecord("src/example.ts", "first", 20),
    ]);
    writeFileSync(
      paths.reportPath,
      JSON.stringify({ diagnostics: [warning("src/example.ts", 1, 20), warning("src/example.ts", 6, 22)] }),
    );
    assert.throws(() => run(paths, true), /New complexity warning|Complexity warning count increased/);
    assert.deepEqual(JSON.parse(readFileSync(paths.baselinePath, "utf8")).warnings, [
      warningRecord("src/example.ts", "first", 20),
    ]);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("--accept-current explicitly re-baselines regressions and prints every accepted entry", () => {
  const paths = fixture({
    diagnostics: [warning("src/example.ts", 1, 22)],
    baselineWarnings: [warningRecord("src/example.ts", "first", 20)],
    exceptions: [{ path: "src/example.ts", lines: 10, owner: "@alice", expires: "2026-10-31" }],
  });
  try {
    const result = runCli(paths, "--accept-current");
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Accepted current baseline entry: complexity src\/example\.ts#first/);
    assert.deepEqual(JSON.parse(readFileSync(paths.baselinePath, "utf8")).warnings, [
      warningRecord("src/example.ts", "first", 22),
    ]);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("fails expired file-size exceptions and names the owner", () => {
  const paths = fixture({
    diagnostics: [],
    baselineWarnings: [],
    exceptions: [{ path: "src/example.ts", lines: 10, owner: "@alice", expires: "2026-08-31" }],
  });
  try {
    assert.throws(() => run(paths), /Expired file-size exception.*src\/example\.ts.*@alice/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});
