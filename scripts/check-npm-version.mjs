#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export function classifyRegistryLookup({ status, stdout, stderr, expectedGitHead, expectedVersion }) {
  if (status === 0) {
    let metadata;
    try {
      metadata = JSON.parse(stdout);
    } catch (error) {
      throw new Error("npm registry returned invalid JSON", { cause: error });
    }
    if (expectedVersion !== undefined && metadata.version !== expectedVersion) {
      throw new Error(`published version is "${metadata.version ?? "missing"}", expected "${expectedVersion}"`);
    }
    if (metadata.gitHead !== expectedGitHead) {
      throw new Error(
        `published version has gitHead "${metadata.gitHead ?? "missing"}", expected "${expectedGitHead}"`,
      );
    }
    return { publish: false };
  }

  if (/\bE404\b/.test(stderr)) {
    return { publish: true };
  }
  throw new Error(`npm registry lookup failed: ${stderr.trim() || `exit status ${status}`}`);
}

export const NPM_PUBLISH_WAIT_DEADLINE_MS = 30 * 60 * 1000;
export const NPM_PUBLISH_WAIT_INTERVAL_MS = 15_000;

export async function verifyPublishedCoordinate({
  packageName,
  version,
  expectedGitHead,
  npmView = (args) => spawnSync("npm", ["view", ...args], { encoding: "utf8", timeout: 60_000 }),
  sleep = delay,
  deadlineMs = NPM_PUBLISH_WAIT_DEADLINE_MS,
  intervalMs = NPM_PUBLISH_WAIT_INTERVAL_MS,
  now = Date.now,
}) {
  const deadline = now() + deadlineMs;
  while (true) {
    const lookup = npmView([`${packageName}@${version}`, "--json"]);
    const result = classifyRegistryLookup({
      status: lookup.status,
      stdout: lookup.stdout ?? "",
      stderr: lookup.stderr ?? "",
      expectedGitHead,
      expectedVersion: version,
    });
    if (!result.publish) {
      return result;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`npm coordinate ${packageName}@${version} is still absent (E404) after waiting ${deadlineMs}ms`);
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

export function parseCheckNpmArguments(arguments_) {
  const values = new Map();
  let requirePublished = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const key = arguments_[index];
    if (key === "--require-published") {
      requirePublished = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument sequence near "${key ?? ""}"`);
    }
    values.set(key.slice(2), value);
    index += 1;
  }
  const packageName = values.get("package");
  const version = values.get("version");
  const gitHead = values.get("git-head");
  if (!packageName || !version || !gitHead) {
    throw new Error("--package, --version, and --git-head are required");
  }
  return { packageName, version, gitHead, requirePublished };
}

async function main() {
  const { packageName, version, gitHead, requirePublished } = parseCheckNpmArguments(process.argv.slice(2));

  if (requirePublished) {
    await verifyPublishedCoordinate({ packageName, version, expectedGitHead: gitHead });
    console.log(`${packageName}@${version} is verified in npm at ${gitHead}`);
    return;
  }

  const lookup = spawnSync("npm", ["view", `${packageName}@${version}`, "--json"], {
    encoding: "utf8",
  });
  const result = classifyRegistryLookup({
    status: lookup.status,
    stdout: lookup.stdout,
    stderr: lookup.stderr,
    expectedGitHead: gitHead,
    expectedVersion: version,
  });

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `publish=${result.publish}\n`);
  }
  console.log(
    result.publish
      ? `${packageName}@${version} is available for publication`
      : `${packageName}@${version} already exists at ${gitHead}; publication is idempotently skipped`,
  );
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main().catch((error) => {
    console.error(`[npm-registry-check] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
