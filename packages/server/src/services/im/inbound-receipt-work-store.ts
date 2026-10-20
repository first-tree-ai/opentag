import { and, eq, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { slackInstallations } from "../../db/schema/index.js";
import { INBOUND_WORK_LEASE_MS, INBOUND_WORK_RETENTION_MS, InboundWorkSchema } from "./inbound-work.js";

type Provider = "slack" | "feishu";

export interface InboundReceiptAttempt {
  receiptId: string;
  scopeId: string;
  credentialGeneration: number;
  eventId: string;
  receivedAt: Date;
  attempt: number;
  payload: unknown;
}

function receiptTable(provider: Provider) {
  return sql.identifier(provider === "slack" ? "slack_webhook_receipts" : "feishu_inbound_receipts");
}

export class InboundReceiptWorkStore {
  constructor(
    readonly database: DatabaseClient,
    readonly provider: Provider,
    readonly now: () => Date,
  ) {}

  async claimNext(
    options: { scopeId?: string; holderInstanceId?: string } = {},
  ): Promise<InboundReceiptAttempt | undefined> {
    const now = this.now();
    const until = new Date(now.getTime() + INBOUND_WORK_LEASE_MS).toISOString();
    const cutoff = new Date(now.getTime() - INBOUND_WORK_RETENTION_MS).toISOString();
    const table = receiptTable(this.provider);
    const scopeColumn = sql.identifier(this.provider === "slack" ? "installation_id" : "im_binding_id");
    if (this.provider === "feishu" && !options.holderInstanceId) throw new Error("FEISHU_INBOUND_WORK_OWNER_REQUIRED");
    const rows = await this.database.execute(sql`
      with candidate as (
        select receipt.id from ${table} as receipt
        where work_payload is not null
          and status in ('processing', 'failed')
          and next_attempt_at <= ${now.toISOString()}::timestamptz
          and (lease_expires_at is null or lease_expires_at <= ${now.toISOString()}::timestamptz)
          and received_at > ${cutoff}::timestamptz
          ${options.scopeId ? sql`and ${scopeColumn} = ${options.scopeId}::uuid` : sql``}
          ${
            this.provider === "feishu"
              ? sql`and exists (
            select 1 from im_bindings as binding
            where binding.id = receipt.im_binding_id and binding.status = 'active'
              and binding.connection_owner_instance_id = ${options.holderInstanceId}::uuid
              and binding.connection_lease_expires_at > ${now.toISOString()}::timestamptz
          )`
              : sql``
          }
        order by next_attempt_at, id
        limit 1
        for update skip locked
      )
      update ${table} as receipt
      set status = 'processing', attempt_count = receipt.attempt_count + 1,
          last_error_code = null, last_error_at = null,
          lease_expires_at = ${until}::timestamptz, next_attempt_at = ${until}::timestamptz
      from candidate where receipt.id = candidate.id
      returning receipt.id as "receiptId", ${scopeColumn} as "scopeId",
          credential_generation as "credentialGeneration", event_id as "eventId",
          received_at as "receivedAt", attempt_count as attempt, work_payload as payload
    `);
    const row = rows[0];
    if (!row) return undefined;
    return {
      receiptId: String(row.receiptId),
      scopeId: String(row.scopeId),
      eventId: String(row.eventId),
      credentialGeneration: Number(row.credentialGeneration),
      attempt: Number(row.attempt),
      receivedAt: new Date(String(row.receivedAt)),
      payload: row.payload,
    };
  }

  parse(attempt: InboundReceiptAttempt) {
    const payload = InboundWorkSchema.parse(attempt.payload);
    if (payload.provider !== this.provider) throw new Error("IM_INBOUND_WORK_PROVIDER_MISMATCH");
    return payload;
  }

  async findCurrentSlackInstallation(attempt: InboundReceiptAttempt) {
    const [installation] = await this.database
      .select({ id: slackInstallations.id, grantedCapabilities: slackInstallations.grantedCapabilities })
      .from(slackInstallations)
      .where(
        and(
          eq(slackInstallations.id, attempt.scopeId),
          eq(slackInstallations.status, "active"),
          eq(slackInstallations.credentialGeneration, attempt.credentialGeneration),
        ),
      )
      .limit(1);
    return installation;
  }
}

export async function expireInboundReceiptWork(
  database: Pick<DatabaseClient, "execute">,
  now: Date,
  batchSize: number,
): Promise<void> {
  const cutoff = new Date(now.getTime() - INBOUND_WORK_RETENTION_MS).toISOString();
  for (const provider of ["slack", "feishu"] as const) {
    const table = receiptTable(provider);
    await database.execute(sql`
      with expired as (
        select id from ${table}
        where work_payload is not null and status in ('processing', 'failed')
          and received_at <= ${cutoff}::timestamptz
          and (lease_expires_at is null or lease_expires_at <= ${now.toISOString()}::timestamptz)
        order by received_at, id limit ${batchSize}
        for update skip locked
      )
      update ${table} as receipt
      set status = 'failed', work_payload = null, lease_expires_at = null, next_attempt_at = null,
          last_error_code = 'IM_INBOUND_WORK_EXPIRED', last_error_at = ${now.toISOString()}::timestamptz
      from expired where receipt.id = expired.id
    `);
  }
}
