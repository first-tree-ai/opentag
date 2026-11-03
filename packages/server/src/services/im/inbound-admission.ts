import { and, eq, inArray, isNotNull, ne, notExists, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  feishuInboundReceipts,
  imBindings,
  imMessages,
  slackInstallations,
  slackWebhookReceipts,
} from "../../db/schema/index.js";

export class InboundReceiptPendingError extends Error {
  readonly code = "IM_DELIVERY_INBOUND_PENDING";

  constructor() {
    super("Accepted inbound receipt work has not reached Inbox");
    this.name = "InboundReceiptPendingError";
  }
}

export async function lockImAgentCustody(transaction: DatabaseTransaction, agentId: string): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`im-agent-custody:${agentId}`}, 0))`);
}

export async function readInboundPendingAgents(database: DatabaseClient | DatabaseTransaction, agentIds: string[]) {
  const result = new Set<string>();
  const ids = [...new Set(agentIds)];
  for (let offset = 0; offset < ids.length; offset += 512) {
    const selected = ids.slice(offset, offset + 512);
    const feishu = await database
      .selectDistinct({ agentId: imBindings.agentId })
      .from(feishuInboundReceipts)
      .innerJoin(
        imBindings,
        and(
          eq(imBindings.id, feishuInboundReceipts.imBindingId),
          eq(imBindings.credentialGeneration, feishuInboundReceipts.credentialGeneration),
        ),
      )
      .where(
        and(
          inArray(imBindings.agentId, selected),
          eq(imBindings.provider, "feishu"),
          ne(imBindings.status, "disabled"),
          isNotNull(feishuInboundReceipts.workPayload),
          sql`${feishuInboundReceipts.status} in ('processing', 'failed')`,
          notExists(
            database
              .select({ id: imMessages.id })
              .from(imMessages)
              .where(
                and(
                  eq(imMessages.imBindingId, imBindings.id),
                  eq(imMessages.providerEventId, feishuInboundReceipts.eventId),
                ),
              ),
          ),
        ),
      );
    const slack = await database
      .selectDistinct({ agentId: imBindings.agentId })
      .from(slackWebhookReceipts)
      .innerJoin(
        slackInstallations,
        and(
          eq(slackInstallations.id, slackWebhookReceipts.installationId),
          eq(slackInstallations.credentialGeneration, slackWebhookReceipts.credentialGeneration),
        ),
      )
      .innerJoin(
        imBindings,
        and(
          eq(imBindings.slackInstallationId, slackInstallations.id),
          eq(imBindings.agentId, slackInstallations.agentId),
        ),
      )
      .where(
        and(
          inArray(imBindings.agentId, selected),
          eq(imBindings.provider, "slack"),
          ne(imBindings.status, "disabled"),
          ne(slackInstallations.status, "disabled"),
          isNotNull(slackWebhookReceipts.workPayload),
          sql`${slackWebhookReceipts.status} in ('processing', 'failed')`,
          notExists(
            database
              .select({ id: imMessages.id })
              .from(imMessages)
              .where(
                and(
                  eq(imMessages.imBindingId, imBindings.id),
                  eq(imMessages.providerEventId, slackWebhookReceipts.eventId),
                ),
              ),
          ),
        ),
      );
    for (const row of [...feishu, ...slack]) result.add(row.agentId);
  }
  return result;
}
