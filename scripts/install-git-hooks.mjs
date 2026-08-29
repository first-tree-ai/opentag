#!/usr/bin/env node

/**
 * Installs the local Git hooks.
 *
 * Two mechanisms share one hooks directory:
 *
 * - lefthook owns the quality gates declared in `lefthook.yml` (`pre-commit`, `pre-push`).
 * - This script owns `scripts/git-hooks/*`, hooks that must run before `node_modules` exists and
 *   therefore cannot go through the lefthook binary. They are written last so they win.
 *
 * Git keeps a single hooks directory per clone and shares it with every linked worktree, so one
 * installation covers all of them. The root `prepare` lifecycle runs this on every `pnpm install`.
 */

import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLogger } from "./hook-logging.mjs";

const require = createRequire(import.meta.url);
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));

/** Marker that identifies a hook this script owns and may overwrite without warning. */
export const MANAGED_HOOK_MARKER = "opentag-managed-hook";

/** Hooks copied verbatim from `scripts/git-hooks/` into the Git hooks directory. */
export const MANAGED_HOOKS = ["post-checkout"];

export function classifyInstallation({ env }) {
  if (env.OPENTAG_SKIP_GIT_HOOKS === "1") {
    return { install: false, reason: "OPENTAG_SKIP_GIT_HOOKS=1" };
  }
  if (env.CI) {
    return { install: false, reason: "CI environment" };
  }
  return { install: true, reason: "local checkout" };
}

/**
 * `core.hooksPath` wins when set, and Git resolves a relative value against the working tree root.
 * Otherwise `git rev-parse --git-path hooks` already points at the directory shared by all worktrees.
 */
export function resolveHooksDirectory({ repositoryRoot, configuredHooksPath, gitHooksPath }) {
  const candidate = configuredHooksPath?.trim() || gitHooksPath?.trim();
  if (!candidate) {
    throw new Error("unable to determine the Git hooks directory");
  }
  return isAbsolute(candidate) ? candidate : resolve(repositoryRoot, candidate);
}

function runGit(arguments_, { cwd }) {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8" });
  if (result.error) {
    // A container image can install dependencies without shipping Git; that is not a failure here.
    if (result.error.code === "ENOENT") {
      return { status: null, stdout: "", stderr: "git is not on PATH" };
    }
    throw new Error(`git ${arguments_.join(" ")} failed to start: ${result.error.message}`, { cause: result.error });
  }
  return { status: result.status, stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "" };
}

export function readRepositoryRoot(cwd) {
  const result = runGit(["rev-parse", "--show-toplevel"], { cwd });
  return result.status === 0 && result.stdout ? result.stdout : undefined;
}

function readConfiguredHooksPath(repositoryRoot) {
  const result = runGit(["config", "--get", "core.hooksPath"], { cwd: repositoryRoot });
  return result.status === 0 ? result.stdout : "";
}

function runLefthookInstall({ repositoryRoot, logger }) {
  let lefthookEntry;
  try {
    lefthookEntry = require.resolve("lefthook/bin/index.js");
  } catch (error) {
    throw new Error("lefthook is not installed; run `pnpm install` first", { cause: error });
  }

  logger.debug(`running lefthook install from ${lefthookEntry}`);
  const result = spawnSync(process.execPath, [lefthookEntry, "install"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`lefthook install failed to start: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`lefthook install exited with status ${result.status ?? "unknown"}`);
  }
}

async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Writes one managed hook, preserving a foreign hook of the same name as `<hook>.old` the way
 * lefthook does, so no unrelated automation is lost silently.
 */
export async function installManagedHook({ hooksDirectory, name, source, logger }) {
  const target = join(hooksDirectory, name);
  const existing = await readIfPresent(target);

  if (existing === source) {
    logger.debug(`${name} is already up to date`);
    await chmod(target, 0o755);
    return "unchanged";
  }

  if (existing !== undefined && !existing.includes(MANAGED_HOOK_MARKER)) {
    const backup = `${target}.old`;
    await rename(target, backup);
    logger.warn(`kept the previous ${name} hook as ${backup}`);
  }

  await writeFile(target, source, "utf8");
  await chmod(target, 0o755);
  return existing === undefined ? "created" : "updated";
}

export async function installGitHooks({ cwd = process.cwd(), env = process.env, logger } = {}) {
  const log = logger ?? createLogger({ scope: "git-hooks", env });

  const classification = classifyInstallation({ env });
  if (!classification.install) {
    log.info(`skipping hook installation (${classification.reason})`);
    return { installed: false, reason: classification.reason };
  }

  const repositoryRoot = readRepositoryRoot(cwd);
  if (!repositoryRoot) {
    log.info("skipping hook installation (not a Git repository)");
    return { installed: false, reason: "not a Git repository" };
  }

  runLefthookInstall({ repositoryRoot, logger: log });

  const hooksDirectory = resolveHooksDirectory({
    repositoryRoot,
    configuredHooksPath: readConfiguredHooksPath(repositoryRoot),
    gitHooksPath: runGit(["rev-parse", "--git-path", "hooks"], { cwd: repositoryRoot }).stdout,
  });
  log.debug(`hooks directory: ${hooksDirectory}`);
  await mkdir(hooksDirectory, { recursive: true });

  const outcomes = {};
  for (const name of MANAGED_HOOKS) {
    const source = await readFile(join(scriptsDirectory, "git-hooks", name), "utf8");
    outcomes[name] = await installManagedHook({ hooksDirectory, name, source, logger: log });
  }

  log.info(
    `hooks ready in ${hooksDirectory} (lefthook: pre-commit, pre-push; managed: ${MANAGED_HOOKS.map((name) => `${name} ${outcomes[name]}`).join(", ")})`,
  );
  return { installed: true, hooksDirectory, outcomes };
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  installGitHooks().catch((error) => {
    console.error(`[git-hooks] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
