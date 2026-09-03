import { randomUUID } from "node:crypto";
import type { SessionReconcileResult } from "@opentag/shared";
import { eq } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { agents } from "../db/schema/index.js";
import type { AgentSessionStopTarget } from "../services/agents/index.js";

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
  ): Promise<SessionReconcileResult>;
}

export async function stopAgentSessions(
  database: DatabaseClient,
  targets: AgentSessionStopTarget[],
  dependencies: AgentSessionStopDependencies,
): Promise<void> {
  const firstTarget = targets[0];
  if (!firstTarget) return;
  const canStop = await database.transaction(async (transaction) => {
    const [agent] = await transaction
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, firstTarget.agentId))
      .limit(1);
    return Boolean(agent && agent.status !== "active");
  });
  if (!canStop) return;

  const dispatched = targets.flatMap((target) => {
    const currentInstanceId = dependencies.currentInstanceId(target.computerId);
    if (!currentInstanceId) return [];
    let markDispatched: () => void = () => undefined;
    const dispatch = new Promise<void>((resolve) => {
      markDispatched = resolve;
    });
    const result = dependencies.requestReconcile(
      target.computerId,
      currentInstanceId,
      {
        type: "session:reconcile",
        requestId: randomUUID(),
        installationId: target.installationId,
        sessionId: target.sessionId,
        agentId: target.agentId,
        placementGeneration: target.placementGeneration,
        desired: "stopped",
      },
      markDispatched,
    );
    void result.catch(() => markDispatched());
    return [{ dispatch, result }];
  });
  await Promise.all(dispatched.map(({ dispatch }) => dispatch));
  const results = await Promise.allSettled(dispatched.map(({ result }) => result));
  assertAgentSessionsStopped(results);
}

export function assertAgentSessionsStopped(results: PromiseSettledResult<SessionReconcileResult>[]): void {
  if (
    results.some(
      (result) => result.status === "rejected" || (result.status === "fulfilled" && result.value.status !== "stopped"),
    )
  ) {
    throw new Error("Agent runtime stop notification failed");
  }
}
