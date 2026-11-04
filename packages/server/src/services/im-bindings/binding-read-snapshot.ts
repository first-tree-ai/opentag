import { and, desc, eq, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, computers, imBindings, imMessages, slackInstallations } from "../../db/schema/index.js";

export async function readBindingActivity(executor: Pick<DatabaseClient, "select">, imBindingId: string) {
  const [inbound] = await executor
    .select({ at: imMessages.receivedAt })
    .from(imMessages)
    .where(and(eq(imMessages.imBindingId, imBindingId), eq(imMessages.direction, "inbound")))
    .orderBy(desc(imMessages.receivedAt))
    .limit(1);
  return { lastInboundAt: inbound?.at.toISOString() ?? null };
}

export async function readBindingDiagnostics(database: DatabaseClient, callerUserId: string, imBindingId: string) {
  return database.transaction(
    async (transaction) => {
      const [selected] = await transaction
        .select({
          binding: imBindings,
          slackInstallation: slackInstallations,
          computerKind: computers.kind,
          agentStatus: agents.status,
        })
        .from(imBindings)
        .innerJoin(agents, eq(agents.id, imBindings.agentId))
        .leftJoin(computers, eq(computers.id, agents.computerId))
        .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
        .where(
          and(eq(imBindings.id, imBindingId), eq(agents.createdByUserId, callerUserId), ne(agents.status, "deleted")),
        )
        .limit(1);
      if (!selected) return undefined;
      const row = {
        ...selected.binding,
        slackInstallation: selected.slackInstallation,
        computerKind: selected.computerKind,
        agentStatus: selected.agentStatus,
      };
      return { row, activity: await readBindingActivity(transaction, imBindingId) };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
