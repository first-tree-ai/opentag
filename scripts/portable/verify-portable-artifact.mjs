#!/usr/bin/env node

/**
 * Verifies one built portable tarball against the release manifest that will be published beside it.
 *
 * Structural checks run for every platform. The runtime check only runs when the artifact targets the
 * host, because a foreign platform's embedded Node.js binary cannot be executed here.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ENTRY, hostPlatform, MANIFEST_SCHEMA_VERSION, parsePlatform } from "./build-portable.mjs";
import { runContextTreeRuntimeProbe, verifyPortableDependencyGraph } from "./runtime-dependencies.mjs";

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

function tarExtractArgs(tarball, dest) {
  const version = spawnSync("tar", ["--version"], { encoding: "utf8" });
  const gnu = version.status === 0 && /GNU tar/i.test(version.stdout);
  return gnu ? ["--warning=no-unknown-keyword", "-xzf", tarball, "-C", dest] : ["-xzf", tarball, "-C", dest];
}

function parseArgs(argv) {
  const options = { manifest: null, platform: null, tarball: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--manifest") options.manifest = next();
    else if (arg === "--platform") options.platform = next();
    else if (arg === "--tarball") options.tarball = next();
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/portable/verify-portable-artifact.mjs --manifest <manifest.json> --platform <platform> --tarball <path>",
      );
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  if (!options.manifest || !options.platform || !options.tarball) {
    fail("--manifest, --platform, and --tarball are required");
  }
  parsePlatform(options.platform);
  return options;
}

function verify(options) {
  const manifest = readJson(options.manifest);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(`manifest schemaVersion must be ${MANIFEST_SCHEMA_VERSION}, got ${manifest.schemaVersion}`);
  }
  const asset = manifest.assets?.find((candidate) => candidate.platform === options.platform);
  if (!asset) fail(`manifest has no asset for ${options.platform}`);

  const actualSha = createHash("sha256").update(readFileSync(options.tarball)).digest("hex");
  if (actualSha !== asset.sha256) fail(`tarball sha256 mismatch: expected ${asset.sha256}, got ${actualSha}`);

  const root = mkdtempSync(join(tmpdir(), "opentag-portable-verify-"));
  try {
    const artifactDir = join(root, "artifact");
    mkdirSync(artifactDir, { recursive: true });
    run("tar", tarExtractArgs(options.tarball, artifactDir));

    for (const relativePath of [
      "VERSION",
      "INSTALL.json",
      "node/bin/node",
      "app/package.json",
      APP_ENTRY,
      `bin/${manifest.binName}`,
    ]) {
      if (!existsSync(join(artifactDir, relativePath))) fail(`extracted artifact is missing ${relativePath}`);
    }

    const install = readJson(join(artifactDir, "INSTALL.json"));
    if (install.version !== manifest.version) fail("INSTALL.json version does not match the manifest");
    if (install.packageName !== manifest.packageName) fail("INSTALL.json packageName does not match the manifest");
    if (install.binName !== manifest.binName) fail("INSTALL.json binName does not match the manifest");
    if (install.platform !== options.platform) fail("INSTALL.json platform does not match the verified artifact");
    if (install.installMode !== "portable") fail("INSTALL.json does not describe a portable install");
    if (install.appEntry !== APP_ENTRY) fail(`INSTALL.json appEntry must be ${APP_ENTRY}`);

    const appPackage = readJson(join(artifactDir, "app", "package.json"));
    if (appPackage.name !== manifest.packageName) fail("app/package.json name does not match the manifest");
    if (appPackage.version !== manifest.version) fail("app/package.json version does not match the manifest");

    // The embedded dependency graph must be closed and complete for every platform: the payload
    // layout is platform-independent, so a broken graph fails the artifact everywhere.
    verifyPortableDependencyGraph(join(artifactDir, "app"));

    if (options.platform !== hostPlatform()) {
      console.log(`[portable verify] ${options.platform} structure verified; skipping the runtime check on this host`);
      return;
    }

    verifyHostRuntime({ artifactDir, manifest, platform: options.platform, root });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

/**
 * Host-stage runtime checks execute the artifact's own binaries with isolated homes, so a payload
 * that only passes structural checks still fails verification on the platform it runs on. The
 * embedded Context Tree CLI is exercised through the artifact's own Node.js runtime.
 */
function verifyHostRuntime({ artifactDir, manifest, platform, root }) {
  const versionOutput = run(join(artifactDir, "bin", manifest.binName), ["--version"], {
    env: { ...process.env, OPENTAG_HOME: join(root, "home") },
  }).stdout;
  if (!versionOutput.includes(manifest.version)) {
    fail(`expected --version output to include ${manifest.version}, got ${versionOutput.trim()}`);
  }
  runContextTreeRuntimeProbe({
    probeOpenTag: true,
    appDir: join(artifactDir, "app"),
    homeDir: join(root, "context-tree-home"),
    nodePath: join(artifactDir, "node", "bin", "node"),
  });
  console.log(`[portable verify] ${platform} verified and runnable (${manifest.version})`);
}

try {
  verify(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`[portable verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
