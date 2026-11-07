import type { EffectiveRuntimeSnapshot } from "@opentag/shared";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { CloudModelGrantPort } from "./cloud-delivery-owner.js";
import type { CloudConnectionRecord, CloudRuntimeFence } from "./cloud-runtime-fence.js";
import type { RunnerControlSocket, RunnerHub } from "./runner-hub.js";

export function isExactCloudConnection(fence: CloudRuntimeFence, connection: CloudConnectionRecord): boolean {
  return fence.isCurrent(connection.computerId, connection.instanceId, connection.connectionId);
}

export function cloudConnectionSocket(
  fence: CloudRuntimeFence,
  hub: RunnerHub,
  connection: CloudConnectionRecord,
): RunnerControlSocket | undefined {
  if (fence.connectionForSandbox(connection.scope.sandboxId)?.connectionId !== connection.connectionId)
    return undefined;
  if (connection.socket)
    return hub.isCurrent(connection.scope.sandboxId, connection.socket) ? connection.socket : undefined;
  // Recovery snapshots have no socket; the exact fence entry must still own the Sandbox.
  return hub.currentSocket(connection.scope.sandboxId);
}

export function sendToCloudConnection(
  fence: CloudRuntimeFence,
  hub: RunnerHub,
  connection: CloudConnectionRecord,
  frame: Parameters<RunnerHub["sendToCurrent"]>[2],
): boolean {
  const socket = cloudConnectionSocket(fence, hub, connection);
  return socket ? hub.sendToCurrent(connection.scope.sandboxId, socket, frame) : false;
}

export async function resolveCloudRuntimeModel(
  runtime: EffectiveRuntimeSnapshot,
  grants: CloudModelGrantPort | undefined,
  modelBaseUrl: string | undefined,
): Promise<EffectiveRuntimeSnapshot | undefined> {
  if (!grants || !modelBaseUrl) return undefined;
  if (runtime.model) return (await grants.isModelAllowed(runtime.model)) ? runtime : undefined;
  const fallback = await grants.defaultModel();
  return fallback ? { ...runtime, model: fallback } : undefined;
}

export function revokeCloudModelGrant(grants: CloudModelGrantPort | undefined, turnId: string): void {
  grants?.revokeExecution(turnId);
}

export async function recordCloudActivity(
  sandboxId: string,
  note: ((sandboxId: string) => Promise<void>) | undefined,
  logger: Pick<ServiceLogger, "warn"> | undefined,
  code: "CLOUD_DELIVERY_ACTIVITY_TOUCH_FAILED" | "CLOUD_SESSION_ACTIVITY_TOUCH_FAILED",
): Promise<void> {
  if (!note) return;
  try {
    await note(sandboxId);
  } catch {
    logger?.warn({ code, sandboxId }, "Sandbox business-activity clock update failed");
  }
}
