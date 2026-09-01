import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveOpenTagHome, type UpdaterStateSnapshot } from "@opentag/client";
import { type ChannelName, compareSemVer, getChannelConfig, parseSemVer } from "@opentag/shared";
import { CHANNEL, CLI_VERSION } from "../../build-info.js";
import { type DaemonServiceReconcileResult, reconcileDaemonService } from "../daemon/reconcile-service.js";
import { detectInstallMode, type InstallMode } from "./install-mode.js";
import { DEFAULT_DOWNLOAD_BASE_URL, installPortableTarget } from "./portable-installer.js";
import { readUpdaterState, writeUpdaterState } from "./updater-state.js";

const execFileAsync = promisify(execFile);
const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org";

export class UpgradeError extends Error {
  override readonly name = "UpgradeError";
}

export interface UpgradeOptions {
  /** Report the target without installing anything. */
  check?: boolean;
  /** Release channel override (tests); defaults to this build's channel. */
  channel?: ChannelName;
  /** Running CLI version override for deterministic exact-target tests. */
  currentVersion?: string;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  installMode?: InstallMode;
  fetchFn?: typeof fetch;
  /** Injectable npm runner (tests); defaults to executing `npm` on PATH. */
  runNpm?: (args: readonly string[]) => Promise<void>;
  /** Injectable portable install step (tests). */
  installPortable?: (target: string) => Promise<void>;
  /** Injectable service reconciliation (tests). */
  reconcileService?: () => Promise<DaemonServiceReconcileResult>;
  /** Injectable durable-state writer (tests). */
  writeState?: typeof writeUpdaterState;
  now?: () => number;
}

export interface UpgradeResult {
  exitCode: 0 | 1;
  currentVersion: string;
  targetVersion?: string;
  status: "error" | "up-to-date" | "ahead" | "available" | "installed";
  installMode: InstallMode["mode"];
  serviceRefresh?: "ready" | "deferred" | "failed";
  message: string;
}

interface ResolvedTarget {
  version: string;
  source: string;
}

async function resolveChannelTarget(
  mode: InstallMode,
  channel: ChannelName,
  packageName: string,
  fetchFn: typeof fetch,
  environment: NodeJS.ProcessEnv,
): Promise<ResolvedTarget> {
  if (mode.mode === "portable") {
    const base = (environment.OPENTAG_PORTABLE_DOWNLOAD_BASE_URL ?? DEFAULT_DOWNLOAD_BASE_URL).replace(/\/+$/, "");
    const url = `${base}/${channel}/latest.json`;
    const body = await fetchJson(fetchFn, url, "the channel release pointer");
    const pointer = body as Record<string, unknown>;
    if (pointer.channel !== channel) {
      throw new UpgradeError("The channel release pointer belongs to another channel");
    }
    return { version: requireSemVer(pointer.version, "the channel release pointer"), source: url };
  }
  const registry = (environment.OPENTAG_NPM_REGISTRY_URL ?? DEFAULT_NPM_REGISTRY_URL).replace(/\/+$/, "");
  const url = `${registry}/${packageName}`;
  const body = await fetchJson(fetchFn, url, "the npm registry metadata", {
    accept: "application/vnd.npm.install-v1+json",
  });
  const packument = body as Record<string, unknown>;
  const distTags = packument["dist-tags"];
  const latest =
    distTags && typeof distTags === "object" && !Array.isArray(distTags)
      ? (distTags as Record<string, unknown>).latest
      : undefined;
  return { version: requireSemVer(latest, "the npm registry metadata"), source: url };
}

function requireSemVer(value: unknown, source: string): string {
  if (typeof value !== "string" || !parseSemVer(value)) {
    throw new UpgradeError(`The exact channel target is missing or invalid in ${source}`);
  }
  return value;
}

async function fetchJson(
  fetchFn: typeof fetch,
  url: string,
  label: string,
  headers: Record<string, string> = { accept: "application/json" },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new UpgradeError(`Could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new UpgradeError(`Could not read ${label} (HTTP ${response.status})`);
  try {
    return await response.json();
  } catch {
    throw new UpgradeError(`The response from ${label} is not valid JSON`);
  }
}

async function defaultRunNpm(args: readonly string[]): Promise<void> {
  try {
    await execFileAsync("npm", [...args]);
  } catch (error) {
    throw new UpgradeError(`npm ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface UpgradeContext {
  currentVersion: string;
  channel: ChannelName;
  channelConfig: ReturnType<typeof getChannelConfig>;
  environment: NodeJS.ProcessEnv;
  installMode: InstallMode;
  home: string;
}

interface ServiceRefreshResult {
  serviceRefresh: NonNullable<UpgradeResult["serviceRefresh"]>;
  serviceMessage: string;
}

function createUpgradeContext(options: UpgradeOptions): UpgradeContext {
  const channel = options.channel ?? CHANNEL;
  const environment = options.environment ?? process.env;
  return {
    currentVersion: options.currentVersion ?? CLI_VERSION,
    channel,
    channelConfig: getChannelConfig(channel),
    environment,
    installMode: options.installMode ?? detectInstallMode(environment),
    home: options.home ?? resolveOpenTagHome(environment),
  };
}

function finishUpgrade(
  context: UpgradeContext,
  result: Omit<UpgradeResult, "currentVersion" | "installMode">,
): UpgradeResult {
  return { currentVersion: context.currentVersion, installMode: context.installMode.mode, ...result };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function currentTargetNeedsRepair(home: string, target: string): Promise<boolean> {
  const loaded = await readUpdaterState(home);
  if (loaded.status === "invalid") return true;
  if (loaded.status !== "ok" || loaded.state.target !== target) return false;
  return loaded.state.state === "blocked" || loaded.state.attempts[target]?.result === "failed";
}

async function noInstallResult(
  context: UpgradeContext,
  target: ResolvedTarget,
  comparison: -1 | 0 | 1,
  check: boolean,
): Promise<UpgradeResult | undefined> {
  const exactCurrent = target.version === context.currentVersion;
  if (exactCurrent && (check || !(await currentTargetNeedsRepair(context.home, target.version)))) {
    return finishUpgrade(context, {
      exitCode: 0,
      status: "up-to-date",
      targetVersion: target.version,
      message: `OpenTag ${context.currentVersion} is already the exact ${context.channel} channel target`,
    });
  }
  if (comparison < 0) {
    return finishUpgrade(context, {
      exitCode: 0,
      status: "ahead",
      targetVersion: target.version,
      message: `OpenTag ${context.currentVersion} is ahead of the ${context.channel} channel target ${target.version}; nothing to do`,
    });
  }
  if (comparison >= 0 && check) {
    return finishUpgrade(context, {
      exitCode: 0,
      status: "available",
      targetVersion: target.version,
      message: `OpenTag ${target.version} is available on the ${context.channel} channel (running ${context.currentVersion})`,
    });
  }
  return undefined;
}

async function installResolvedTarget(context: UpgradeContext, target: string, options: UpgradeOptions): Promise<void> {
  // The exact target is already running. Manual upgrade repairs durable state and the supervisor
  // definition without reinstalling identical bytes.
  if (target === context.currentVersion) return;
  if (context.installMode.mode === "npm-global") {
    await (options.runNpm ?? defaultRunNpm)(["install", "-g", `${context.channelConfig.packageName}@${target}`]);
    return;
  }
  if (options.installPortable) {
    await options.installPortable(target);
    return;
  }
  await installPortableTarget({
    channel: context.channel,
    targetVersion: target,
    root: context.installMode.root,
    binDir: context.installMode.binDir,
    binName: context.channelConfig.binName,
    packageName: context.channelConfig.packageName,
    ...(context.environment.OPENTAG_PORTABLE_DOWNLOAD_BASE_URL
      ? { downloadBaseUrl: context.environment.OPENTAG_PORTABLE_DOWNLOAD_BASE_URL }
      : {}),
  });
}

async function recordInstalledUpgrade(
  home: string,
  target: string,
  now: number,
  writeState: typeof writeUpdaterState,
): Promise<UpdaterStateSnapshot> {
  const loaded = await readUpdaterState(home);
  const state: UpdaterStateSnapshot =
    loaded.status === "ok" ? loaded.state : { schemaVersion: 1, currentVersion: target, state: "idle", attempts: {} };
  const attempt = {
    target,
    startedAt: new Date(now).toISOString(),
    finishedAt: new Date(now).toISOString(),
    result: "installed" as const,
  };
  state.currentVersion = target;
  state.state = "installed";
  state.target = target;
  state.attempts[target] = attempt;
  state.lastAttempt = attempt;
  await writeState(home, state);
  return state;
}

async function refreshDaemonService(
  home: string,
  target: string,
  state: UpdaterStateSnapshot,
  reconcile: () => Promise<DaemonServiceReconcileResult>,
  writeState: typeof writeUpdaterState,
): Promise<ServiceRefreshResult> {
  try {
    const reconciled = await reconcile();
    const deferred = reconciled.status === "deferred";
    return {
      serviceRefresh: deferred ? "deferred" : "ready",
      serviceMessage:
        deferred && reconciled.reason === "credentials-missing" ? " (service setup deferred until login)" : "",
    };
  } catch (error) {
    const failureReason = errorMessage(error);
    const attempt = state.attempts[target];
    state.state = "blocked";
    if (attempt) {
      attempt.result = "failed";
      attempt.failureReason = failureReason;
      state.lastAttempt = attempt;
    }
    try {
      await writeState(home, state);
      return { serviceRefresh: "failed", serviceMessage: `; the daemon service refresh failed: ${failureReason}` };
    } catch (stateError) {
      return {
        serviceRefresh: "failed",
        serviceMessage: `; the daemon service refresh failed: ${failureReason}; recording the blocked updater state also failed: ${errorMessage(stateError)}`,
      };
    }
  }
}

/**
 * Manual upgrade for both install modes. This is the only upgrade path for npm-global installs
 * (they never auto-install), and the operator-driven repair path for a blocked portable target.
 * Both modes install the exact channel target, refresh the daemon service, and record the outcome
 * so the daemon's automatic updater never re-attempts it.
 */
export async function runUpgrade(options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const context = createUpgradeContext(options);
  if (context.channel === "dev") {
    return finishUpgrade(context, {
      exitCode: 1,
      status: "error",
      message: "Upgrades are available on the staging and production channels only",
    });
  }

  let target: ResolvedTarget;
  try {
    target = await resolveChannelTarget(
      context.installMode,
      context.channel,
      context.channelConfig.packageName,
      options.fetchFn ?? fetch,
      context.environment,
    );
  } catch (error) {
    return finishUpgrade(context, { exitCode: 1, status: "error", message: errorMessage(error) });
  }

  const comparison = compareSemVer(target.version, context.currentVersion);
  const noInstall = await noInstallResult(context, target, comparison, options.check ?? false);
  if (noInstall) return noInstall;

  try {
    await installResolvedTarget(context, target.version, options);
  } catch (error) {
    return finishUpgrade(context, {
      exitCode: 1,
      status: "error",
      targetVersion: target.version,
      message: errorMessage(error),
    });
  }

  let state: UpdaterStateSnapshot;
  try {
    state = await recordInstalledUpgrade(
      context.home,
      target.version,
      (options.now ?? Date.now)(),
      options.writeState ?? writeUpdaterState,
    );
  } catch (error) {
    return finishUpgrade(context, {
      exitCode: 1,
      status: "error",
      targetVersion: target.version,
      message: `Installed ${target.version} but could not record the upgrade state: ${errorMessage(error)}`,
    });
  }

  const { serviceRefresh, serviceMessage } = await refreshDaemonService(
    context.home,
    target.version,
    state,
    options.reconcileService ?? reconcileDaemonService,
    options.writeState ?? writeUpdaterState,
  );

  return finishUpgrade(context, {
    exitCode: serviceRefresh === "failed" ? 1 : 0,
    status: "installed",
    targetVersion: target.version,
    serviceRefresh,
    message: `OpenTag ${target.version} installed (${context.installMode.mode})${serviceMessage}`,
  });
}
