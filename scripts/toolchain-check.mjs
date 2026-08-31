#!/usr/bin/env node

/**
 * Verifies the versions that identify a reproducible repository run.
 *
 * The repository pins an exact development Node.js version in `.node-version`, permits a small
 * set of Node.js release lines through `engines.node`, and pins pnpm through `packageManager`.
 * This check intentionally uses only Node.js built-ins so it can run before dependencies are
 * installed and can be used as an early CI failure.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function normalizeVersion(value, label) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`${label} must be an exact semantic version (x.y.z), received "${value}"`);
  }
  return normalized;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function satisfiesCaret(version, range) {
  const minimum = normalizeVersion(range.slice(1), "engine range");
  const [major] = minimum.split(".").map(Number);
  const upperBound = `${major + 1}.0.0`;
  return compareVersions(version, minimum) >= 0 && compareVersions(version, upperBound) < 0;
}

/** Supports the pinned repository form: `^x.y.z || ^x.y.z`. */
export function satisfiesEngineRange(versionValue, rangeValue) {
  let version;
  try {
    version = normalizeVersion(versionValue, "Node.js version");
  } catch {
    return false;
  }
  const ranges = String(rangeValue ?? "")
    .split("||")
    .map((range) => range.trim())
    .filter(Boolean);
  return ranges.some((range) => range.startsWith("^") && satisfiesCaret(version, range));
}

export function parsePackageManager(value) {
  const match = String(value ?? "")
    .trim()
    .match(/^pnpm@(\d+\.\d+\.\d+)$/);
  if (!match) {
    throw new Error(`packageManager must pin an exact pnpm version, received "${value}"`);
  }
  return { name: "pnpm", version: match[1] };
}

export function validateToolchain({ nodeVersion, nodeVersionFile, nodeEngine, pnpmVersion, packageManager }) {
  const errors = [];
  const normalizedNode = (() => {
    try {
      return normalizeVersion(nodeVersion, "Node.js version");
    } catch (error) {
      errors.push(error.message);
      return null;
    }
  })();

  if (normalizedNode && !satisfiesEngineRange(normalizedNode, nodeEngine)) {
    errors.push(`Node.js ${normalizedNode} does not satisfy engines.node (${nodeEngine})`);
  }

  let expectedNode;
  try {
    expectedNode = normalizeVersion(nodeVersionFile, ".node-version");
  } catch (error) {
    errors.push(error.message);
  }
  if (normalizedNode && expectedNode && normalizedNode !== expectedNode) {
    errors.push(`Node.js ${normalizedNode} does not match .node-version ${expectedNode}`);
  }

  let expectedPnpm;
  try {
    expectedPnpm = parsePackageManager(packageManager).version;
  } catch (error) {
    errors.push(error.message);
  }
  const normalizedPnpm = pnpmVersion == null ? null : String(pnpmVersion).trim().replace(/^v/, "");
  if (expectedPnpm && normalizedPnpm !== expectedPnpm) {
    errors.push(`pnpm ${normalizedPnpm || "<unavailable>"} does not match packageManager pnpm@${expectedPnpm}`);
  }

  return errors;
}

export function formatToolchainReport({ nodeVersion, nodeVersionFile, nodeEngine, pnpmVersion, packageManager }) {
  return [
    `Node.js: ${String(nodeVersion).trim()} (engines.node: ${nodeEngine}; .node-version: ${String(nodeVersionFile).trim()})`,
    `pnpm: ${String(pnpmVersion ?? "<unavailable>").trim()} (packageManager: ${packageManager})`,
  ].join("\n");
}

function readManifest() {
  return JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
}

function readPnpmVersion() {
  const result = spawnSync("pnpm", ["--version"], { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

export function runToolchainCheck({ nodeVersion = process.versions.node, pnpmVersion = readPnpmVersion() } = {}) {
  const manifest = readManifest();
  const nodeVersionFile = readFileSync(resolve(repositoryRoot, ".node-version"), "utf8");
  const report = {
    nodeEngine: manifest.engines?.node,
    nodeVersion,
    nodeVersionFile,
    packageManager: manifest.packageManager,
    pnpmVersion,
  };
  const errors = validateToolchain(report);
  process.stdout.write(`${formatToolchainReport(report)}\n`);
  if (errors.length > 0) {
    process.stderr.write(`[toolchain-check] ${errors.join("; ")}\n`);
    return false;
  }
  return true;
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  process.exitCode = runToolchainCheck() ? 0 : 1;
}
