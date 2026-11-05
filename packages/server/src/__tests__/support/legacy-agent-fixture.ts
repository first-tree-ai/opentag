import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agentSchedules, agents, imBindings, sessionPlacements, sessions } from "../../db/schema/index.js";
import { disableImBindingInTransaction } from "../../services/im-bindings/index.js";
import { markEndedDescendantsInactive } from "../../services/sessions/session-closure.js";

/** Seeds a historical ownership transition to keep snapshot, custody and cleanup checks independent of today's management admission. */
export async function transferLegacyAgentFixture(
  database: DatabaseClient,
  input: { agentId: string; targetAccountId: string; slack: "keep" | "disable" },
) {
  return database.transaction(async (tx) => {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, input.agentId)).for("update");
    if (!agent) throw new Error("Missing legacy Agent fixture");
    const bindings = await tx
      .select()
      .from(imBindings)
      .where(and(eq(imBindings.agentId, agent.id), ne(imBindings.status, "disabled")))
      .for("update");
    const now = new Date();
    if (input.slack === "disable")
      for (const binding of bindings) await disableImBindingInTransaction(tx, binding.id, now);
    await tx
      .update(sessions)
      .set({ endedAt: now, revision: sql`${sessions.revision} + 1` })
      .where(
        and(
          isNull(sessions.endedAt),
          inArray(
            sessions.imBindingId,
            tx.select({ id: imBindings.id }).from(imBindings).where(eq(imBindings.agentId, agent.id)),
          ),
        ),
      );
    await markEndedDescendantsInactive(tx, { agentId: agent.id });
    await tx
      .update(agentSchedules)
      .set({ enabled: false, nextTriggerAt: null, revision: sql`${agentSchedules.revision} + 1` })
      .where(eq(agentSchedules.agentId, agent.id));
    await tx
      .update(agents)
      .set({ createdByUserId: input.targetAccountId, computerId: null, revision: sql`${agents.revision} + 1` })
      .where(eq(agents.id, agent.id))
      .returning();
    return {
      agentId: agent.id,
      sourceAccountId: agent.createdByUserId,
      targetAccountId: input.targetAccountId,
      imBinding: input.slack === "keep" ? "kept" : "disabled",
    };
  });
}

/** A legacy placement is an input fixture, never a permitted Computer replacement. */
export async function moveLegacyAgentFixture(database: DatabaseClient, agentId: string, computerId: string) {
  await database.transaction(async (tx) => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for("update");
    await tx
      .update(agents)
      .set({ computerId, revision: sql`${agents.revision} + 1` })
      .where(eq(agents.id, agentId));
    await tx
      .update(sessionPlacements)
      .set({ computerId, generation: sql`${sessionPlacements.generation} + 1` })
      .where(
        inArray(
          sessionPlacements.sessionId,
          tx
            .select({ id: sessions.id })
            .from(sessions)
            .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
            .where(eq(imBindings.agentId, agentId)),
        ),
      );
  });
}
