import { and, eq } from "drizzle-orm";
import type { CloudModelProxyRouteOptions } from "../api/cloud-model-proxy.js";
import type { DatabaseClient } from "../db/client.js";
import { agents, imBindings, imMessageDeliveries, sandboxes, sessions } from "../db/schema/index.js";
import { updateCurrentPerformanceContext } from "../observability/performance-logger.js";

/** Resolve execution ownership from persisted sandbox and session bindings. */
export function createCloudExecutionContext(
  database: DatabaseClient,
): CloudModelProxyRouteOptions["contextForExecution"] {
  return async (claims) => {
    const [row] = await database
      .select({
        accountId: agents.createdByUserId,
        agentId: agents.id,
        sessionId: sessions.id,
        deliveryId: imMessageDeliveries.id,
      })
      .from(sandboxes)
      .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .leftJoin(
        imMessageDeliveries,
        and(eq(imMessageDeliveries.sessionId, sessions.id), eq(imMessageDeliveries.turnId, claims.executionId)),
      )
      .where(and(eq(sandboxes.id, claims.sandboxId), eq(sessions.id, claims.sessionId)))
      .limit(1);
    if (!row) return undefined;
    updateCurrentPerformanceContext({
      accountId: row.accountId,
      agentId: row.agentId,
      sessionId: row.sessionId,
      sandboxId: claims.sandboxId,
      turnId: claims.executionId,
      ...(row.deliveryId ? { deliveryId: row.deliveryId } : {}),
    });
    return {
      accountId: row.accountId,
      agentId: row.agentId,
      sessionId: row.sessionId,
      source: "execution" as const,
    };
  };
}
