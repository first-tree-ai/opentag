#!/usr/bin/env node

/**
 * Prepares a freshly created worktree.
 *
 * `git worktree add` checks the branch out inside the new directory and then runs the shared
 * `post-checkout` hook there, with the previous HEAD reported as the null object id. That is the one
 * moment where the worktree exists but has no dependencies, so this script installs them and then
 * installs the Git hooks, leaving the worktree ready to commit and push.
 *
 * Git ignores the exit status of `post-checkout`, so failures are reported and never left implicit,
 * but they cannot break the checkout itself.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "./hook-logging.mjs";
import { installGitHooks, readRepositoryRoot } from "./install-git-hooks.mjs";

/** Git reports an all-zero object id when a checkout has no previous HEAD. */
const NULL_OBJECT_ID = /^0+$/;

/** Git environment that belongs to the invoking hook and must not leak into nested commands. */
const INHERITED_GIT_VARIABLES = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_REFLOG_ACTION",
];

/**
 * @param argv hook arguments: `<previous HEAD> <new HEAD> <branch checkout flag>`, or `--force`
 *             when a developer runs the bootstrap by hand.
 */
export function classifyCheckout({ argv, env }) {
  if (argv.includes("--force")) {
    return { bootstrap: true, reason: "forced by --force" };
  }
  if (env.OPENTAG_SKIP_WORKTREE_BOOTSTRAP === "1") {
    return { bootstrap: false, reason: "OPENTAG_SKIP_WORKTREE_BOOTSTRAP=1" };
  }
  if (env.CI) {
    return { bootstrap: false, reason: "CI environment" };
  }

  const [previousHead, , branchCheckout] = argv;
  if (branchCheckout !== "1") {
    return { bootstrap: false, reason: "file checkout" };
  }
  if (!previousHead || !NULL_OBJECT_ID.test(previousHead)) {
    return { bootstrap: false, reason: "branch switch in an existing worktree" };
  }
  return { bootstrap: true, reason: "checkout without a previous HEAD" };
}

export function childEnvironment(env) {
  const childEnv = { ...env };
  for (const variable of INHERITED_GIT_VARIABLES) {
    delete childEnv[variable];
  }
  return childEnv;
}

function installDependencies({ repositoryRoot, env, logger }) {
  logger.info(`installing dependencies in ${repositoryRoot}`);
  const result = spawnSync("pnpm", ["install"], {
    cwd: repositoryRoot,
    env: childEnvironment(env),
    stdio: "inherit",
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error("pnpm is not on PATH; run `corepack enable` and then `pnpm install` in this worktree");
    }
    throw new Error(`pnpm install failed to start: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`pnpm install exited with status ${result.status ?? "unknown"}`);
  }
}

export async function bootstrapWorktree({ argv = [], cwd = process.cwd(), env = process.env, logger } = {}) {
  const log = logger ?? createLogger({ scope: "worktree-bootstrap", env });

  const classification = classifyCheckout({ argv, env });
  if (!classification.bootstrap) {
    log.debug(`no bootstrap needed (${classification.reason})`);
    return { bootstrapped: false, reason: classification.reason };
  }

  const repositoryRoot = readRepositoryRoot(cwd);
  if (!repositoryRoot) {
    log.warn("skipping bootstrap (not a Git repository)");
    return { bootstrapped: false, reason: "not a Git repository" };
  }

  log.info(`preparing worktree ${repositoryRoot} (${classification.reason})`);
  installDependencies({ repositoryRoot, env, logger: log });
  // `pnpm install` already runs the `prepare` lifecycle, but a developer may have disabled install
  // scripts, and the hooks are the whole point of the bootstrap.
  await installGitHooks({ cwd: repositoryRoot, env: childEnvironment(env), logger: log });

  log.info("worktree is ready");
  return { bootstrapped: true, repositoryRoot };
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  bootstrapWorktree({ argv: process.argv.slice(2) }).catch((error) => {
    console.error(`[worktree-bootstrap] ${error instanceof Error ? error.message : String(error)}`);
    console.error("[worktree-bootstrap] run `pnpm install` in this worktree to finish the setup");
  });
}
