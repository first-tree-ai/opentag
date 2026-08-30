import { arch, hostname, platform } from "node:os";
import {
  allocateComputerIdentity,
  machineCredentialsPath,
  normalizeServerUrl,
  OpenTagApi,
  resolveOpenTagHome,
  storeMachineEnrollmentCredential,
  writeComputerIdentityAtomically,
} from "@opentag/client";
import { CLI_VERSION } from "../../build-info.js";
import {
  createDaemonServiceManager,
  type DaemonServiceInfo,
  type DaemonServiceManager,
} from "../daemon/service/index.js";

export interface ComputerConnectOptions {
  api?: Pick<OpenTagApi, "exchangeComputerConnectCode">;
  code: string;
  home?: string;
  manager?: DaemonServiceManager;
  noStart?: boolean;
  serverUrl: string;
}

export interface ComputerConnectResult {
  credentialsPath: string;
  message: string;
  service?: DaemonServiceInfo;
}

export class ComputerConnectServiceInstallError extends Error {
  override readonly name = "ComputerConnectServiceInstallError";

  constructor(
    readonly connectResult: ComputerConnectResult,
    options?: ErrorOptions,
  ) {
    super("Computer connection succeeded, but the daemon service could not be reloaded", options);
  }
}

export async function runComputerConnect(options: ComputerConnectOptions): Promise<ComputerConnectResult> {
  const home = options.home ?? resolveOpenTagHome();
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const currentPlatform = platform();
  if (currentPlatform !== "darwin" && currentPlatform !== "linux" && currentPlatform !== "win32") {
    throw new Error(`Unsupported Computer platform: ${currentPlatform}`);
  }
  const manager = options.noStart ? undefined : (options.manager ?? (await createDaemonServiceManager({ home })));
  await manager?.preflight();
  const serviceBefore = await manager?.status();
  const identity = await allocateComputerIdentity(home, serverUrl);
  const api = options.api ?? new OpenTagApi(serverUrl);
  const enrollment = await api.exchangeComputerConnectCode({
    code: options.code,
    computerId: identity.computerId,
    displayName: hostname(),
    platform: currentPlatform,
    arch: arch(),
    clientVersion: CLI_VERSION,
  });
  await writeComputerIdentityAtomically(home, identity);
  await storeMachineEnrollmentCredential({ ...enrollment, serverUrl }, home);
  const result: ComputerConnectResult = {
    credentialsPath: machineCredentialsPath(home),
    message: "Connected this Computer",
  };
  if (!manager) return result;

  try {
    const shouldReload = serviceBefore?.state === "active" || serviceBefore?.state === "unknown";
    return { ...result, service: shouldReload ? await manager.restart() : await manager.installAndStart() };
  } catch (error) {
    throw new ComputerConnectServiceInstallError(result, { cause: error });
  }
}
