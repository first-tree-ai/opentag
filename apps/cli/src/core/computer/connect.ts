import { arch, hostname, platform } from "node:os";
import {
  allocateComputerIdentity,
  machineCredentialsPath,
  normalizeServerUrl,
  type OpenTagApi,
  readComputerIdentity,
  readMachineCredentials,
  resolveOpenTagHome,
  storeBoundAccountComputer,
  writeComputerIdentityAtomically,
} from "@opentag/client";
import {
  type AgentRuntimeProvider,
  type ComputerConnectOutcome,
  withComputerRuntimeProviderSupport,
} from "@opentag/shared";
import { CLI_VERSION } from "../../build-info.js";
import { resolveCommandContext } from "../command/context.js";
import { CommandError, redactSecrets } from "../command/policy.js";
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
  /** The Computer a repair command restores; the run stops before the code is used on another machine. */
  expectedComputerId?: string;
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
  /** What the Server did; absent when an older Server did not report it. */
  outcome?: ComputerConnectOutcome;
  service?: DaemonServiceInfo;
  /**
   * Redacted daemon service failure after the machine credential was stored. The connection is
   * preserved; the caller must keep reporting `connected` and offer idempotent daemon repair
   * instead of a raw throw that could read as "retry the one-time code".
   */
  serviceError?: string;
  /** Server exchange committed, but local files must be recovered before starting the daemon. */
  persistenceError?: {
    stage: "credentials" | "identity";
    installationId: string;
    message: string;
  };
}

export async function runComputerConnect(options: ComputerConnectOptions): Promise<ComputerConnectResult> {
  // Validate and mark the Client version before anything consumes the one-time code.
  const clientVersion = withComputerRuntimeProviderSupport(CLI_VERSION);
  const home = options.home ?? resolveOpenTagHome();
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const currentPlatform = supportedPlatform();
  await assertExpectedComputer(home, serverUrl, options.expectedComputerId);
  const manager = options.noStart ? undefined : (options.manager ?? (await createDaemonServiceManager({ home })));
  await manager?.preflight();
  const serviceBefore = await manager?.status();
  const identity = await resolveInstallationIdentity(home, serverUrl);
  const displayName = hostname();
  const api = options.api ?? (await resolveCommandContext({ home, serverUrl })).api;
  if (!api) throw new Error("Command context did not resolve an API");
  const exchange = await api.exchangeComputerConnectCode({
    code: options.code,
    installationId: identity.computerId,
    displayName,
    platform: currentPlatform,
    arch: arch(),
    clientVersion,
    ...(await currentMachineTokenField(home, serverUrl)),
    reportOutcome: true,
  });
  const result: ComputerConnectResult = {
    agentId: exchange.agentId,
    runtimeProvider: exchange.runtimeProvider,
    computerId: exchange.computerId,
    credentialsPath: machineCredentialsPath(home),
    message: connectedMessage(displayName, exchange.agentId, exchange.outcome),
    ...(exchange.outcome ? { outcome: exchange.outcome } : {}),
  };
  if (exchange.outcome === "already_connected" || exchange.machineToken === undefined) {
    return ensureServiceWithoutChange(result, manager, serviceBefore);
  }
  let stage: "credentials" | "identity" = "credentials";
  try {
    // Save the non-reconstructable token first. Identity is derivable from this credential, so
    // repair-local can finish a partial write (including a crash or an error after rename).
    // These are two durable file writes, not an atomic transaction; never roll back to a token
    // that the committed exchange may already have revoked.
    await storeBoundAccountComputer(
      {
        computerId: exchange.computerId,
        installationId: exchange.installationId,
        machineToken: exchange.machineToken,
        serverUrl,
      },
      home,
    );
    stage = "identity";
    await writeComputerIdentityAtomically(home, identity);
  } catch (error) {
    return {
      ...result,
      message: `Connected this computer (${displayName}) on the openTag server, but could not save its credentials here; local persistence is incomplete.`,
      persistenceError: {
        stage,
        installationId: identity.computerId,
        message: safeFailureMessage(error, "Local write failed", exchange.machineToken),
      },
    };
  }
  if (!manager) return result;

  try {
    const shouldReload = serviceBefore?.state === "active" || serviceBefore?.state === "unknown";
    const service = shouldReload ? await manager.restart() : await manager.installAndStart();
    return { ...result, service };
  } catch (error) {
    return {
      ...result,
      serviceError: safeFailureMessage(error, "Daemon service failed", exchange.machineToken),
    };
  }
}

/**
 * Rerunning connect on the same home keeps its installation identity, so the Server can recognize this
 * machine (already connected, repair in place, or another Account) instead of adding a Computer.
 */
async function resolveInstallationIdentity(home: string, serverUrl: string) {
  const existing = await readComputerIdentity(home);
  if (existing && existing.serverUrl === serverUrl) {
    return { version: 2 as const, computerId: existing.computerId, serverUrl };
  }
  return allocateComputerIdentity(home, serverUrl);
}

/**
 * Nothing changed on the Server, so local credentials stay as they are; only make sure the daemon
 * service is running, without restarting a healthy one.
 */
async function ensureServiceWithoutChange(
  result: ComputerConnectResult,
  manager: DaemonServiceManager | undefined,
  serviceBefore: DaemonServiceInfo | undefined,
): Promise<ComputerConnectResult> {
  if (!manager || serviceBefore?.state === "active") {
    return serviceBefore ? { ...result, service: serviceBefore } : result;
  }
  try {
    return { ...result, service: await manager.installAndStart() };
  } catch (error) {
    return { ...result, serviceError: safeFailureMessage(error, "Daemon service failed", "") };
  }
}

function supportedPlatform(): "darwin" | "linux" | "win32" {
  const current = platform();
  if (current !== "darwin" && current !== "linux" && current !== "win32") {
    throw new Error(`Unsupported Computer platform: ${current}`);
  }
  return current;
}

/**
 * The stored token for this Server, if any, as an exchange field. An unreadable credentials file is
 * treated as having none: the exchange then repairs or creates instead of reporting already connected.
 */
/**
 * A repair command names the Computer it restores. When this home is connected to a different Computer
 * on the same Server, the command was pasted on the wrong machine: stop before using the code. A home
 * with no connection (its identity was lost) may be that Computer, so it continues.
 */
async function assertExpectedComputer(home: string, serverUrl: string, expected: string | undefined): Promise<void> {
  if (!expected) return;
  const stored = await readMachineCredentials(home).catch(() => undefined);
  if (!stored || stored.computer.serverUrl !== serverUrl || stored.computer.computerId === expected) return;
  throw new CommandError(
    { code: "COMPUTER_TARGET_MISMATCH", category: "conflict", retryability: "never", phase: "validation" },
    "This command restores a different computer than this one",
  );
}

async function currentMachineTokenField(home: string, serverUrl: string): Promise<{ machineToken?: string }> {
  try {
    const stored = await readMachineCredentials(home);
    return stored?.computer.serverUrl === serverUrl ? { machineToken: stored.computer.machineToken } : {};
  } catch {
    return {};
  }
}

/**
 * One line in plain language, the same for every outcome: whether the Server created, repaired, or
 * found the computer already connected is internal detail kept in the structured result and `--json`.
 */
function connectedMessage(displayName: string, agentId: string | undefined, _outcome?: ComputerConnectOutcome): string {
  return `Connected this computer (${displayName}) to openTag${agentId ? " and bound the Agent to it" : ""}.`;
}

function safeFailureMessage(error: unknown, fallback: string, machineToken: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (machineToken) message = message.replaceAll(machineToken, "[REDACTED]");
  return redactSecrets(message).trim().slice(0, 512) || fallback;
}
