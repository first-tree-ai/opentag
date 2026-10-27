import { and, asc, eq, ne, type SQL } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { agentMcpServers, agents, mcpServers } from "../../db/schema/index.js";
import { AgentServiceError } from "../agents/index.js";
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
  source: "account" | "agent-self" = "account",
) {
  // Shared parent locks fence edits/deletion without serializing saves on independent mounts.
  const [agent] = await transaction
    .select({ id: agents.id, selfConfigurationEnabled: agents.selfConfigurationEnabled })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, accountId), ne(agents.status, "deleted")))
    .for(source === "agent-self" ? "update" : "share");
  if (!agent) throw mcpBindingNotFound();
  if (source === "agent-self" && !agent.selfConfigurationEnabled) {
    throw new AgentServiceError(
      "AGENT_SELF_CONFIGURATION_DISABLED",
      "deterministic",
      "Agent self-configuration is disabled by the Agent owner",
      403,
    );
  }
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
