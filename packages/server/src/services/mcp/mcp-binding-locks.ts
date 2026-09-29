import { asc, type SQL } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { agentMcpServers } from "../../db/schema/index.js";

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
