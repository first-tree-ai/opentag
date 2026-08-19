import { resolve } from "node:path";
import { readCredentials, resolveOpenTagHome } from "@opentag/client";
import { createDaemonServiceManager, type DaemonServiceInfo, type DaemonServiceManager } from "./service/index.js";
import { DaemonServiceError } from "./service/types.js";

export type DaemonServiceReconcileResult =
  | {
      action: "installed-or-repaired" | "restarted";
      service: DaemonServiceInfo;
      status: "ready";
    }
  | {
      reason: "credentials-missing" | "unsupported-platform";
      service: DaemonServiceInfo;
      status: "deferred";
    };

export async function reconcileDaemonService(
  options: { createManager?: () => Promise<DaemonServiceManager>; hasCredentials?: () => Promise<boolean> } = {},
): Promise<DaemonServiceReconcileResult> {
  const manager = await (options.createManager ?? createDaemonServiceManager)();
  const current = await manager.status();
  if (current.platform === "unsupported") {
    return { reason: "unsupported-platform", service: current, status: "deferred" };
  }

  const hasCredentials =
    options.hasCredentials ?? (async () => Boolean(await readCredentials(resolve(resolveOpenTagHome(process.env)))));
  if (!(await hasCredentials())) {
    return { reason: "credentials-missing", service: current, status: "deferred" };
  }

  const shouldRestart = current.state === "active" && current.drifted === false;
  const service = shouldRestart ? await manager.restart() : await manager.installAndStart();
  if (service.state !== "active") {
    throw new DaemonServiceError(
      "OPERATION_FAILED",
      `Daemon service ${service.serviceId} was reconciled but is ${service.state}`,
    );
  }
  return { action: shouldRestart ? "restarted" : "installed-or-repaired", service, status: "ready" };
}
