import { and, eq } from "drizzle-orm";
import type { CloudModelProxyRouteOptions } from "../api/cloud-model-proxy.js";
import type { CloudBilling } from "../cloud-billing.js";
import type { DatabaseClient } from "../db/client.js";
import { agents, imBindings, sandboxes, sessions } from "../db/schema/index.js";

/** Billing is shared by cloud executions, connectivity probes, and the Account API. */
export function createCloudBillingRuntime(
  client: CloudBilling | undefined,
  modelEnabled: boolean,
  database: DatabaseClient,
): {
  accountOptions: { cloudBilling?: CloudBilling };
  modelOptions: { billing?: CloudModelProxyRouteOptions["billing"] };
} {
  if (!client || !modelEnabled) return { accountOptions: {}, modelOptions: {} };
  return {
    accountOptions: { cloudBilling: client },
    modelOptions: {
      billing: {
        client,
        accountForExecution: async (claims) => {
          const [row] = await database
            .select({ accountId: agents.createdByUserId })
            .from(sandboxes)
            .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
            .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
            .innerJoin(agents, eq(agents.id, imBindings.agentId))
            .where(and(eq(sandboxes.id, claims.sandboxId), eq(sessions.id, claims.sessionId)))
            .limit(1);
          return row?.accountId;
        },
      },
    },
  };
}
