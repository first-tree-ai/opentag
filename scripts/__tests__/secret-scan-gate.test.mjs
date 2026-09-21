import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyResults, describeResult, parseArgs, parseResults, runSecretScanGate } from "../secret-scan-gate.mjs";

const SCRIPT = join(import.meta.dirname, "..", "secret-scan-gate.mjs");
const SECRET = "postgres://user:pw@host:5432";

function gitResult({ file, verified = false, detector = "Postgres", line = 1 }) {
  const git = { commit: "a6be9fb957b71cf27c9ae6dbab028921359e1f82", repository: "file:///repo", line };
  if (file !== undefined) git.file = file;
  return {
    SourceMetadata: { Data: { Git: git } },
    SourceName: "trufflehog - git",
    DetectorName: detector,
    Verified: verified,
    Raw: SECRET,
    RawV2: SECRET,
  };
}

function jsonl(...results) {
  return `${results.map((result) => JSON.stringify(result)).join("\n")}\n`;
}

function run(input, ...args) {
  const root = mkdtempSync(join(tmpdir(), "opentag-secret-scan-gate-"));
  const path = join(root, "trufflehog.jsonl");
  writeFileSync(path, input);
  try {
    return spawnSync(process.execPath, [SCRIPT, path, ...args], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("suppresses an unverified finding in a commit message", () => {
  const result = run(jsonl(gitResult({ verified: false })));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /1 raw result\(s\), 0 reported, 1 suppressed/);
  assert.match(
    result.stdout,
    /suppressed \(unverified commit metadata\): Postgres \(unverified\) in commit message of a6be9fb957b7\n/,
  );
});

test("reports a verified finding in a commit message", () => {
  const result = run(jsonl(gitResult({ verified: true })));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /reported: Postgres \(verified\) in commit message of/);
});

test("reports an unverified finding in a file", () => {
  const result = run(jsonl(gitResult({ file: "packages/server/src/db.ts", line: 12 })));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /reported: Postgres \(unverified\) in packages\/server\/src\/db\.ts:12 at/);
});

test("never prints the raw secret", () => {
  const result = run(jsonl(gitResult({ file: "packages/server/src/db.ts" }), gitResult({ verified: false })));
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /user:pw/);
});

test("passes on an empty scan", () => {
  const result = run("");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /0 raw result\(s\), 0 reported, 0 suppressed/);
});

test("fails when the TruffleHog output is not JSON", () => {
  const result = run("not json\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /line 1 of the TruffleHog output is not JSON/);
});

test("fails when the TruffleHog output does not exist", () => {
  const result = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), "opentag-missing-trufflehog.jsonl")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TruffleHog output does not exist/);
});

test("fails closed on a result that is not a recognized git chunk", () => {
  const { reported, suppressed } = classifyResults([{ DetectorName: "Postgres", Verified: false, Raw: SECRET }]);
  assert.equal(suppressed.length, 0);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].fromCommitMetadata, false);
});

test("describes a git chunk without a path as commit metadata", () => {
  const finding = describeResult(gitResult({ verified: false }));
  assert.deepEqual(
    { file: finding.file, fromCommitMetadata: finding.fromCommitMetadata, detector: finding.detector },
    { file: "", fromCommitMetadata: true, detector: "Postgres" },
  );
});

test("parses only non-empty lines and rejects arrays", () => {
  assert.equal(parseResults("\n\n").length, 0);
  assert.throws(() => parseResults("[]\n"), /not a result object/);
});

test("emits a GitHub Actions annotation for every reported finding", () => {
  const { report } = runSecretScanGate(jsonl(gitResult({ file: "a.ts" })), { githubActions: true });
  assert.match(report, /::error::Secret scan finding: Postgres/);
});

test("annotates only when --github-actions is passed", () => {
  const plain = run(jsonl(gitResult({ file: "a.ts" })));
  assert.doesNotMatch(plain.stdout, /::error::/);
  const annotated = run(jsonl(gitResult({ file: "a.ts" })), "--github-actions");
  assert.match(annotated.stdout, /::error::Secret scan finding: Postgres/);
});

test("rejects an unknown flag and a second input path", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown argument --nope/);
  assert.throws(() => parseArgs(["a.jsonl", "b.jsonl"]), /unexpected second input path b\.jsonl/);
  assert.deepEqual(parseArgs([]), { path: "-", githubActions: false });
});
