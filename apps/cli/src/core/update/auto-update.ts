import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type ClientLogger,
  createLogger,
  type ProtectedWorkCount,
  UpdateManager,
  type UpdateManagerOptions,
  type UpdaterStateSnapshot,
} from "@opentag/client";
import { CHANNEL, CLI_VERSION } from "../../build-info.js";
import { channelConfig } from "../channel/config.js";
import type { InstallMode } from "./install-mode.js";
import { DEFAULT_DOWNLOAD_BASE_URL, installPortableTarget, PortableInstallError } from "./portable-installer.js";
import { createUpdaterStateStore } from "./updater-state.js";

const execFileAsync = promisify(execFile);

export interface PortableAutoUpdateOptions {
  home: string;
  installMode: Extract<InstallMode, { mode: "portable" }>;
  protectedWork(): ProtectedWorkCount;
  quiesce(): () => void;
  /** Called after a successful install so the daemon can stop and exit with the reserved code. */
  onHandoff(): void | Promise<void>;
  logger?: ClientLogger;
  environment?: NodeJS.ProcessEnv;
  /** Injectable install step (tests). Defaults to the real portable installer. */
  installTarget?: (target: string) => Promise<void>;
  /** Injectable service refresh (tests). Defaults to running the newly installed binary. */
  refreshService?: () => Promise<void>;
  stateStore?: {
    loadState(): Promise<UpdaterStateSnapshot | undefined>;
    saveState(state: UpdaterStateSnapshot): Promise<void>;
  };
  checkIntervalMs?: UpdateManagerOptions["checkIntervalMs"];
}

/**
 * Runs `daemon refresh-service` through the stable shim — which now resolves to the newly installed
 * binary — so the supervisor definition is rewritten by the version that will run next, without
 * restarting the service (the reserved exit code handoff owns the restart).
 */
async function refreshServiceThroughShim(binDir: string, binName: string): Promise<void> {
  try {
    await execFileAsync(`${binDir}/${binName}`, ["daemon", "refresh-service"]);
  } catch (error) {
    const detail =
      error && typeof error === "object" && "code" in error && typeof error.code === "number"
        ? `exit code ${error.code}`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new PortableInstallError(`The daemon service refresh through the new version failed (${detail})`);
  }
}

/**
 * Attach the automatic-upgrade manager for a portable install. npm-global installs never attach one:
 * they upgrade only through the manual `upgrade` command.
 */
export function createPortableAutoUpdater(options: PortableAutoUpdateOptions): UpdateManager {
  const environment = options.environment ?? process.env;
  const logger = options.logger ?? createLogger("updater");
  const installTarget =
    options.installTarget ??
    (async (target: string) => {
      const result = await installPortableTarget({
        channel: CHANNEL,
        targetVersion: target,
        root: options.installMode.root,
        binDir: options.installMode.binDir,
        binName: channelConfig.binName,
        packageName: channelConfig.packageName,
        ...(environment.OPENTAG_PORTABLE_DOWNLOAD_BASE_URL
          ? { downloadBaseUrl: environment.OPENTAG_PORTABLE_DOWNLOAD_BASE_URL }
          : {}),
      });
      if (result.cleanupFailure) {
        logger.warn(
          { target, cleanupFailure: result.cleanupFailure },
          "Portable update activated but staging cleanup failed",
        );
      }
    });
  const refreshService =
    options.refreshService ?? (() => refreshServiceThroughShim(options.installMode.binDir, channelConfig.binName));
  const stateStore = options.stateStore ?? createUpdaterStateStore(options.home);
  return new UpdateManager({
    channel: CHANNEL,
    currentVersion: CLI_VERSION,
    logger,
    protectedWork: options.protectedWork,
    quiesce: options.quiesce,
    executeUpdate: async (target) => {
      await installTarget(target);
      await refreshService();
    },
    onHandoff: options.onHandoff,
    loadState: stateStore.loadState,
    saveState: stateStore.saveState,
    ...(options.checkIntervalMs ? { checkIntervalMs: options.checkIntervalMs } : {}),
  });
}

export { DEFAULT_DOWNLOAD_BASE_URL };
