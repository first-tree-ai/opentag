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
    const agent = transaction.$with("stop_agent").as(
      transaction
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(eq(agents.id, target.agentId), eq(agents.revision, target.agentRevision), ne(agents.status, "active")),
        )
        .limit(1)
        .for("no key update"),
    );
    const session = transaction.$with("stop_session").as(
      transaction
        .select({ id: sessions.id })
        .from(sessions)
        .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
        .innerJoin(agent, eq(agent.id, imBindings.agentId))
        .where(and(eq(sessions.id, target.sessionId), eq(imBindings.agentId, target.agentId)))
        .limit(1)
        .for("no key update", { of: sessions }),
    );
    const [placement] = await transaction
      .with(agent, session)
      .select({ sessionId: sessionPlacements.sessionId })
      .from(sessionPlacements)
      .innerJoin(session, eq(session.id, sessionPlacements.sessionId))
      .where(
        and(
          eq(sessionPlacements.sessionId, target.sessionId),
          eq(sessionPlacements.computerId, target.computerId),
          eq(sessionPlacements.generation, target.placementGeneration),
        ),
      )
      .limit(1)
      .for("update", { of: sessionPlacements });
    if (!placement) return undefined;
    return enqueue(transaction);
  });
}
