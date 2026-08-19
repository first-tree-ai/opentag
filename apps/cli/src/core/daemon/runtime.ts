import { randomUUID } from "node:crypto";
import { arch, hostname, platform } from "node:os";
import {
  AccessTokenProvider,
  createCodexClientRuntime,
  OpenTagApi,
  RuntimeConnection,
  readCredentials,
  resolveComputerIdentity,
  resolveOpenTagHome,
} from "@opentag/client";
import { CLI_VERSION } from "../../build-info.js";
import { acquireDaemonOwner } from "./ownership.js";

export interface DaemonRunOptions {
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

export async function runDaemon(options: DaemonRunOptions = {}): Promise<void> {
  const home = options.home ?? resolveOpenTagHome();
  const log = options.log ?? console.log;
  const signals = options.signals ?? process;
  const instanceId = randomUUID();
  const ownership = await acquireDaemonOwner(home, instanceId);
  try {
    await runDaemonLifecycle(async (signal) => {
      const credentials = await readCredentials(home);
      signal.throwIfAborted();
      if (!credentials) throw new Error("OpenTag is not logged in; run login first");
      const tokenProvider = new AccessTokenProvider({ home });
      const lease = await tokenProvider.getAccessTokenLease();
      signal.throwIfAborted();
      const me = await new OpenTagApi(credentials.serverUrl).me(lease.accessToken);
      signal.throwIfAborted();
      const identity = await resolveComputerIdentity(home, credentials.serverUrl, me.user.id);
      signal.throwIfAborted();
      const currentPlatform = platform();
      if (currentPlatform !== "darwin" && currentPlatform !== "linux" && currentPlatform !== "win32") {
        throw new Error(`Unsupported Computer platform: ${currentPlatform}`);
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
