import { randomUUID } from "node:crypto";
import { arch, hostname, platform } from "node:os";
import {
  type ClientLogger,
  configureClientLoggerForService,
  createClientRuntime,
  createLogger,
  OpenTagApi,
  RuntimeConnection,
  RuntimeConnectionError,
  readMachineCredentials,
  resolveBoundAccountComputer,
  resolveComputerIdentity,
  resolveOpenTagHome,
  type UpdateManager,
  type UpdaterStateSnapshot,
} from "@opentag/client";
import type { RuntimeChannelTarget } from "@opentag/shared";
import { CHANNEL, CLI_VERSION } from "../../build-info.js";
import { channelConfig } from "../channel/config.js";
import { createPortableAutoUpdater } from "../update/auto-update.js";
import { detectInstallMode, type InstallMode } from "../update/install-mode.js";
import { applyDaemonEnvironment } from "./environment.js";
import { SUPERVISOR_RESTART_EXIT_CODE } from "./handoff.js";
import { acquireDaemonOwner, DaemonOwnerStartupError } from "./ownership.js";
import { resolveDaemonPaths } from "./paths.js";
import { DaemonServiceError } from "./service/types.js";

export interface DaemonAutoUpdateOverrides {
  /** Force attaching or skipping the updater; defaults to portable installs on non-dev channels. */
  attach?: boolean;
  installMode?: InstallMode;
  installTarget?: (target: string) => Promise<void>;
  refreshService?: () => Promise<void>;
  stateStore?: {
    loadState(): Promise<UpdaterStateSnapshot | undefined>;
    saveState(state: UpdaterStateSnapshot): Promise<void>;
  };
  checkIntervalMs?: number;
  /** Observe a target immediately after startup (deterministic tests). */
  initialTarget?: RuntimeChannelTarget;
}

export interface DaemonServiceRunResult {
  /** True when the daemon stopped to let the supervisor restart it onto a newly installed version. */
  supervisorRestartRequested: boolean;
}

export interface DaemonRuntimeOptions {
  home?: string;
  logger?: ClientLogger;
  signals?: NodeJS.Process;
  /** Automatic-upgrade control: `false` disables it; overrides exist for deterministic tests. */
  autoUpdate?: false | DaemonAutoUpdateOverrides;
}

interface DaemonRuntime {
  run(): Promise<void>;
  stop(): void;
}

interface DaemonSignals {
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

interface ClientLoggerGate {
  disable(): void;
  logger: ClientLogger;
}

export async function runDaemonLifecycle(
  createRuntime: (signal: AbortSignal) => Promise<DaemonRuntime>,
  signals: DaemonSignals,
): Promise<void> {
  const startupAbort = new AbortController();
  let runtime: DaemonRuntime | undefined;
  let stopRequested = false;
  const stop = () => {
    stopRequested = true;
    startupAbort.abort();
    runtime?.stop();
  };
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);
  try {
    runtime = await createRuntime(startupAbort.signal);
    if (stopRequested) {
      runtime.stop();
      return;
    }
    await runtime.run();
  } catch (error) {
    if (!stopRequested) throw error;
  } finally {
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
  }
}

export class DaemonRuntimeConfigurationError extends Error {
  override readonly name = "DaemonRuntimeConfigurationError";
}

export async function runDaemonService(options: DaemonRuntimeOptions = {}): Promise<DaemonServiceRunResult> {
  const home = options.home ?? resolveOpenTagHome();
  const paths = resolveDaemonPaths(home);
  const signals = options.signals ?? process;
  const instanceId = randomUUID();
  const currentPlatform = platform();
  const baseBindings = {
    clientVersion: CLI_VERSION,
    instanceId,
    platform: currentPlatform,
  };
  let ownership: Awaited<ReturnType<typeof acquireDaemonOwner>>;
  try {
    ownership = await acquireDaemonOwner(home, instanceId);
  } catch (error) {
    const logger = (options.logger ?? createLogger("daemon", { destination: "stderr" })).child(baseBindings);
    logTerminalFailure(logger, error);
    throw error;
  }

  let lifecycleLogger: ClientLogger | undefined;
  let terminalLogger: ClientLogger | undefined;
  let runtimeLoggerGate: ClientLoggerGate | undefined;
  let updater: UpdateManager | undefined;
  let handoffRequested = false;
  let channelTargetObserver: ((target: RuntimeChannelTarget) => void) | undefined;
  let failure: unknown;
  let failed = false;
  try {
    const environmentResult = await applyDaemonEnvironment(home, process.env);
    if (process.env.OPENTAG_SERVICE_MODE === "1") configureClientLoggerForService(paths.logs);
    const logger = (options.logger ?? createLogger("daemon")).child(baseBindings);
    lifecycleLogger = logger;
    terminalLogger = logger;
    const gatedRuntimeLogger = createClientLoggerGate(logger);
    runtimeLoggerGate = gatedRuntimeLogger;
    const environmentLogger = logger.child({ module: "environment" });
    environmentLogger.debug({ appliedCount: environmentResult.appliedKeys.length }, "Daemon environment loaded");
    for (const lineNumber of environmentResult.malformedLineNumbers) {
      environmentLogger.warn({ lineNumber }, "Malformed daemon environment line ignored");
    }
    logger.info({}, "Daemon startup started");
    await runDaemonLifecycle(async (signal) => {
      let credentials: Awaited<ReturnType<typeof readMachineCredentials>>;
      try {
        credentials = await readMachineCredentials(home);
      } catch (error) {
        throw new DaemonRuntimeConfigurationError(
          "OpenTag Computer credentials are invalid; run computer connect again",
          {
            cause: error,
          },
        );
      }
      signal.throwIfAborted();
      const bound = resolveBoundAccountComputer(credentials);
      if (bound.status === "disconnected") {
        throw new DaemonRuntimeConfigurationError("This Computer is not enrolled; run computer connect first");
      }
      const credential = bound.credential;
      const serverUrl = credential.serverUrl;
      let identity: Awaited<ReturnType<typeof resolveComputerIdentity>>;
      try {
        identity = await resolveComputerIdentity(home, serverUrl);
      } catch (error) {
        throw new DaemonRuntimeConfigurationError("The local Computer identity is invalid", { cause: error });
      }
      signal.throwIfAborted();
      if (currentPlatform !== "darwin" && currentPlatform !== "linux") {
        throw new DaemonRuntimeConfigurationError(`Unsupported daemon service platform: ${currentPlatform}`);
      }
      terminalLogger = logger.child({ computerId: identity.computerId });
      if (credential.computerId !== identity.computerId) {
        throw new DaemonRuntimeConfigurationError("A machine credential belongs to another Computer");
      }
      const connectionInstanceId = randomUUID();
      const runtimeLogger = gatedRuntimeLogger.logger.child({
        computerId: identity.computerId,
        instanceId: connectionInstanceId,
        workspaceComputerId: credential.workspaceComputerId,
      });
      const api = new OpenTagApi(credential.serverUrl);
      const connection = new RuntimeConnection({
        arch: arch(),
        clientVersion: CLI_VERSION,
        computer: identity,
        displayName: hostname(),
        instanceId: connectionInstanceId,
        logger: runtimeLogger.child({ module: "connection" }),
        machineToken: credential.machineToken,
        onChannelTarget: (target) => channelTargetObserver?.(target),
        platform: currentPlatform,
      });
      const runtime = await createClientRuntime(connection, {
        home,
        clientVersion: CLI_VERSION,
        cliCommand: channelConfig.binName,
        logger: runtimeLogger,
        signal,
        api,
        machineToken: credential.machineToken,
      });
      const autoUpdate = options.autoUpdate === false ? undefined : (options.autoUpdate ?? {});
      const installMode = autoUpdate?.installMode ?? detectInstallMode(process.env);
      const attachUpdater =
        autoUpdate !== undefined && installMode.mode === "portable" && (autoUpdate.attach ?? CHANNEL !== "dev");
      if (attachUpdater && installMode.mode === "portable") {
        updater = createPortableAutoUpdater({
          home,
          installMode,
          protectedWork: () => runtime.protectedWork(),
          quiesce: () => runtime.quiesceForUpdate(),
          onHandoff: () => {
            handoffRequested = true;
            runtime.stop();
          },
          logger: runtimeLogger.child({ module: "updater" }),
          ...(autoUpdate?.installTarget ? { installTarget: autoUpdate.installTarget } : {}),
          ...(autoUpdate?.refreshService ? { refreshService: autoUpdate.refreshService } : {}),
          ...(autoUpdate?.stateStore ? { stateStore: autoUpdate.stateStore } : {}),
          ...(autoUpdate?.checkIntervalMs ? { checkIntervalMs: autoUpdate.checkIntervalMs } : {}),
        });
        await updater.syncRunningVersion();
        const attached = updater;
        channelTargetObserver = (target) => attached.observe(target);
        if (autoUpdate?.initialTarget) attached.observe(autoUpdate.initialTarget);
      }
      void connection.whenRegistered(signal).then(
        () => runtimeLogger.info({}, "Computer runtime is ready"),
        () => undefined,
      );
      return {
        run: () => runtime.run(),
        stop: () => runtime.stop(),
      };
    }, signals);
  } catch (error) {
    const logger =
      terminalLogger ?? (options.logger ?? createLogger("daemon", { destination: "stderr" })).child(baseBindings);
    logTerminalFailure(logger, error);
    failure = error;
    failed = true;
  }

  lifecycleLogger?.info({}, "Daemon stopping");
  updater?.stop();
  lifecycleLogger?.info({}, "Daemon runtime stopped");
  runtimeLoggerGate?.disable();
  try {
    await ownership.release();
  } catch (error) {
    const logger =
      terminalLogger ?? (options.logger ?? createLogger("daemon", { destination: "stderr" })).child(baseBindings);
    logger.error({ category: "ownership_release" }, "Daemon ownership release failed");
    if (!failed) {
      failure = error;
      failed = true;
    }
  }
  if (failed) throw failure;
  return { supervisorRestartRequested: handoffRequested };
}

export async function runDaemonServiceEntry(options: DaemonRuntimeOptions = {}): Promise<0 | 1 | 75> {
  try {
    const result = await runDaemonService(options);
    return result.supervisorRestartRequested ? SUPERVISOR_RESTART_EXIT_CODE : 0;
  } catch (error) {
    return isExpectedDaemonStop(error) ? 0 : 1;
  }
}

function isExpectedDaemonStop(error: unknown): boolean {
  return (
    error instanceof DaemonRuntimeConfigurationError ||
    error instanceof DaemonOwnerStartupError ||
    (error instanceof RuntimeConnectionError && error.fatal) ||
    (error instanceof DaemonServiceError && ["CONFIGURATION", "UNSUPPORTED_PLATFORM"].includes(error.code))
  );
}

function daemonOperatorMessage(error: unknown): string {
  if (error instanceof DaemonRuntimeConfigurationError) {
    return "Daemon configuration is invalid; run computer connect or inspect daemon status";
  }
  if (error instanceof DaemonOwnerStartupError) {
    return error.code === "BUSY"
      ? "Daemon is already running; inspect daemon status"
      : "Daemon ownership prevented startup; inspect daemon status";
  }
  if (error instanceof RuntimeConnectionError) return "Daemon connection was rejected; run computer connect again";
  return "Daemon service configuration prevented startup; inspect daemon status";
}

function daemonFailureCategory(error: unknown): string {
  if (error instanceof DaemonRuntimeConfigurationError) return "configuration";
  if (error instanceof DaemonOwnerStartupError) return "ownership";
  if (error instanceof RuntimeConnectionError) return error.fatal ? "connection_fatal" : "connection";
  if (error instanceof DaemonServiceError) return error.code.toLowerCase();
  return "unexpected";
}

function logTerminalFailure(logger: ClientLogger, error: unknown): void {
  if (isExpectedDaemonStop(error)) {
    logger.warn({ category: daemonFailureCategory(error) }, daemonOperatorMessage(error));
    return;
  }
  logger.error({ category: daemonFailureCategory(error) }, "Daemon stopped because of an unexpected internal failure");
}

function createClientLoggerGate(logger: ClientLogger): ClientLoggerGate {
  const state = { enabled: true };
  const wrap = (target: ClientLogger): ClientLogger => ({
    child: (bindings) => wrap(target.child(bindings)),
    debug: (fields, message) => {
      if (state.enabled) target.debug(fields, message);
    },
    error: (fields, message) => {
      if (state.enabled) target.error(fields, message);
    },
    info: (fields, message) => {
      if (state.enabled) target.info(fields, message);
    },
    warn: (fields, message) => {
      if (state.enabled) target.warn(fields, message);
    },
  });
  return {
    disable: () => {
      state.enabled = false;
    },
    logger: wrap(logger),
  };
}
