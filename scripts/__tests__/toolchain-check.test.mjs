import assert from "node:assert/strict";
import test from "node:test";
import {
  formatToolchainReport,
  parsePackageManager,
  satisfiesEngineRange,
  validateToolchain,
} from "../toolchain-check.mjs";

const engineRange = "^22.13.0 || ^24.0.0 || ^26.0.0";

test("satisfiesEngineRange accepts the supported Node release lines and lower bounds", () => {
  assert.equal(satisfiesEngineRange("22.13.0", engineRange), true);
  assert.equal(satisfiesEngineRange("24.19.0", engineRange), true);
  assert.equal(satisfiesEngineRange("26.0.0", engineRange), true);
  assert.equal(satisfiesEngineRange("22.12.0", engineRange), false);
  assert.equal(satisfiesEngineRange("23.0.0", engineRange), false);
  assert.equal(satisfiesEngineRange("27.0.0", engineRange), false);
});

test("validateToolchain requires the pinned Node version and package manager", () => {
  const valid = validateToolchain({
    nodeVersion: "24.19.0",
    nodeVersionFile: "24.19.0",
    nodeEngine: engineRange,
    pnpmVersion: "10.12.1",
    packageManager: "pnpm@10.12.1",
  });
  assert.deepEqual(valid, []);

  const invalid = validateToolchain({
    nodeVersion: "24.18.0",
    nodeVersionFile: "24.19.0",
    nodeEngine: engineRange,
    pnpmVersion: "9.15.0",
    packageManager: "pnpm@10.12.1",
  });
  assert.equal(invalid.length, 2);
  assert.match(invalid[0], /\.node-version/);
  assert.match(invalid[1], /pnpm/);
});

test("parsePackageManager rejects unsupported or unpinned package manager declarations", () => {
  assert.deepEqual(parsePackageManager("pnpm@10.12.1"), { name: "pnpm", version: "10.12.1" });
  assert.throws(() => parsePackageManager("npm@10.0.0"), /pnpm/);
  assert.throws(() => parsePackageManager("pnpm@^10.0.0"), /exact pnpm version/);
});

test("formatToolchainReport includes all observed and expected versions", () => {
  const report = formatToolchainReport({
    nodeVersion: "24.19.0",
    nodeVersionFile: "24.19.0",
    nodeEngine: engineRange,
    pnpmVersion: "10.12.1",
    packageManager: "pnpm@10.12.1",
  });
  assert.match(report, /Node\.js: 24\.19\.0/);
  assert.match(report, /\.node-version: 24\.19\.0/);
  assert.match(report, /pnpm: 10\.12\.1/);
  assert.match(report, /packageManager: pnpm@10\.12\.1/);
});
