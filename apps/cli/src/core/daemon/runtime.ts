import { randomUUID } from "node:crypto";
import { arch, hostname, platform } from "node:os";
import {
  type ClientLogger,
  configureClientLoggerForService,
  createClientRuntime,
  createLogger,
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
import { resolveChannelEnvironment } from "../channel/environment.js";
import { resolveCommandContext } from "../command/context.js";
import { createPortableAutoUpdater } from "../update/auto-update.js";
import { detectInstallMode, type InstallMode } from "../update/install-mode.js";
import { applyDaemonEnvironment, buildDaemonChildEnvironment } from "./environment.js";
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

interface DaemonMutableState {
  channelTargetObserver?: (target: RuntimeChannelTarget) => void;
  handoffRequested: boolean;
  terminalLogger?: ClientLogger;
  updater?: UpdateManager;
}

interface DaemonLifecycleContext {
  currentPlatform: NodeJS.Platform;
  daemonEnvironment: NodeJS.ProcessEnv;
  gatedRuntimeLogger: ClientLoggerGate;
  home: string;
  logger: ClientLogger;
  options: DaemonRuntimeOptions;
  state: DaemonMutableState;
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
  const environment = resolveChannelEnvironment(process.env);
  const home = options.home ?? resolveOpenTagHome(environment);
  const paths = resolveDaemonPaths(home);
  const signals = options.signals ?? process;
  const instanceId = randomUUID();
  const currentPlatform = platform();
  const baseBindings = {
    clientVersion: CLI_VERSION,
    instanceId,
    platform: currentPlatform,
  };

  let lifecycleLogger: ClientLogger | undefined;
  let runtimeLoggerGate: ClientLoggerGate | undefined;
  const state: DaemonMutableState = { handoffRequested: false };
  let ownership: Awaited<ReturnType<typeof acquireOwnership>> | undefined;
  let failure: unknown;
  let failed = false;
  try {
    const environmentResult = await applyDaemonEnvironment(home, environment);
    const daemonEnvironment = buildDaemonChildEnvironment(environmentResult);
    if (daemonEnvironment.OPENTAG_SERVICE_MODE === "1") configureClientLoggerForService(paths.logs);
    ownership = await acquireOwnership(home, instanceId, options, baseBindings);

    const logger = (options.logger ?? createLogger("daemon")).child(baseBindings);
    lifecycleLogger = logger;
    state.terminalLogger = logger;
    const gatedRuntimeLogger = createClientLoggerGate(logger);
    runtimeLoggerGate = gatedRuntimeLogger;
    const environmentLogger = logger.child({ module: "environment" });
    environmentLogger.debug({ appliedCount: environmentResult.appliedKeys.length }, "Daemon environment loaded");
    for (const lineNumber of environmentResult.malformedLineNumbers) {
      environmentLogger.warn({ lineNumber }, "Malformed daemon environment line ignored");
    }
    logger.info({}, "Daemon startup started");
    const context = { currentPlatform, daemonEnvironment, gatedRuntimeLogger, home, logger, options, state };
    await runDaemonLifecycle((signal) => createDaemonRuntime(context, signal), signals);
  } catch (error) {
    const logger =
      state.terminalLogger ?? (options.logger ?? createLogger("daemon", { destination: "dual" })).child(baseBindings);
    logTerminalFailure(logger, error);
    failure = error;
    failed = true;
  }

  lifecycleLogger?.info({}, "Daemon stopping");
  state.updater?.stop();
  lifecycleLogger?.info({}, "Daemon runtime stopped");
  runtimeLoggerGate?.disable();
  try {
    await ownership?.release();
  } catch (error) {
    const logger =
      state.terminalLogger ?? (options.logger ?? createLogger("daemon", { destination: "dual" })).child(baseBindings);
    logger.error({ category: "ownership_release" }, "Daemon ownership release failed");
    if (!failed) {
      failure = error;
      failed = true;
    }
  }
  if (failed) throw failure;
  return { supervisorRestartRequested: state.handoffRequested };
}

async function acquireOwnership(
  home: string,
  instanceId: string,
  options: DaemonRuntimeOptions,
  baseBindings: Readonly<Record<string, unknown>>,
): Promise<Awaited<ReturnType<typeof acquireDaemonOwner>>> {
  try {
    return await acquireDaemonOwner(home, instanceId);
  } catch (error) {
    const logger = (options.logger ?? createLogger("daemon", { destination: "dual" })).child(baseBindings);
    logTerminalFailure(logger, error);
    throw error;
  }
}

async function createDaemonRuntime(context: DaemonLifecycleContext, signal: AbortSignal): Promise<DaemonRuntime> {
  const { credential, identity, supportedPlatform } = await readDaemonIdentity(
    context.home,
    context.currentPlatform,
    signal,
  );
  context.state.terminalLogger = context.logger.child({
    computerId: credential.computerId,
    installationId: identity.computerId,
  });
  const connectionInstanceId = randomUUID();
  const runtimeLogger = context.gatedRuntimeLogger.logger.child({
    computerId: credential.computerId,
    installationId: identity.computerId,
    instanceId: connectionInstanceId,
  });
  const apiContext = await resolveCommandContext({ home: context.home, serverUrl: credential.serverUrl });
  if (!apiContext.api) throw new Error("Command context did not resolve an API");
  const connection = new RuntimeConnection({
    arch: arch(),
    clientVersion: CLI_VERSION,
    computer: identity,
    displayName: hostname(),
    instanceId: connectionInstanceId,
    logger: runtimeLogger.child({ module: "connection" }),
    machineToken: credential.machineToken,
    onChannelTarget: (target) => context.state.channelTargetObserver?.(target),
    platform: supportedPlatform,
  });
  const runtime = await createClientRuntime(connection, {
    home: context.home,
    environment: context.daemonEnvironment,
    clientVersion: CLI_VERSION,
    cliCommand: channelConfig.binName,
    logger: runtimeLogger,
    signal,
    api: apiContext.api,
    machineToken: credential.machineToken,
  });
  context.state.updater = await attachAutoUpdater(context, runtime, runtimeLogger);
  void connection.whenRegistered(signal).then(
    () => runtimeLogger.info({}, "Computer runtime is ready"),
    () => undefined,
  );
  return { run: () => runtime.run(), stop: () => runtime.stop() };
}

async function readDaemonIdentity(home: string, currentPlatform: NodeJS.Platform, signal: AbortSignal) {
  let credentials: Awaited<ReturnType<typeof readMachineCredentials>>;
  try {
    credentials = await readMachineCredentials(home);
  } catch (error) {
    throw new DaemonRuntimeConfigurationError("OpenTag Computer credentials are invalid; run computer connect again", {
      cause: error,
    });
  }
  signal.throwIfAborted();
  const bound = resolveBoundAccountComputer(credentials);
  if (bound.status === "disconnected") {
    throw new DaemonRuntimeConfigurationError("This Computer is not connected; run computer connect first");
  }
  let identity: Awaited<ReturnType<typeof resolveComputerIdentity>>;
  try {
    identity = await resolveComputerIdentity(home, bound.credential.serverUrl);
  } catch (error) {
    throw new DaemonRuntimeConfigurationError("The local Computer identity is invalid", { cause: error });
  }
  signal.throwIfAborted();
  if (currentPlatform !== "darwin" && currentPlatform !== "linux") {
    throw new DaemonRuntimeConfigurationError(`Unsupported daemon service platform: ${currentPlatform}`);
  }
  if (bound.credential.installationId !== identity.computerId) {
    throw new DaemonRuntimeConfigurationError("A machine credential belongs to another Computer");
  }
  return { credential: bound.credential, identity, supportedPlatform: currentPlatform };
}

async function attachAutoUpdater(
  context: DaemonLifecycleContext,
  runtime: Awaited<ReturnType<typeof createClientRuntime>>,
  runtimeLogger: ClientLogger,
): Promise<UpdateManager | undefined> {
  const autoUpdate = context.options.autoUpdate === false ? undefined : (context.options.autoUpdate ?? {});
  const installMode = autoUpdate?.installMode ?? detectInstallMode(process.env);
  const shouldAttach =
    autoUpdate !== undefined && installMode.mode === "portable" && (autoUpdate.attach ?? CHANNEL !== "dev");
  if (!shouldAttach || installMode.mode !== "portable") return undefined;
  const updater = createPortableAutoUpdater({
    home: context.home,
    installMode,
    protectedWork: () => runtime.protectedWork(),
    quiesce: () => runtime.quiesceForUpdate(),
    onHandoff: () => {
      context.state.handoffRequested = true;
      runtime.stop();
    },
    logger: runtimeLogger.child({ module: "updater" }),
    ...(autoUpdate.installTarget ? { installTarget: autoUpdate.installTarget } : {}),
    ...(autoUpdate.refreshService ? { refreshService: autoUpdate.refreshService } : {}),
    ...(autoUpdate.stateStore ? { stateStore: autoUpdate.stateStore } : {}),
    ...(autoUpdate.checkIntervalMs ? { checkIntervalMs: autoUpdate.checkIntervalMs } : {}),
  });
  await updater.syncRunningVersion();
  context.state.channelTargetObserver = (target) => updater.observe(target);
  if (autoUpdate.initialTarget) updater.observe(autoUpdate.initialTarget);
  return updater;
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
