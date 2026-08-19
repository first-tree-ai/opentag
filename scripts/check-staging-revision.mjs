#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function assertCurrentStagingRevision(releaseGitHead, mainGitHead) {
  if (releaseGitHead !== mainGitHead) {
    throw new Error(`staging revision ${releaseGitHead} is stale; current origin/main is ${mainGitHead}`);
  }
}

function runGit(arguments_) {
  const result = spawnSync("git", arguments_, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr.trim() || `exit status ${result.status}`}`);
  }
  return result.stdout.trim();
}

function main() {
  runGit(["fetch", "origin", "main:refs/remotes/origin/main"]);
  const releaseGitHead = runGit(["rev-parse", "HEAD"]);
  const mainGitHead = runGit(["rev-parse", "refs/remotes/origin/main"]);
  assertCurrentStagingRevision(releaseGitHead, mainGitHead);
  console.log(`Staging revision ${releaseGitHead} is current origin/main`);
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  try {
    main();
  } catch (error) {
    console.error(`[staging-revision] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
