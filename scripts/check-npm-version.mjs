#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function classifyRegistryLookup({ status, stdout, stderr, expectedGitHead }) {
  if (status === 0) {
    let metadata;
    try {
      metadata = JSON.parse(stdout);
    } catch (error) {
      throw new Error("npm registry returned invalid JSON", { cause: error });
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
  const packageName = arguments_.get("package");
  const version = arguments_.get("version");
  const gitHead = arguments_.get("git-head");
  if (!packageName || !version || !gitHead) {
    throw new Error("--package, --version, and --git-head are required");
  }

  const lookup = spawnSync("npm", ["view", `${packageName}@${version}`, "--json"], {
    encoding: "utf8",
  });
  const result = classifyRegistryLookup({
    status: lookup.status,
    stdout: lookup.stdout,
    stderr: lookup.stderr,
    expectedGitHead: gitHead,
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
