import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { readMachineCredentials, resolveOpenTagHome } from "@opentag/client";
import { getChannelConfig } from "@opentag/shared";
import { CHANNEL } from "../../../build-info.js";
import { channelConfig } from "../../channel/config.js";
import { inspectDaemonOwner } from "../ownership.js";
import { createLaunchdBackend } from "./launchd.js";
import {
  acquireServiceOperationLease,
  acquireServiceTargetLease,
  canonicalizeServiceHome,
  defaultServiceRunner,
  preflightHomeDirectory,
  resolveCliInvocation,
} from "./shared.js";
import { createSystemdBackend } from "./systemd.js";
import type {
  DaemonServiceBackend,
  DaemonServiceInfo,
  DaemonServicePlatform,
  ResolvedCliInvocation,
  RuntimeOwnerInfo,
  ServiceRunner,
} from "./types.js";
import { DaemonServiceError } from "./types.js";

export interface DaemonServiceManager {
  installAndStart(): Promise<DaemonServiceInfo>;
  preflight(): Promise<void>;
  restart(): Promise<DaemonServiceInfo>;
  start(): Promise<DaemonServiceInfo>;
  status(): Promise<DaemonServiceInfo>;
  stop(): Promise<DaemonServiceInfo>;
  uninstall(): Promise<DaemonServiceInfo>;
}

export interface CreateDaemonServiceManagerOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  invocation?: ResolvedCliInvocation;
  platform?: NodeJS.Platform;
  runner?: ServiceRunner;
  uid?: number;
  userHome?: string;
  username?: string;
}

type DaemonServiceMutation = "install" | "restart" | "start" | "stop" | "uninstall";

export async function createDaemonServiceManager(
  options: CreateDaemonServiceManagerOptions = {},
): Promise<DaemonServiceManager> {
  const environment = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = await canonicalizeServiceHome(resolve(options.home ?? resolveOpenTagHome(environment)));
  const runner = options.runner ?? defaultServiceRunner;
  const userHome = await canonicalizeServiceHome(resolve(options.userHome ?? homedir()));
  const channelDefaultHome = await canonicalizeServiceHome(getChannelConfig(CHANNEL, userHome).defaultHome);
  const invocation =
    options.invocation ??
    (platform === "darwin" || platform === "linux"
      ? await resolveCliInvocation({ binName: channelConfig.binName, env: options.env })
      : { args: [], program: process.execPath });
  const uid = options.uid ?? userInfo().uid;
  const backend = createBackend({
    env: options.env,
    home,
    invocation,
    platform,
    runner,
    sourcePath: environment.PATH,
    uid,
    userHome,
    username: options.username,
  });

  const status = async (): Promise<DaemonServiceInfo> => attachOwner(await backend.status(), home);
  const preflight = async (): Promise<void> => {
    await preflightHomeDirectory(home);
    await backend.preflight();
  };
  const mutate = async (
    mutation: DaemonServiceMutation,
    operation: () => Promise<DaemonServiceInfo>,
  ): Promise<DaemonServiceInfo> => {
    const targetLease = await acquireServiceTargetLease(channelDefaultHome, channelConfig.serviceId);
    let lease: Awaited<ReturnType<typeof acquireServiceOperationLease>> | undefined;
    try {
      lease = await acquireServiceOperationLease(home);
      const before = await backend.status();
      await assertConfiguredHome(before, home);
      await assertOwnerConsistency(before, home, mutation);
      const current = await attachOwner(await operation(), home);
      await assertMutationHomePostcondition(mutation, current, home);
      if (mutation === "stop") assertStopPostcondition(current);
      return current;
    } finally {
      try {
        await lease?.release();
      } finally {
        await targetLease.release();
      }
    }
  };

  return {
    preflight,
    async installAndStart() {
      await preflight();
      let credentials: Awaited<ReturnType<typeof readMachineCredentials>>;
      try {
        credentials = await readMachineCredentials(home);
      } catch (error) {
        throw new DaemonServiceError(
          "CONFIGURATION",
          "OpenTag Computer credentials are invalid; run computer connect again",
          { cause: error },
        );
      }
      if (!credentials?.enrollments.length) {
        throw new DaemonServiceError("CONFIGURATION", "This Computer is not enrolled; run computer connect first");
      }
      return mutate("install", () => backend.installAndStart());
    },
    start: () => mutate("start", () => backend.start()),
    stop: () => mutate("stop", () => backend.stop()),
    restart: () => mutate("restart", () => backend.restart()),
    status,
    uninstall: () => mutate("uninstall", () => backend.uninstall()),
  };
}

async function assertMutationHomePostcondition(
  mutation: DaemonServiceMutation,
  info: DaemonServiceInfo,
  requestedHome: string,
): Promise<void> {
  if (mutation === "uninstall" && info.state === "not-installed") return;
  await assertConfiguredHome(info, requestedHome);
}

async function assertConfiguredHome(info: DaemonServiceInfo, requestedHome: string): Promise<void> {
  if (info.state === "not-installed") return;
  if (!info.configuredHome) {
    throw new DaemonServiceError(
      "CONFIGURATION",
      `The installed ${info.platform} service does not expose a verifiable OPENTAG_HOME; refusing mutation`,
    );
  }
  const configuredHome = await canonicalizeServiceHome(info.configuredHome);
  if (configuredHome !== requestedHome) {
    throw new DaemonServiceError(
      "CONFIGURATION",
      `The installed ${info.platform} service belongs to a different OpenTag home (${configuredHome}); use that OPENTAG_HOME`,
    );
  }
}

export function formatDaemonServiceInfo(info: DaemonServiceInfo): string {
  const lines = [
    `Service: ${info.serviceId}`,
    `Platform: ${info.platform}`,
    `State: ${info.state}`,
    ...(info.pid ? [`PID: ${info.pid}`] : []),
    ...(info.configuredHome ? [`Home: ${info.configuredHome}`] : []),
    `Current home: ${info.currentHome}`,
    `Definition: ${info.definitionPath}`,
    `Logs: ${info.logHint}`,
    `Configuration: ${info.drifted ? "drifted" : "current"}`,
    `Runtime owner: ${formatRuntimeOwner(info.runtimeOwner)}`,
    ...(info.detail ? [`Detail: ${info.detail}`] : []),
  ];
  return lines.join("\n");
}

function createBackend(options: {
  env?: NodeJS.ProcessEnv;
  home: string;
  invocation: ResolvedCliInvocation;
  platform: NodeJS.Platform;
  runner: ServiceRunner;
  sourcePath?: string;
  uid: number;
  userHome: string;
  username?: string;
}): DaemonServiceBackend {
  if (options.platform === "linux") {
    return createSystemdBackend({
      home: options.home,
      invocation: options.invocation,
      runner: options.runner,
      serviceId: channelConfig.serviceId,
      ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
      uid: options.uid,
      userHome: options.userHome,
      ...(options.username ? { username: options.username } : {}),
      ...(options.env?.XDG_CONFIG_HOME ? { xdgConfigHome: options.env.XDG_CONFIG_HOME } : {}),
    });
  }
  if (options.platform === "darwin") {
    return createLaunchdBackend({
      home: options.home,
      invocation: options.invocation,
      runner: options.runner,
      serviceId: channelConfig.serviceId,
      ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
      uid: options.uid,
      userHome: options.userHome,
    });
  }
  return unsupportedBackend(options.platform, options.home, channelConfig.serviceId);
}

function unsupportedBackend(platform: NodeJS.Platform, home: string, serviceId: string): DaemonServiceBackend {
  const unsupported = async (): Promise<never> => {
    throw new DaemonServiceError(
      "UNSUPPORTED_PLATFORM",
      `OpenTag v0.1 daemon service supports Linux and macOS only (current platform: ${platform})`,
    );
  };
  return {
    platform: "unsupported",
    preflight: unsupported,
    installAndStart: unsupported,
    start: unsupported,
    stop: unsupported,
    restart: unsupported,
    uninstall: unsupported,
    async status() {
      return {
        currentHome: home,
        definitionPath: "<unsupported>",
        detail: `Daemon service is unsupported on ${platform}`,
        drifted: true,
        logHint: "<unsupported>",
        platform: "unsupported",
        serviceId,
        state: "unknown",
      };
    },
  };
}

async function attachOwner(info: DaemonServiceInfo, home: string): Promise<DaemonServiceInfo> {
  const runtimeOwner = await ownerInfo(info, home);
  return { ...info, runtimeOwner };
}

async function assertOwnerConsistency(
  info: DaemonServiceInfo,
  home: string,
  mutation: DaemonServiceMutation,
): Promise<void> {
  const owner = await ownerInfo(info, home);
  if (owner.consistency === "malformed") {
    throw new DaemonServiceError("CONFIGURATION", "The daemon owner record is malformed; refusing service mutation");
  }
  if (owner.consistency === "unmanaged") {
    throw new DaemonServiceError(
      "CONFIGURATION",
      `A daemon process exists outside the expected ${info.platform} service state (pid ${owner.pid})`,
    );
  }
  if (owner.consistency === "unverified" && mutation !== "stop") {
    throw new DaemonServiceError(
      "CONFIGURATION",
      `The ${info.platform} service PID could not be verified while a live daemon owns this home; run daemon stop before ${mutation}`,
    );
  }
}

function assertStopPostcondition(info: DaemonServiceInfo): void {
  if (info.state !== "inactive" && info.state !== "not-installed") {
    throw new DaemonServiceError("OPERATION_FAILED", `The ${info.platform} service did not reach a stopped state`);
  }
  if (!info.runtimeOwner || !["missing", "stale"].includes(info.runtimeOwner.consistency)) {
    const ownerDetail = info.runtimeOwner?.pid ? ` (pid ${info.runtimeOwner.pid})` : "";
    throw new DaemonServiceError(
      "OPERATION_FAILED",
      `The ${info.platform} service stopped but a live or unverifiable daemon still owns this home${ownerDetail}`,
    );
  }
}

async function ownerInfo(info: DaemonServiceInfo, home: string): Promise<RuntimeOwnerInfo> {
  let inspection: Awaited<ReturnType<typeof inspectDaemonOwner>>;
  try {
    inspection = await inspectDaemonOwner(home);
  } catch {
    return { consistency: "malformed" };
  }
  if (inspection.state === "missing") return { consistency: "missing" };
  if (inspection.state === "stale") return { consistency: "stale", pid: inspection.record.pid };
  if (info.state === "unknown") return { consistency: "unverified", pid: inspection.record.pid };
  if (info.state === "active" && info.pid === inspection.record.pid) {
    return { consistency: "consistent", pid: inspection.record.pid };
  }
  return { consistency: "unmanaged", pid: inspection.record.pid };
}

function formatRuntimeOwner(owner: RuntimeOwnerInfo | undefined): string {
  if (!owner) return "missing";
  return owner.pid ? `${owner.pid}/${owner.consistency}` : owner.consistency;
}

export { DaemonServiceError } from "./types.js";
export type { DaemonServiceInfo, DaemonServicePlatform };
