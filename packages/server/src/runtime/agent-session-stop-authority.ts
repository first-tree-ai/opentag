import { and, eq, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import { agents, imBindings, sessionPlacements, sessions } from "../db/schema/index.js";
import type { AgentSessionStopTarget } from "../services/agents/agent-service.js";

export async function withAgentSessionStopAuthority<T>(
  database: DatabaseClient,
  target: AgentSessionStopTarget,
  enqueue: (transaction: DatabaseTransaction) => Promise<T>,
): Promise<T | undefined> {
  return database.transaction(async (transaction) => {
    const [agent] = await transaction
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, target.agentId), eq(agents.revision, target.agentRevision), ne(agents.status, "active")))
      .limit(1)
      .for("no key update");
    if (!agent) return undefined;
    const [session] = await transaction
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .where(and(eq(sessions.id, target.sessionId), eq(imBindings.agentId, target.agentId)))
      .limit(1)
      .for("no key update", { of: sessions });
    if (!session) return undefined;
    const [placement] = await transaction
      .select({ sessionId: sessionPlacements.sessionId })
      .from(sessionPlacements)
      .where(
        and(
          eq(sessionPlacements.sessionId, target.sessionId),
          eq(sessionPlacements.computerId, target.computerId),
          eq(sessionPlacements.generation, target.placementGeneration),
        ),
      )
      .limit(1)
      .for("update");
    if (!placement) return undefined;
    return enqueue(transaction);
  });
}
