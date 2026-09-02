import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { sep } from "node:path";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import type { ActiveVersionManager } from "./install-locations.js";
import { protectedRoots, type ReadLink, resolveOutsideProtectedRoots } from "./protected-paths.js";

/**
 * Unique marker that brackets the canonical dir list in the probe output so we
 * can isolate it from any prompt / rc-file noise the interactive login shell
 * prints. Chosen to be vanishingly unlikely to appear in a real PATH entry.
 */
export const LOGIN_SHELL_PATH_DELIM = "__OT_SHELL_PATH__";

/**
 * Brackets a second section carrying the version-manager variables the login
 * shell exported. Reading an environment variable costs no filesystem access at
 * all, which is why these can be captured here while a symlink target cannot.
 */
export const LOGIN_SHELL_ENV_DELIM = "__OT_SHELL_ENV__";

export const LOGIN_SHELL_PROBE_TIMEOUT_MS = 4_000;
export const LOGIN_SHELL_PROBE_KILL_SIGNAL = "SIGKILL" as const;
export const LOGIN_SHELL_PROBE_MAX_ATTEMPTS = 3;
export const LOGIN_SHELL_PROBE_MAX_STDOUT_BYTES = 64 * 1024;

/** The version-manager environment the login shell reported, if it reported any. */
export type ProbedShellEnv = ActiveVersionManager;

/** Injectable seam for hermetic tests — returns the raw shell stdout, or null on failure. */
export type RunShell = () => Promise<string | null> | string | null;

export type LoginShellSpawn = (
  command: string,
  args: readonly string[],
  options: {
    stdio: ["ignore", "pipe", "ignore"];
    windowsHide: boolean;
    env?: NodeJS.ProcessEnv;
  },
) => ChildProcess;

export type LoginShellPathDeps = {
  runShell?: RunShell;
  readLink?: ReadLink;
  platform?: NodeJS.Platform;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  spawn?: LoginShellSpawn;
  logger?: ClientLogger;
};

export type LoginShellPathProbe = {
  readonly ok: boolean;
  readonly dirs: string[];
  readonly env: ProbedShellEnv;
};

type Memo = LoginShellPathProbe;

/** Cached successful probe or the settled skip, kept for the process. */
let memo: Memo | undefined;
/** In-flight probe shared by concurrent callers so one spawn serves them all. */
let inFlight: Promise<Memo> | undefined;
/** Count of probe spawns that did NOT succeed, used to enforce the attempt cap. */
let failedAttempts = 0;

export async function getLoginShellPathDirs(deps: LoginShellPathDeps = {}): Promise<string[]> {
  return (await probeLoginShellPath(deps)).dirs;
}

export async function probeLoginShellPath(deps: LoginShellPathDeps = {}): Promise<LoginShellPathProbe> {
  if (memo) return memo;
  if (inFlight) return inFlight;
  const pending = runProbe(deps);
  inFlight = pending;
  try {
    return await pending;
  } finally {
    if (inFlight === pending) inFlight = undefined;
  }
}

/** Reset the memoized result, in-flight probe, and attempt counter. Tests only. */
export function resetLoginShellPathDirsCache(): void {
  memo = undefined;
  inFlight = undefined;
  failedAttempts = 0;
}

async function runProbe(deps: LoginShellPathDeps): Promise<LoginShellPathProbe> {
  const logger = deps.logger ?? createLogger("runtime-login-shell-path");
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    memo = { ok: false, dirs: [], env: {} };
    return memo;
  }
  const runShell = deps.runShell ?? (() => defaultRunShell(deps));
  const probed = await readProbe(runShell, logger);
  if (probed) {
    const result = interpretProbe(probed, deps);
    memo = result;
    return result;
  }
  failedAttempts += 1;
  logger.debug({ attempt: failedAttempts, code: "probe_failed" }, "Login shell PATH probe failed");
  if (failedAttempts >= LOGIN_SHELL_PROBE_MAX_ATTEMPTS) {
    memo = { ok: false, dirs: [], env: {} };
    return memo;
  }
  return { ok: false, dirs: [], env: {} };
}

async function readProbe(
  runShell: RunShell,
  logger: Pick<ClientLogger, "debug">,
): Promise<{ dirs: string[]; env: ProbedShellEnv } | null> {
  let output: string | null;
  try {
    output = await runShell();
  } catch (error) {
    logger.debug({ code: "shell_execution_failed", error: String(error) }, "Login shell execution failed");
    return null;
  }
  if (!output) {
    logger.debug({ code: "shell_output_empty" }, "Login shell returned no probe output");
    return null;
  }
  const dirs = parsePathFromShellOutput(output);
  if (dirs === null) {
    logger.debug({ code: "shell_path_markers_missing" }, "Login shell probe markers were missing");
    return null;
  }
  return { dirs, env: parseShellEnv(output) };
}

function interpretProbe(
  probed: { dirs: string[]; env: ProbedShellEnv },
  deps: LoginShellPathDeps,
): LoginShellPathProbe {
  const platform = deps.platform ?? process.platform;
  const environment = deps.environment ?? {};
  const home =
    deps.home ??
    (environment.HOME && environment.HOME.length > 0 ? environment.HOME : undefined) ??
    (process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir());
  const roots = protectedRoots(platform, home);
  const vet = (dir: string): string | null =>
    roots.length === 0 ? dir : resolveOutsideProtectedRoots(dir, roots, deps.readLink);
  const resolutionDeferredPastShellExit = platform === "darwin";
  const untrusted =
    resolutionDeferredPastShellExit && probed.env.nvmBin !== undefined && probed.env.fnmDir !== undefined
      ? [probed.env.nvmBin, probed.env.fnmDir].map(vet).filter((dir): dir is string => dir !== null)
      : [];
  const trusted = (dir: string): boolean => !untrusted.some((root) => dir === root || dir.startsWith(`${root}${sep}`));
  const live = probed.dirs
    .map(vet)
    .filter((dir): dir is string => dir !== null)
    .filter(trusted);
  return { ok: true, dirs: live, env: probed.env };
}

/**
 * Build the probe command the login shell launches: it prints, bracketed by
 * {@link LOGIN_SHELL_PATH_DELIM}, the dirs of `$PATH` — one per line.
 *
 * The login shell is used only as a launcher: it runs a single opaque
 * `/bin/sh -c '…'` token, and ALL of the `$PATH` splitting and canonicalization
 * happens inside that nested POSIX `sh`.
 *
 * Off macOS each dir is canonicalized with `(cd "$d" && pwd -P)` while the
 * login shell — and any per-session fnm/nvm multishell symlink — is still
 * alive. On macOS this script performs no filesystem access at all: it only
 * prints `$PATH`, and {@link probeLoginShellPath} resolves via
 * {@link resolveOutsideProtectedRoots} so a dir that lands in a TCC-protected
 * root is dropped without being entered.
 */
export function buildProbeScript(platform: NodeJS.Platform = process.platform): string {
  const body = platform === "darwin" ? 'printf "%s\\n" "$d"' : '(cd "$d" 2>/dev/null && pwd -P)';
  const posix =
    `printf %s ${LOGIN_SHELL_PATH_DELIM}; ` +
    `set -f; IFS=:; for d in $PATH; do [ -n "$d" ] || continue; ${body}; done; ` +
    `printf %s ${LOGIN_SHELL_PATH_DELIM}; ` +
    `printf %s ${LOGIN_SHELL_ENV_DELIM}; printf "%s\n%s\n" "$FNM_DIR" "$NVM_BIN"; printf %s ${LOGIN_SHELL_ENV_DELIM}`;
  return `/bin/sh -c '${posix}'`;
}

export function defaultRunShell(deps: LoginShellPathDeps = {}): Promise<string | null> {
  const logger = deps.logger ?? createLogger("runtime-login-shell-path");
  const platform = deps.platform ?? process.platform;
  const environment = deps.environment ?? process.env;
  const spawnFn = deps.spawn ?? spawn;
  const shell = pickShell(environment, platform);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawnFn(shell, ["-lic", buildProbeScript(platform)], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: environment,
      });
    } catch (error) {
      logger.debug({ code: "shell_spawn_failed", error: String(error) }, "Login shell could not be spawned");
      finish(null);
      return;
    }
    const killAndSettle = () => {
      try {
        child.kill(LOGIN_SHELL_PROBE_KILL_SIGNAL);
      } catch (error) {
        logger.debug({ code: "shell_probe_kill_failed", error: String(error) }, "Login shell probe kill failed");
        // The child may already be gone.
      }
      child.stdout?.destroy();
      finish(null);
    };
    timer = setTimeout(killAndSettle, LOGIN_SHELL_PROBE_TIMEOUT_MS);
    timer.unref();
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > LOGIN_SHELL_PROBE_MAX_STDOUT_BYTES) {
        killAndSettle();
      }
    });
    child.on("error", (error) => {
      logger.debug({ code: "shell_process_error", error: String(error) }, "Login shell process failed");
      finish(null);
    });
    child.on("close", (status, signal) => {
      if (signal || status !== 0) finish(null);
      else finish(stdout);
    });
  });
}

function pickShell(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const shell = environment.SHELL;
  if (shell && shell.length > 0) return shell;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function parseShellEnv(output: string): ProbedShellEnv {
  const start = output.indexOf(LOGIN_SHELL_ENV_DELIM);
  if (start < 0) return {};
  const end = output.indexOf(LOGIN_SHELL_ENV_DELIM, start + LOGIN_SHELL_ENV_DELIM.length);
  if (end < 0) return {};
  const [fnmDir, nvmBin] = output.slice(start + LOGIN_SHELL_ENV_DELIM.length, end).split("\n");
  return {
    ...(fnmDir ? { fnmDir } : {}),
    ...(nvmBin ? { nvmBin } : {}),
  };
}

function parsePathFromShellOutput(output: string): string[] | null {
  const start = output.indexOf(LOGIN_SHELL_PATH_DELIM);
  if (start < 0) return null;
  const end = output.indexOf(LOGIN_SHELL_PATH_DELIM, start + LOGIN_SHELL_PATH_DELIM.length);
  if (end < 0) return null;
  const inner = output.slice(start + LOGIN_SHELL_PATH_DELIM.length, end);
  return inner.split("\n").filter((dir) => dir.length > 0);
}
