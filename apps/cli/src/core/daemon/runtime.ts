import { randomUUID } from "node:crypto";
import { arch, hostname, platform } from "node:os";
import {
  AccessTokenProvider,
  createCodexClientRuntime,
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
import { DaemonServiceError } from "./service/types.js";

export interface DaemonRuntimeOptions {
  home?: string;
  log?: (message: string) => void;
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
  const log = options.log ?? console.log;
  const signals = options.signals ?? process;
  await applyDaemonEnvironment(home, process.env, log);
  const instanceId = randomUUID();
  const ownership = await acquireDaemonOwner(home, instanceId);
  try {
    await runDaemonLifecycle(async (signal) => {
      let credentials: Awaited<ReturnType<typeof readCredentials>>;
      try {
        credentials = await readCredentials(home);
      } catch (error) {
        throw new DaemonRuntimeConfigurationError("OpenTag credentials are invalid; run login again", { cause: error });
      }
      signal.throwIfAborted();
      if (!credentials) throw new DaemonRuntimeConfigurationError("OpenTag is not logged in; run login first");
      const tokenProvider = new AccessTokenProvider({ home });
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
        me = await new OpenTagApi(credentials.serverUrl).me(lease.accessToken);
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
      const currentPlatform = platform();
      if (currentPlatform !== "darwin" && currentPlatform !== "linux") {
        throw new DaemonRuntimeConfigurationError(`Unsupported daemon service platform: ${currentPlatform}`);
      }
      const connection = new RuntimeConnection({
        arch: arch(),
        clientVersion: CLI_VERSION,
        computer: identity,
        displayName: hostname(),
        instanceId,
        log,
        platform: currentPlatform,
        tokenProvider,
      });
      return createCodexClientRuntime(connection, { home, clientVersion: CLI_VERSION, log, signal });
    }, signals);
  } finally {
    await ownership.release();
  }
}

export async function runDaemonServiceEntry(options: DaemonRuntimeOptions = {}): Promise<0 | 1> {
  const log = options.log ?? console.error;
  try {
    await runDaemonService(options);
    return 0;
  } catch (error) {
    if (
      error instanceof DaemonRuntimeConfigurationError ||
      error instanceof DaemonOwnerStartupError ||
      (error instanceof RuntimeConnectionError && error.fatal) ||
      (error instanceof DaemonServiceError && ["CONFIGURATION", "UNSUPPORTED_PLATFORM"].includes(error.code))
    ) {
      log(error.message);
      return 0;
    }
    log("The OpenTag daemon stopped because of an unexpected internal failure");
    return 1;
  }
}
