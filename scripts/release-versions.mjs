#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CHANNEL_CONFIG } from "./channel-config.mjs";

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STAGING_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-staging\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

export function parseStableVersion(version, label = "version") {
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(`${label} must be a stable semantic version, got "${version}"`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left, "left version");
  const rightParts = parseStableVersion(right, "right version");

  return leftParts.major - rightParts.major || leftParts.minor - rightParts.minor || leftParts.patch - rightParts.patch;
}

export function formatStagingVersion(sourceVersion, sequence, runAttempt) {
  const source = parseStableVersion(sourceVersion, "source version");
  if (!POSITIVE_INTEGER_PATTERN.test(String(sequence)) || !POSITIVE_INTEGER_PATTERN.test(String(runAttempt))) {
    throw new Error("staging sequence and GitHub run attempt must be positive integers");
  }

  return `${source.major}.${source.minor}.${source.patch + 1}-staging.${sequence}.${runAttempt}`;
}

export function parseStagingVersion(version, label = "staging version") {
  const match = STAGING_VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(`${label} must be a staging semantic version, got "${version}"`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    sequence: Number(match[4]),
    attempt: Number(match[5]),
  };
}

function compareVersionParts(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function targetStagingLine(sourceVersion) {
  const source = parseStableVersion(sourceVersion, "source version");
  return { major: source.major, minor: source.minor, patch: source.patch + 1 };
}

export function findLatestStagingVersion(sourceVersion, publishedVersions) {
  if (!Array.isArray(publishedVersions) || publishedVersions.some((version) => typeof version !== "string")) {
    throw new Error("published versions must be an array of strings");
  }

  const target = targetStagingLine(sourceVersion);
  let latest;
  for (const version of publishedVersions) {
    const stagingMatch = STAGING_VERSION_PATTERN.exec(version);
    if (stagingMatch) {
      const parsed = parseStagingVersion(version, "published version");
      const lineComparison = compareVersionParts(parsed, target);
      if (lineComparison > 0) {
        throw new Error(`published staging version ${version} is ahead of the target release line`);
      }
      if (
        lineComparison === 0 &&
        (!latest ||
          parsed.sequence > latest.sequence ||
          (parsed.sequence === latest.sequence && parsed.attempt > latest.attempt))
      ) {
        latest = { ...parsed, version };
      }
      continue;
    }

    const stableMatch = STABLE_VERSION_PATTERN.exec(version);
    if (!stableMatch) {
      throw new Error(`published version ${version} is not a supported stable or staging version`);
    }
    const stable = parseStableVersion(version, "published version");
    if (compareVersionParts(stable, target) >= 0) {
      throw new Error(`published stable version ${version} is not below the target staging release line`);
    }
  }

  return latest?.version;
}

export function resolveNextPublishedStagingVersion({
  sourceVersion,
  publishedVersions,
  latestGitHead,
  releaseGitHead,
  runAttempt,
}) {
  if (!POSITIVE_INTEGER_PATTERN.test(String(runAttempt))) {
    throw new Error("GitHub run attempt must be a positive integer");
  }
  if (typeof releaseGitHead !== "string" || releaseGitHead.length === 0) {
    throw new Error("release git head is required");
  }

  const latestVersion = findLatestStagingVersion(sourceVersion, publishedVersions);
  if (!latestVersion) {
    return formatStagingVersion(sourceVersion, 1, runAttempt);
  }
  if (typeof latestGitHead !== "string" || latestGitHead.length === 0) {
    throw new Error(`published version ${latestVersion} is missing gitHead`);
  }
  if (latestGitHead === releaseGitHead) {
    return latestVersion;
  }

  const latest = parseStagingVersion(latestVersion);
  return formatStagingVersion(sourceVersion, latest.sequence + 1, runAttempt);
}

export function resolveProductionVersion(sourceVersion, tag) {
  parseStableVersion(sourceVersion, "source version");
  const tagMatch = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!tagMatch) {
    throw new Error(`production tag must match vX.Y.Z, got "${tag}"`);
  }

  const tagVersion = tag.slice(1);
  if (tagVersion !== sourceVersion) {
    throw new Error(`production tag version ${tagVersion} does not match source version ${sourceVersion}`);
  }
  if (compareStableVersions(tagVersion, "0.0.2") < 0) {
    throw new Error("the first production release must be version 0.0.2 or newer");
  }

  return tagVersion;
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
  const sourceVersion = arguments_.get("source-version");
  if (!sourceVersion) {
    throw new Error("--source-version is required");
  }

  let output;
  if (channel === "staging") {
    output = {
      package_name: CHANNEL_CONFIG.staging.packageName,
      binary_name: CHANNEL_CONFIG.staging.binName,
      source_version: sourceVersion,
      version: formatStagingVersion(sourceVersion, arguments_.get("sequence"), arguments_.get("run-attempt")),
    };
  } else if (channel === "prod") {
    output = {
      package_name: CHANNEL_CONFIG.prod.packageName,
      binary_name: CHANNEL_CONFIG.prod.binName,
      source_version: sourceVersion,
      version: resolveProductionVersion(sourceVersion, arguments_.get("tag") ?? ""),
    };
  } else {
    throw new Error('--channel must be either "staging" or "prod"');
  }

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    await appendFile(
      outputPath,
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
    console.error(`[release-version] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
