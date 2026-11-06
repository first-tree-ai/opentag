import { randomUUID } from "node:crypto";
import type { SessionCliStopExecution, SessionReconcileResult } from "@opentag/shared";
import type { DatabaseClient } from "../db/client.js";
import type { AgentSessionStopTarget } from "../services/agents/index.js";
import type { CloudDeliveryOwner } from "../services/sandboxes/cloud-delivery-owner.js";
import type { CloudSessionCollaborationOwner } from "../services/sandboxes/cloud-session-collaboration-owner.js";
import type { InternalSessionStopTarget } from "../services/sessions/index.js";
import { withAgentSessionStopAuthority, withEndedSessionStopAuthority } from "./agent-session-stop-authority.js";
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
      sessionKind?: "internal";
      creatorSessionId?: string;
      desired: "stopped";
    },
    onDispatched?: () => void,
    admission?: RuntimeDispatchAdmission<SessionReconcileResult>,
    signal?: AbortSignal,
  ): Promise<SessionReconcileResult>;
}

export type { AgentSessionStopDependencies };

type LocalStopOutcome = "stopped" | "busy" | "offline" | "failed" | "superseded";
type LocalStopTarget = Omit<AgentSessionStopTarget, "agentRevision">;
type StopAuthority<Target> = (
  target: Target,
  enqueue: () => Promise<{ admitted: true; result: Promise<SessionReconcileResult> }>,
) => Promise<{ admitted: true; result: Promise<SessionReconcileResult> } | undefined>;

/** Runs stop reconciles within one bounded dispatch window; a target past the window has no outcome. */
async function dispatchLocalStops<Target extends LocalStopTarget>(
  targets: Target[],
  dependencies: AgentSessionStopDependencies,
  authority: StopAuthority<Target>,
  frameFields: (target: Target) => { sessionKind?: "internal"; creatorSessionId?: string },
): Promise<Map<string, LocalStopOutcome>> {
  const outcomes = new Map<string, LocalStopOutcome>();
  const signal = AbortSignal.timeout(LOCAL_STOP_DISPATCH_BUDGET_MS);
  let nextTargetIndex = 0;
  let atCapacity = false;
  async function stopTarget(target: Target): Promise<LocalStopOutcome> {
    let superseded = false;
    try {
      const instanceId = dependencies.currentInstanceId(target.computerId);
      if (!instanceId) return "offline";
      const admission: RuntimeDispatchAdmission<SessionReconcileResult> = async (enqueue) => {
        signal.throwIfAborted();
        const admitted = await authority(target, async () => {
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
          ...frameFields(target),
          desired: "stopped",
        },
        undefined,
        admission,
        signal,
      );
      if (result.status === "stopped") return "stopped";
      return result.status === "busy" ? "busy" : "failed";
    } catch (error) {
      if (superseded) return "superseded";
      if (error instanceof RuntimeDomainRequestError && error.code === "capacity") atCapacity = true;
      return "failed";
    }
  }
  async function runWorker(): Promise<void> {
    while (!signal.aborted && !atCapacity) {
      const target = targets[nextTargetIndex++];
      if (!target) return;
      outcomes.set(target.sessionId, await stopTarget(target));
    }
  }
  await Promise.all(Array.from({ length: Math.min(LOCAL_STOP_CONCURRENCY, targets.length) }, runWorker));
  return outcomes;
}

export async function stopAgentSessions(
  database: DatabaseClient,
  targets: AgentSessionStopTarget[],
  dependencies: AgentSessionStopDependencies,
): Promise<void> {
  if (targets.length === 0) return;
  const outcomes = await dispatchLocalStops(
    targets,
    dependencies,
    (target, enqueue) => withAgentSessionStopAuthority(database, target, enqueue),
    () => ({}),
  );
  const unconfirmed = targets.some(({ sessionId }) => {
    const outcome = outcomes.get(sessionId);
    return outcome === undefined || outcome === "busy" || outcome === "failed";
  });
  if (unconfirmed) throw new Error("Agent runtime stop notification failed");
}

export interface EndedInternalSessionStopDependencies extends AgentSessionStopDependencies {
  cloudSession?: Pick<CloudSessionCollaborationOwner, "cancelSessionMessages">;
  revokeProof(sessionId: string): Promise<void>;
  onDiagnostic?(code: string): void;
}

/**
 * Tells the execution side of internal Sessions that have already ended. The Sessions are stopped either
 * way; the answer says how far that reached. Never throws: a failure here is a `pending` stop, which the
 * caller can repeat and which is sent again when the Computer reconnects.
 */
export async function stopEndedInternalSessions(
  database: DatabaseClient,
  targets: InternalSessionStopTarget[],
  dependencies: EndedInternalSessionStopDependencies,
): Promise<Map<string, SessionCliStopExecution>> {
  const executions = new Map<string, SessionCliStopExecution>();
  const local = targets.filter((target) => target.computerKind === "local");
  for (const { sessionId } of targets.filter((target) => target.computerKind === "cloud")) {
    executions.set(sessionId, await cancelEndedCloudSession(sessionId, dependencies));
  }
  if (local.length === 0) return executions;
  const outcomes = await dispatchLocalStops(
    local,
    dependencies,
    (target, enqueue) => withEndedSessionStopAuthority(database, target, enqueue),
    ({ creatorSessionId }) => ({ sessionKind: "internal", creatorSessionId }),
  );
  for (const { sessionId } of local) {
    const outcome = outcomes.get(sessionId);
    if (outcome === "stopped") {
      await dependencies
        .revokeProof(sessionId)
        .catch(() => dependencies.onDiagnostic?.("SESSION_STOP_PROOF_REVOKE_FAILED"));
    }
    // An older Client answers a stop with busy while a Run is active; it has no way to interrupt it.
    executions.set(sessionId, outcome === "stopped" ? "stopped" : outcome === "busy" ? "not_interrupted" : "pending");
  }
  return executions;
}

async function cancelEndedCloudSession(
  sessionId: string,
  dependencies: EndedInternalSessionStopDependencies,
): Promise<SessionCliStopExecution> {
  try {
    const outcomes = await dependencies.cloudSession?.cancelSessionMessages(sessionId);
    if (!outcomes) return "pending";
    return outcomes.every((outcome) => outcome.status === "requested") ? "requested" : "pending";
  } catch {
    dependencies.onDiagnostic?.("CLOUD_SESSION_STOP_FAILED");
    return "pending";
  }
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
