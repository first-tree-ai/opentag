import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../e2e/cloud-startup/", import.meta.url));

function run(root, name, args, extraEnvironment = {}) {
  return spawnSync(process.execPath, [join(scripts, name), ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: root, ...extraEnvironment },
  });
}

function checkout(root, name, value, lock = "fixture-pi-lock") {
  const directory = join(root, name);
  const dist = join(directory, "packages/client/dist");
  const pi = join(directory, "scripts/runner/pi");
  const hooks = join(root, "empty-hooks");
  mkdirSync(dist, { recursive: true });
  mkdirSync(pi, { recursive: true });
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(dist, "index.mjs"), `export const value = ${JSON.stringify(value)};\n`);
  writeFileSync(
    join(directory, "packages/client/package.json"),
    '{"name":"@opentag/client","version":"0.0.0","dependencies":{}}',
  );
  writeFileSync(join(pi, "package.json"), '{"name":"fixture-pi","private":true}');
  writeFileSync(join(pi, "package-lock.json"), lock);
  writeFileSync(join(directory, ".env"), "PRIVATE_CHECKOUT_CANARY");
  for (const args of [
    ["init", "--quiet", "--template="],
    ["add", "."],
    ["commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = spawnSync(
      "git",
      [
        "-c",
        `core.hooksPath=${hooks}`,
        "-c",
        "user.name=Startup fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: directory, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" } },
    );
    assert.equal(result.status, 0, result.stderr);
  }
  return directory;
}

test("container-only benchmark entries reject an unguarded invocation before writing artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "startup-entry-guard-"));
  try {
    for (const name of ["worker-benchmark.mjs", "adapter-concurrent.mjs"]) {
      const output = join(root, `${name}.json`);
      const result = run(root, name, [root, output, "1"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /AssertionError/);
      assert.equal(existsSync(output), false);
      assert.equal(existsSync(`${output}.harness.mjs`), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preparation records distinct built artifacts and generates only synthetic execution input", () => {
  const root = mkdtempSync(join(tmpdir(), "startup-preparation-"));
  try {
    const before = checkout(root, "before", "baseline");
    const after = checkout(root, "after", "candidate");
    const destination = join(root, "fixture");
    const result = run(root, "prepare.mjs", [before, after, destination]);
    assert.equal(result.status, 0, result.stderr);
    const provenance = JSON.parse(readFileSync(join(destination, "provenance.json"), "utf8"));
    for (const version of ["before", "after"]) {
      const bytes = readFileSync(join(destination, version, "dist/index.mjs"));
      assert.equal(provenance[version].modules["index.mjs"], createHash("sha256").update(bytes).digest("hex"));
      assert.equal(provenance[version].sourceDirty, false);
      assert.equal(existsSync(join(destination, version, ".env")), false);
    }
    assert.notEqual(provenance.before.modules["index.mjs"], provenance.after.modules["index.mjs"]);
    const input = readFileSync(join(destination, "request.json"), "utf8");
    const request = JSON.parse(input);
    assert.deepEqual(request.delivery.runtime.contextTrees, []);
    assert.match(request.model.baseUrl, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(input.includes("PRIVATE_CHECKOUT_CANARY"), false);
    assert.equal(request.mcpGateway, undefined);
    assert.equal(request.webTools, undefined);
    const certificate = new X509Certificate(readFileSync(join(destination, "tls/ca.pem")));
    assert.equal(certificate.checkHost("localhost"), "localhost");
    assert.equal(certificate.checkIP("127.0.0.1"), "127.0.0.1");
    const sentinel = join(destination, "preserve");
    writeFileSync(sentinel, "existing fixture");
    const repeated = run(root, "prepare.mjs", [before, after, destination]);
    assert.notEqual(repeated.status, 0);
    assert.equal(readFileSync(sentinel, "utf8"), "existing fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preparation refuses mismatched Pi locks without publishing a complete fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "startup-lock-mismatch-"));
  try {
    const before = checkout(root, "before", "same", "before-lock");
    const after = checkout(root, "after", "same", "after-lock");
    const destination = join(root, "fixture");
    const result = run(root, "prepare.mjs", [before, after, destination]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pi locks must match/);
    assert.equal(existsSync(join(destination, "request.json")), false);
    assert.equal(existsSync(join(destination, "provenance.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent adapter measurement retains every rejected attempt without exposing error text", {
  skip: process.platform !== "linux",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "startup-rejected-attempts-"));
  try {
    for (const version of ["before", "after"]) {
      const dist = join(root, version, "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(
        join(dist, "index.mjs"),
        'export const RuntimeProxyLoopbackAdapter = { start: async () => { throw new Error("PRIVATE_ERROR_CANARY"); } };',
      );
    }
    const output = join(root, "results.json");
    const result = run(root, "adapter-concurrent.mjs", [root, output, "2"], { OPENTAG_STARTUP_FIXTURE: "1" });
    assert.equal(result.status, 1, result.stderr);
    const text = readFileSync(output, "utf8");
    const report = JSON.parse(text);
    assert.equal(report.records.length, 4);
    assert.equal(report.records.flatMap((record) => record.attempts).length, 8);
    assert.ok(report.records.every((record) => record.attempts.every((attempt) => attempt.status === "rejected")));
    assert.equal(text.includes("PRIVATE_ERROR_CANARY"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
