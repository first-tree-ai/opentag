#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CHANNEL_CONFIG } from "./channel-config.mjs";
import { findLatestStagingVersion, resolveNextPublishedStagingVersion } from "./release-versions.mjs";

export function classifyPublishedVersionsLookup({ status, stdout, stderr }) {
  if (status === 0) {
    let value;
    try {
      value = JSON.parse(stdout);
    } catch (error) {
      throw new Error("npm registry returned invalid versions JSON", { cause: error });
    }
    const versions = typeof value === "string" ? [value] : value;
    if (!Array.isArray(versions) || versions.some((version) => typeof version !== "string")) {
      throw new Error("npm registry returned an invalid versions list");
    }
    return versions;
  }
  if (/\bE404\b/.test(stderr)) {
    return [];
  }
  throw new Error(`npm registry versions lookup failed: ${stderr.trim() || `exit status ${status}`}`);
}

export function classifyPublishedMetadataLookup({ status, stdout, stderr, expectedVersion }) {
  if (status !== 0) {
    throw new Error(`npm registry metadata lookup failed: ${stderr.trim() || `exit status ${status}`}`);
  }

  let metadata;
  try {
    metadata = JSON.parse(stdout);
  } catch (error) {
    throw new Error("npm registry returned invalid metadata JSON", { cause: error });
  }
  if (metadata.version !== expectedVersion) {
    throw new Error(`npm registry returned version "${metadata.version ?? "missing"}", expected "${expectedVersion}"`);
  }
  if (typeof metadata.gitHead !== "string" || metadata.gitHead.length === 0) {
    throw new Error(`published version ${expectedVersion} is missing gitHead`);
  }
  return metadata;
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
  const sourceVersion = arguments_.get("source-version");
  const releaseGitHead = arguments_.get("git-head");
  const runAttempt = arguments_.get("run-attempt");
  if (!sourceVersion || !releaseGitHead || !runAttempt) {
    throw new Error("--source-version, --git-head, and --run-attempt are required");
  }

  const packageName = CHANNEL_CONFIG.staging.packageName;
  const versionsLookup = spawnSync("npm", ["view", packageName, "versions", "--json"], { encoding: "utf8" });
  const publishedVersions = classifyPublishedVersionsLookup({
    status: versionsLookup.status,
    stdout: versionsLookup.stdout,
    stderr: versionsLookup.stderr,
  });
  const latestVersion = findLatestStagingVersion(sourceVersion, publishedVersions);
  let latestGitHead;
  if (latestVersion) {
    const metadataLookup = spawnSync(
      "npm",
      ["view", `${packageName}@${latestVersion}`, "version", "gitHead", "--json"],
      { encoding: "utf8" },
    );
    latestGitHead = classifyPublishedMetadataLookup({
      status: metadataLookup.status,
      stdout: metadataLookup.stdout,
      stderr: metadataLookup.stderr,
      expectedVersion: latestVersion,
    }).gitHead;
  }

  const version = resolveNextPublishedStagingVersion({
    sourceVersion,
    publishedVersions,
    latestGitHead,
    releaseGitHead,
    runAttempt,
  });
  const output = {
    package_name: packageName,
    binary_name: CHANNEL_CONFIG.staging.binName,
    source_version: sourceVersion,
    version,
  };

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `${Object.entries(output)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
    );
  }
  console.log(JSON.stringify(output));
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main().catch((error) => {
    console.error(`[staging-release] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
