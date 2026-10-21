import { and, asc, eq, ne, type SQL } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { agentMcpServers, agents, mcpServers } from "../../db/schema/index.js";
import { mcpBindingNotFound } from "./errors.js";

/**
 * Edits and cleanup lock bindings before authorization rows. Bulk operations use the same primary-key
 * order so overlapping Agent/Server scopes cannot invert their binding locks either. If a transaction
 * also locks a Server definition, it must acquire that lock before calling this helper.
 */
export function lockMcpBindings(transaction: DatabaseTransaction, scope: SQL | undefined) {
  return transaction
    .select()
    .from(agentMcpServers)
    .where(scope)
    .orderBy(asc(agentMcpServers.agentId), asc(agentMcpServers.mcpServerId))
    .for("update");
}

export async function lockMcpCredentialBinding(
  transaction: DatabaseTransaction,
  accountId: string,
  agentId: string,
  mcpServerId: string,
) {
  // Shared parent locks fence edits/deletion without serializing saves on independent mounts.
  const [agent] = await transaction
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, accountId), ne(agents.status, "deleted")))
    .for("share");
  if (!agent) throw mcpBindingNotFound();
  const [server] = await transaction
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(eq(mcpServers.id, mcpServerId), eq(mcpServers.accountId, accountId)))
    .for("share");
  if (!server) throw mcpBindingNotFound();
  const [binding] = await lockMcpBindings(
    transaction,
    and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, mcpServerId)),
  );
  if (!binding) throw mcpBindingNotFound();
  return binding;
}
