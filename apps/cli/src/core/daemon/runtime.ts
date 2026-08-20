import { randomUUID } from "node:crypto";
import { arch, hostname, platform } from "node:os";
import {
  AccessTokenProvider,
  type ClientLogger,
  configureClientLoggerForService,
  createClientRuntime,
  createLogger,
  OpenTagApi,
  OpenTagApiError,
  RuntimeConnection,
  RuntimeConnectionError,
  readCredentials,
  resolveComputerIdentity,
  resolveOpenTagHome,
} from "@opentag/client";
import { CLI_VERSION } from "../../build-info.js";
import { applyDaemonEnvironment } from "./environment.js";
import { acquireDaemonOwner, DaemonOwnerStartupError } from "./ownership.js";
import { resolveDaemonPaths } from "./paths.js";
import { DaemonServiceError } from "./service/types.js";

export interface DaemonRuntimeOptions {
  home?: string;
  logger?: ClientLogger;
  signals?: NodeJS.Process;
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

export async function runDaemonService(options: DaemonRuntimeOptions = {}): Promise<void> {
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
      let credentials: Awaited<ReturnType<typeof readCredentials>>;
      try {
        credentials = await readCredentials(home);
      } catch (error) {
        throw new DaemonRuntimeConfigurationError("OpenTag credentials are invalid; run login again", {
          cause: error,
        });
      }
      signal.throwIfAborted();
      if (!credentials) throw new DaemonRuntimeConfigurationError("OpenTag is not logged in; run login first");
      const api = new OpenTagApi(credentials.serverUrl);
      const tokenProvider = new AccessTokenProvider({ home, api });
      let lease: Awaited<ReturnType<AccessTokenProvider["getAccessTokenLease"]>>;
      try {
        lease = await tokenProvider.getAccessTokenLease();
      } catch (error) {
        if (error instanceof OpenTagApiError && error.category === "credential") {
          throw new DaemonRuntimeConfigurationError("OpenTag credentials are no longer valid; run login again", {
            cause: error,
          });
        }
        throw error;
      }
      signal.throwIfAborted();
      let me: Awaited<ReturnType<OpenTagApi["me"]>>;
      try {
        me = await api.me(lease.accessToken);
      } catch (error) {
        if (error instanceof OpenTagApiError && error.category === "credential") {
          throw new DaemonRuntimeConfigurationError("OpenTag credentials are no longer valid; run login again", {
            cause: error,
          });
        }
        throw error;
      }
      signal.throwIfAborted();
      let identity: Awaited<ReturnType<typeof resolveComputerIdentity>>;
      try {
        identity = await resolveComputerIdentity(home, credentials.serverUrl, me.user.id);
      } catch (error) {
        throw new DaemonRuntimeConfigurationError("The local Computer identity is invalid", { cause: error });
      }
      signal.throwIfAborted();
      if (currentPlatform !== "darwin" && currentPlatform !== "linux") {
        throw new DaemonRuntimeConfigurationError(`Unsupported daemon service platform: ${currentPlatform}`);
      }
      terminalLogger = logger.child({ computerId: identity.computerId });
      const runtimeLogger = gatedRuntimeLogger.logger.child({ computerId: identity.computerId });
      const connection = new RuntimeConnection({
        arch: arch(),
        clientVersion: CLI_VERSION,
        computer: identity,
        displayName: hostname(),
        instanceId,
        logger: runtimeLogger.child({ module: "connection" }),
        platform: currentPlatform,
        tokenProvider,
      });
      const runtime = await createClientRuntime(connection, {
        home,
        clientVersion: CLI_VERSION,
        logger: runtimeLogger,
        signal,
        api,
        tokenProvider,
      });
      void connection.whenRegistered(signal).then(
        () => runtimeLogger.info({}, "Daemon is ready"),
        () => undefined,
      );
      return runtime;
    }, signals);
  } catch (error) {
    const logger =
      terminalLogger ?? (options.logger ?? createLogger("daemon", { destination: "stderr" })).child(baseBindings);
    logTerminalFailure(logger, error);
    failure = error;
    failed = true;
  }

  lifecycleLogger?.info({}, "Daemon stopping");
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
}

export async function runDaemonServiceEntry(options: DaemonRuntimeOptions = {}): Promise<0 | 1> {
  try {
    await runDaemonService(options);
    return 0;
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
    return "Daemon configuration is invalid; run login or inspect daemon status";
  }
  if (error instanceof DaemonOwnerStartupError) {
    return error.code === "BUSY"
      ? "Daemon is already running; inspect daemon status"
      : "Daemon ownership prevented startup; inspect daemon status";
  }
  if (error instanceof RuntimeConnectionError) return "Daemon connection was rejected; run login again";
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
