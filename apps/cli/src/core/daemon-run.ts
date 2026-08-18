import { randomUUID } from "node:crypto";
import { arch, hostname, platform } from "node:os";
import {
  AccessTokenProvider,
  ClientRuntime,
  OpenTagApi,
  RuntimeConnection,
  readCredentials,
  resolveComputerIdentity,
  resolveOpenTagHome,
} from "@opentag/client";
import { CLI_VERSION } from "../build-info.js";
import { acquireDaemonOwner } from "./daemon-owner.js";

export interface DaemonRunOptions {
  home?: string;
  log?: (message: string) => void;
  signals?: NodeJS.Process;
}

export async function runDaemon(options: DaemonRunOptions = {}): Promise<void> {
  const home = options.home ?? resolveOpenTagHome();
  const log = options.log ?? console.log;
  const signals = options.signals ?? process;
  const instanceId = randomUUID();
  const ownership = await acquireDaemonOwner(home, instanceId);
  let runtime: ClientRuntime | undefined;
  const stop = () => runtime?.stop();
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);
  try {
    const credentials = await readCredentials(home);
    if (!credentials) throw new Error("OpenTag is not logged in; run login first");
    const tokenProvider = new AccessTokenProvider({ home });
    const lease = await tokenProvider.getAccessTokenLease();
    const me = await new OpenTagApi(credentials.serverUrl).me(lease.accessToken);
    const identity = await resolveComputerIdentity(home, credentials.serverUrl, me.user.id);
    const currentPlatform = platform();
    if (currentPlatform !== "darwin" && currentPlatform !== "linux" && currentPlatform !== "win32") {
      throw new Error(`Unsupported Computer platform: ${currentPlatform}`);
    }
    runtime = new ClientRuntime(
      new RuntimeConnection({
        arch: arch(),
        clientVersion: CLI_VERSION,
        computer: identity,
        displayName: hostname(),
        log,
        platform: currentPlatform,
        tokenProvider,
      }),
    );
    await runtime.run();
  } finally {
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
    await ownership.release();
  }
}
