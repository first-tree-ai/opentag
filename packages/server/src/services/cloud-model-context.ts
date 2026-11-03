import { and, eq } from "drizzle-orm";
import type { CloudModelProxyRouteOptions } from "../api/cloud-model-proxy.js";
import type { DatabaseClient } from "../db/client.js";
import { agents, imBindings, sandboxes, sessions } from "../db/schema/index.js";

/** Resolve execution ownership from persisted sandbox and session bindings. */
export function createCloudExecutionContext(
  database: DatabaseClient,
): CloudModelProxyRouteOptions["contextForExecution"] {
  return async (claims) => {
    const [row] = await database
      .select({ accountId: agents.createdByUserId, agentId: agents.id, sessionId: sessions.id })
      .from(sandboxes)
      .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(and(eq(sandboxes.id, claims.sandboxId), eq(sessions.id, claims.sessionId)))
      .limit(1);
    return row ? { ...row, source: "execution" as const } : undefined;
  };
}
