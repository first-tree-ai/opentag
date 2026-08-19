#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  if (result.status !== (options.expectedStatus ?? 0)) {
    throw new Error(
      `${command} ${arguments_.join(" ")} exited with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function assertReleaseManifest(manifest, { channel, expectedName, expectedVersion, expectedBinary }) {
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    throw new Error(
      `packed identity mismatch: expected ${expectedName}@${expectedVersion}, got ${manifest.name}@${manifest.version}`,
    );
  }
  if (manifest.bin?.[expectedBinary] !== "./dist/cli/index.mjs" || Object.keys(manifest.bin ?? {}).length !== 1) {
    throw new Error(`packed binary must contain only ${expectedBinary} -> ./dist/cli/index.mjs`);
  }
  if (channel === "source" && manifest.private !== true) {
    throw new Error("source tarball must retain private: true");
  }
  if (channel !== "source" && "private" in manifest) {
    throw new Error("release tarball must not contain the private field");
  }
  if (manifest.license !== "Apache-2.0") {
    throw new Error('packed license must be "Apache-2.0"');
  }
  if (manifest.repository?.url !== "git+https://github.com/first-tree-ai/opentag.git") {
    throw new Error("packed repository metadata must point to first-tree-ai/opentag");
  }

  const dependencyFields =
    channel === "source"
      ? ["dependencies", "optionalDependencies", "peerDependencies"]
      : ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  for (const dependencyField of dependencyFields) {
    const internalDependency = Object.keys(manifest[dependencyField] ?? {}).find((name) =>
      name.startsWith("@opentag/"),
    );
    if (internalDependency) {
      throw new Error(`packed manifest exposes private runtime dependency ${internalDependency}`);
    }
  }
}

function bundledCoordinates(sourceMaps) {
  const coordinates = new Set();
  for (const sourceMap of sourceMaps) {
    for (const source of sourceMap.sources ?? []) {
      const match = source.match(/node_modules\/\.pnpm\/(.+?)\/node_modules\/((?:@[^/]+\/)?[^/]+)/);
      if (!match) {
        continue;
      }
      const storeLocator = match[1];
      const packageName = match[2];
      const versionSeparator = storeLocator.lastIndexOf("@");
      if (versionSeparator <= 0) {
        throw new Error(`cannot parse bundled dependency locator ${storeLocator}`);
      }
      const version = storeLocator.slice(versionSeparator + 1).split("_")[0];
      coordinates.add(`${packageName}@${version}`);
    }
  }
  return [...coordinates].sort();
}

function noticeCoordinates(notices) {
  return [...notices.matchAll(/^## (.+@[^\s]+)$/gm)].map((match) => match[1]).sort();
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument sequence near "${key ?? ""}"`);
    }
    values.set(key.slice(2), value);
  }
  return values;
}

export async function runCliPackSmoke({ channel, expectedName, expectedVersion, expectedBinary }) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "opentag-cli-pack-"));
  try {
    const pack = run("npm", ["pack", "--json", "--pack-destination", temporaryRoot], { cwd: resolve("apps/cli") });
    const packResult = JSON.parse(pack.stdout);
    const tarballName = packResult[0]?.filename;
    if (!tarballName) {
      throw new Error("npm pack did not report a tarball filename");
    }
    const packedPaths = (packResult[0].files ?? []).map((file) => file.path);
    for (const requiredPath of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES", "dist/cli/index.mjs"]) {
      if (!packedPaths.includes(requiredPath)) {
        throw new Error(`npm tarball is missing required path ${requiredPath}`);
      }
    }
    if (packedPaths.some((path) => path.endsWith(".tsbuildinfo"))) {
      throw new Error("npm tarball must not include TypeScript build metadata");
    }
    const tarballPath = join(temporaryRoot, tarballName);
    const notices = run("tar", ["-xOf", tarballPath, "package/THIRD_PARTY_NOTICES"]).stdout;
    const sourceMaps = packedPaths
      .filter((path) => path.endsWith(".map"))
      .map((path) => JSON.parse(run("tar", ["-xOf", tarballPath, `package/${path}`]).stdout));
    const bundled = bundledCoordinates(sourceMaps);
    const attributed = noticeCoordinates(notices);
    if (JSON.stringify(attributed) !== JSON.stringify(bundled)) {
      throw new Error(
        `third-party notices do not match bundled dependencies: expected ${bundled.join(", ")}, got ${attributed.join(", ")}`,
      );
    }
    if (!notices.includes("Permission is hereby granted") || !notices.includes("Copyright")) {
      throw new Error("third-party notices must include complete copyright and license text");
    }
    const packedManifestResult = run("tar", ["-xOf", tarballPath, "package/package.json"]);
    const packedManifest = JSON.parse(packedManifestResult.stdout);
    assertReleaseManifest(packedManifest, { channel, expectedName, expectedVersion, expectedBinary });

    const consumer = join(temporaryRoot, "consumer");
    await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), '{"name":"consumer","private":true}\n');
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], { cwd: consumer });

    const binaryPath = join(consumer, "node_modules", ".bin", expectedBinary);
    const version = run(binaryPath, ["--version"]);
    if (version.stdout.trim() !== expectedVersion) {
      throw new Error(`CLI version mismatch: expected ${expectedVersion}, got ${version.stdout.trim()}`);
    }
    const help = run(binaryPath, ["--help"]);
    if (!help.stdout.includes(`Usage: ${expectedBinary}`)) {
      throw new Error(`CLI help does not use expected binary name ${expectedBinary}`);
    }
    const agentHelp = run(binaryPath, ["agent", "--help"]);
    if (!agentHelp.stdout.includes("create") || !agentHelp.stdout.includes("delete")) {
      throw new Error("CLI Agent command group is missing from the packed artifact");
    }
    const daemonHelp = run(binaryPath, ["daemon", "--help"]);
    for (const command of ["install", "start", "stop", "restart", "status", "uninstall"]) {
      if (!daemonHelp.stdout.includes(command)) {
        throw new Error(`CLI daemon command group is missing ${command}`);
      }
    }
    if (/\bservice-run\b/u.test(daemonHelp.stdout) || /^\s+run\b/mu.test(daemonHelp.stdout)) {
      throw new Error("CLI daemon help exposes an internal or removed runtime command");
    }
    const loginHelp = run(binaryPath, ["login", "--help"]);
    if (!loginHelp.stdout.includes("--no-start")) {
      throw new Error("CLI login help is missing --no-start");
    }
    const doctor = run(binaryPath, ["doctor", "--server-url", "http://127.0.0.1:1"], { expectedStatus: 1 });
    if (!doctor.stderr.includes("Network error:")) {
      throw new Error("CLI doctor smoke did not report the expected network failure");
    }

    const installedManifest = JSON.parse(
      await readFile(join(consumer, "node_modules", expectedName, "package.json"), "utf8"),
    );
    assertReleaseManifest(installedManifest, { channel, expectedName, expectedVersion, expectedBinary });
    console.log(`Verified ${expectedName}@${expectedVersion} through ${expectedBinary}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const channel = arguments_.get("channel");
  const expectedName = arguments_.get("name");
  const expectedVersion = arguments_.get("version");
  const expectedBinary = arguments_.get("binary");
  if (!channel || !expectedName || !expectedVersion || !expectedBinary) {
    throw new Error("--channel, --name, --version, and --binary are required");
  }
  if (!["source", "staging", "prod"].includes(channel)) {
    throw new Error('--channel must be "source", "staging", or "prod"');
  }

  await runCliPackSmoke({ channel, expectedName, expectedVersion, expectedBinary });
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main().catch((error) => {
    console.error(`[cli-pack-smoke] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
