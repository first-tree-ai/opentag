#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareStableVersions, parseStableVersion } from "./release-versions.mjs";

const SOURCE_PACKAGE_NAME = "open-tag";
const STAGING_PACKAGE_NAME = "open-tag-staging";
const EXPECTED_REPOSITORY_URL = "git+https://github.com/first-tree-ai/opentag.git";

export async function prepareCliRelease({ channel, version, manifestPath = "apps/cli/package.json" }) {
  const resolvedManifestPath = resolve(manifestPath);
  const manifest = JSON.parse(await readFile(resolvedManifestPath, "utf8"));

  if (manifest.name !== SOURCE_PACKAGE_NAME) {
    throw new Error(`source package name must be ${SOURCE_PACKAGE_NAME}, got "${manifest.name ?? ""}"`);
  }
  if (manifest.private !== true) {
    throw new Error("source package must have private: true");
  }
  const source = parseStableVersion(manifest.version, "source version");
  if (manifest.license !== "Apache-2.0") {
    throw new Error('source package license must be "Apache-2.0"');
  }
  if (manifest.repository?.url !== EXPECTED_REPOSITORY_URL) {
    throw new Error(`source package repository must be ${EXPECTED_REPOSITORY_URL}`);
  }
  for (const dependencyField of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const internalDependency = Object.keys(manifest[dependencyField] ?? {}).find((name) =>
      name.startsWith("@opentag/"),
    );
    if (internalDependency) {
      throw new Error(`source package exposes private runtime dependency ${internalDependency}`);
    }
  }

  if (channel === "staging") {
    const expectedPrefix = `${source.major}.${source.minor}.${source.patch + 1}-staging.`;
    if (!new RegExp(`^${expectedPrefix.replaceAll(".", "\\.")}(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$`).test(version)) {
      throw new Error(`staging version must match ${expectedPrefix}<run>.<attempt>, got "${version}"`);
    }
    manifest.name = STAGING_PACKAGE_NAME;
    manifest.bin = { "opentag-staging": "./dist/cli/index.mjs" };
  } else if (channel === "prod") {
    parseStableVersion(version, "production version");
    if (version !== manifest.version) {
      throw new Error(`production version ${version} must match source version ${manifest.version}`);
    }
    if (compareStableVersions(version, "0.0.2") < 0) {
      throw new Error("the first production release must be version 0.0.2 or newer");
    }
    manifest.name = SOURCE_PACKAGE_NAME;
    manifest.bin = { opentag: "./dist/cli/index.mjs" };
  } else {
    throw new Error('channel must be either "staging" or "prod"');
  }

  manifest.version = version;
  delete manifest.private;
  for (const dependencyName of Object.keys(manifest.devDependencies ?? {})) {
    if (dependencyName.startsWith("@opentag/")) {
      delete manifest.devDependencies[dependencyName];
    }
  }
  await writeFile(resolvedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
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

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const channel = arguments_.get("channel");
  const version = arguments_.get("version");
  if (!channel || !version) {
    throw new Error("--channel and --version are required");
  }

  const manifest = await prepareCliRelease({
    channel,
    version,
    manifestPath: arguments_.get("manifest") ?? "apps/cli/package.json",
  });
  console.log(`Prepared ${manifest.name}@${manifest.version}`);
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main().catch((error) => {
    console.error(`[release-preparation] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
