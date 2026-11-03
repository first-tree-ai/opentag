import { randomUUID } from "node:crypto";
import type { SessionReconcileResult } from "@opentag/shared";
import type { DatabaseClient } from "../db/client.js";
import type { AgentSessionStopTarget } from "../services/agents/index.js";
import type { CloudDeliveryOwner } from "../services/sandboxes/cloud-delivery-owner.js";
import type { CloudSessionCollaborationOwner } from "../services/sandboxes/cloud-session-collaboration-owner.js";
import { withAgentSessionStopAuthority } from "./agent-session-stop-authority.js";
import { type RuntimeDispatchAdmission, RuntimeDomainRequestError } from "./runtime-domain-owner.js";

const LOCAL_STOP_CONCURRENCY = 16;
const LOCAL_STOP_DISPATCH_BUDGET_MS = 30_000;

interface AgentSessionStopDependencies {
  currentInstanceId(computerId: string): string | undefined;
  requestReconcile(
    computerId: string,
    instanceId: string,
    request: {
      type: "session:reconcile";
      requestId: string;
      installationId: string;
      sessionId: string;
      agentId: string;
      placementGeneration: number;
      desired: "stopped";
    },
    onDispatched?: () => void,
    admission?: RuntimeDispatchAdmission<SessionReconcileResult>,
    signal?: AbortSignal,
  ): Promise<SessionReconcileResult>;
}

export type { AgentSessionStopDependencies };

export async function stopAgentSessions(
  database: DatabaseClient,
  targets: AgentSessionStopTarget[],
  dependencies: AgentSessionStopDependencies,
): Promise<void> {
  if (targets.length === 0) return;
  const signal = AbortSignal.timeout(LOCAL_STOP_DISPATCH_BUDGET_MS);
  let nextTargetIndex = 0;
  let failed = false;
  let atCapacity = false;
  async function stopTarget(target: AgentSessionStopTarget): Promise<void> {
    let superseded = false;
    try {
      const instanceId = dependencies.currentInstanceId(target.computerId);
      if (!instanceId) return;
      const admission: RuntimeDispatchAdmission<SessionReconcileResult> = async (enqueue) => {
        signal.throwIfAborted();
        const admitted = await withAgentSessionStopAuthority(database, target, async () => {
          const result = enqueue(() => undefined);
          void result.catch(() => undefined);
          return { admitted: true, result } as const;
        });
        superseded = !admitted;
        return admitted ?? { admitted: false };
      };
      const result = await dependencies.requestReconcile(
        target.computerId,
        instanceId,
        {
          type: "session:reconcile",
          requestId: randomUUID(),
          installationId: target.installationId,
          sessionId: target.sessionId,
          agentId: target.agentId,
          placementGeneration: target.placementGeneration,
          desired: "stopped",
        },
        undefined,
        admission,
        signal,
      );
      if (result.status !== "stopped") failed = true;
    } catch (error) {
      if (superseded) return;
      failed = true;
      if (error instanceof RuntimeDomainRequestError && error.code === "capacity") atCapacity = true;
    }
  }
  async function runWorker(): Promise<void> {
    while (!signal.aborted && !atCapacity) {
      const target = targets[nextTargetIndex++];
      if (!target) return;
      await stopTarget(target);
    }
  }
  await Promise.all(Array.from({ length: Math.min(LOCAL_STOP_CONCURRENCY, targets.length) }, runWorker));
  if (failed || nextTargetIndex < targets.length) throw new Error("Agent runtime stop notification failed");
}

/** Surface non-cancelled stop outcomes without turning a best-effort cancel into a hard failure. */
function reportCloudStopOutcomes(
  outcomes: Awaited<ReturnType<CloudDeliveryOwner["cancelSessionDeliveries"]>>,
  onDiagnostic?: (code: string) => void,
): void {
  for (const outcome of outcomes) {
    // A cancelled owning turn needs no diagnostic; a lost socket or a failed frame send stays
    // explicitly visible instead of being swallowed as "best effort".
    if (outcome.status === "cancelled") continue;
    onDiagnostic?.(
      outcome.status === "no_connection" ? "CLOUD_DELIVERY_STOP_NO_CONNECTION" : "CLOUD_DELIVERY_STOP_SEND_FAILED",
    );
  }
}

/**
 * Explicit Session stop for Cloud Sessions cancels the in-flight Cloud turn on its owning Runner
 * (best-effort; the cancellation report still flows through the durable report path) before the
 * Local reconcile-based stop runs. Cloud cancel failures never block the Local stop path.
 */
export async function stopCloudThenLocalAgentSessions(
  database: DatabaseClient,
  targets: AgentSessionStopTarget[],
  cloudDelivery: CloudDeliveryOwner | undefined,
  dependencies: AgentSessionStopDependencies,
  onDiagnostic?: (code: string) => void,
  cloudSession?: CloudSessionCollaborationOwner,
): Promise<void> {
  if (cloudDelivery) {
    for (const target of targets) {
      try {
        reportCloudStopOutcomes(await cloudDelivery.cancelSessionDeliveries(target.sessionId, target), onDiagnostic);
      } catch {
        // The cancel path itself failed; Local stop and Runner scope invalidation still proceed.
        onDiagnostic?.("CLOUD_DELIVERY_STOP_FAILED");
      }
    }
  }
  for (const target of targets) {
    try {
      const outcomes = await cloudSession?.cancelSessionMessages(target.sessionId, target);
      for (const outcome of outcomes ?? []) {
        if (outcome.status !== "requested") onDiagnostic?.("CLOUD_SESSION_STOP_UNCONFIRMED");
      }
    } catch {
      onDiagnostic?.("CLOUD_SESSION_STOP_FAILED");
    }
  }
  await stopAgentSessions(database, targets, dependencies);
}
