import { arch, hostname, platform } from "node:os";
import {
  allocateComputerIdentity,
  machineCredentialsPath,
  normalizeServerUrl,
  type OpenTagApi,
  resolveOpenTagHome,
  storeBoundAccountComputer,
  writeComputerIdentityAtomically,
} from "@opentag/client";
import { type AgentRuntimeProvider, withComputerRuntimeProviderSupport } from "@opentag/shared";
import { CLI_VERSION } from "../../build-info.js";
import { resolveCommandContext } from "../command/context.js";
import { redactSecrets } from "../command/policy.js";
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
  agentId?: string;
  /**
   * The exact Runtime of the bound Agent, present only when the Server answered a Client marked
   * with {@link withComputerRuntimeProviderSupport}. Never persisted: the machine credential
   * format is unchanged, and a later exchange re-answers it.
   */
  runtimeProvider?: AgentRuntimeProvider;
  computerId: string;
  credentialsPath: string;
  message: string;
  service?: DaemonServiceInfo;
  /**
   * Redacted daemon service failure after the machine credential was stored. The connection is
   * preserved; the caller must keep reporting `connected` and offer idempotent daemon repair
   * instead of a raw throw that could read as "retry the one-time code".
   */
  serviceError?: string;
}

export async function runComputerConnect(options: ComputerConnectOptions): Promise<ComputerConnectResult> {
  // Validate and mark the Client version before anything consumes the one-time code.
  const clientVersion = withComputerRuntimeProviderSupport(CLI_VERSION);
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
  const api = options.api ?? (await resolveCommandContext({ home, serverUrl })).api;
  if (!api) throw new Error("Command context did not resolve an API");
  const exchange = await api.exchangeComputerConnectCode({
    code: options.code,
    installationId: identity.computerId,
    displayName: hostname(),
    platform: currentPlatform,
    arch: arch(),
    clientVersion,
  });
  await writeComputerIdentityAtomically(home, identity);
  await storeBoundAccountComputer({ ...exchange, serverUrl }, home);
  const result: ComputerConnectResult = {
    agentId: exchange.agentId,
    runtimeProvider: exchange.runtimeProvider,
    computerId: exchange.computerId,
    credentialsPath: machineCredentialsPath(home),
    message: exchange.agentId
      ? `Connected Computer ${exchange.computerId} and bound Agent ${exchange.agentId}`
      : `Connected Computer ${exchange.computerId}`,
  };
  if (!manager) return result;

  try {
    const shouldReload = serviceBefore?.state === "active" || serviceBefore?.state === "unknown";
    const service = shouldReload ? await manager.restart() : await manager.installAndStart();
    return { ...result, service };
  } catch (error) {
    return {
      ...result,
      serviceError:
        redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 512) || "Daemon service failed",
    };
  }
}
