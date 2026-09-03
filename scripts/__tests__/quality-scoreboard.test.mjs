import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createScoreboard,
  parseHighRiskItems,
  renderMarkdown,
  summarizeCoverage,
  writeScoreboard,
} from "../quality-scoreboard.mjs";

test("summarizeCoverage aggregates Istanbul coverage-final data", () => {
  const summary = summarizeCoverage({
    "src/example.ts": {
      statementMap: {
        0: { start: { line: 1 }, end: { line: 1 } },
        1: { start: { line: 2 }, end: { line: 2 } },
      },
      s: { 0: 2, 1: 0 },
      f: { 0: 1, 1: 0 },
      b: { 0: [1, 0] },
    },
  });
  assert.deepEqual(summary.statements, { total: 2, covered: 1, percent: 50 });
  assert.deepEqual(summary.functions, { total: 2, covered: 1, percent: 50 });
  assert.deepEqual(summary.branches, { total: 2, covered: 1, percent: 50 });
  assert.deepEqual(summary.lines, { total: 2, covered: 1, percent: 50 });
});

test("parseHighRiskItems counts open entries and ignores closed entries", () => {
  assert.equal(
    parseHighRiskItems({
      items: [
        { id: "open", status: "open" },
        { id: "closed", status: "closed" },
        { id: "explicit", open: true },
      ],
    }),
    2,
  );
  assert.equal(parseHighRiskItems({ count: 4 }), 4);
});

test("createScoreboard preserves measured and skipped metric provenance", () => {
  const scoreboard = createScoreboard({
    repositoryRoot: "/repo",
    generatedAt: "2026-09-01T00:00:00.000Z",
    revision: "abc123",
    complexityWarnings: 3,
    coverage: null,
    testDurationMs: 1200,
    bundleReport: { totalBytes: 4096, chunks: [{ file: "app.js", bytes: 4096 }] },
    largestFiles: [{ path: "pnpm-lock.yaml", bytes: 2048 }],
    openHighRiskItems: 2,
  });
  assert.equal(scoreboard.version, 1);
  assert.equal(scoreboard.commit, "abc123");
  assert.deepEqual(scoreboard.metrics.complexityWarnings, { value: 3, status: "measured" });
  assert.deepEqual(scoreboard.metrics.unitCoverage, {
    value: null,
    status: "skipped",
    note: "coverage-final.json was not found",
  });
  assert.deepEqual(scoreboard.metrics.testDurationMs, { value: 1200, status: "measured" });
});

test("writeScoreboard emits JSON and a readable markdown summary", () => {
  const root = mkdtempSync(join(tmpdir(), "opentag-quality-scoreboard-"));
  try {
    const scoreboard = createScoreboard({
      repositoryRoot: root,
      generatedAt: "2026-09-01T00:00:00.000Z",
      revision: "abc123",
      complexityWarnings: 0,
      coverage: null,
      testDurationMs: null,
      bundleReport: null,
      largestFiles: [],
      openHighRiskItems: null,
    });
    const output = writeScoreboard(scoreboard, {
      jsonPath: join(root, "scoreboard.json"),
      markdownPath: join(root, "summary.md"),
    });
    assert.deepEqual(JSON.parse(readFileSync(output.jsonPath, "utf8")), scoreboard);
    const markdown = readFileSync(output.markdownPath, "utf8");
    assert.match(markdown, /Quality scoreboard/);
    assert.match(markdown, /coverage-final\.json was not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderMarkdown includes bundle and largest-file details", () => {
  const markdown = renderMarkdown(
    createScoreboard({
      repositoryRoot: "/repo",
      generatedAt: "2026-09-01T00:00:00.000Z",
      revision: "abc123",
      complexityWarnings: 1,
      coverage: null,
      testDurationMs: 100,
      bundleReport: { totalBytes: 10, chunks: [{ file: "app.js", bytes: 10 }] },
      largestFiles: [{ path: "README.md", bytes: 20 }],
      openHighRiskItems: 0,
    }),
  );
  assert.match(markdown, /app\.js/);
  assert.match(markdown, /README\.md/);
});
