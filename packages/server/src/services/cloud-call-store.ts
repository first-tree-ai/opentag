import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type CloudCallContext,
  type CloudCallResult,
  CloudCallResultSchema,
  type CloudModelReference,
  type CloudTokenRates,
  CloudTokenRatesSchema,
} from "../cloud-call-contracts.js";

export interface CloudQueryConnection {
  query(statement: string, parameters?: unknown[]): Promise<{ rows: unknown[] }>;
}
const integer = z.coerce.number().int().safe().nonnegative();
// Covers the router's default 120-second disconnect drain without backing off during it.
export const CLOUD_USAGE_FAST_RETRY_SECONDS = 150;
export const CloudCallSchema = z.object({
  id: z.string(),
  account: z.string(),
  agent_id: z.string(),
  session_id: z.string().nullable(),
  source: z.enum(["execution", "connectivity_probe"]),
  gateway: z.string(),
  model: z.string(),
  rates: CloudTokenRatesSchema.nullable(),
  state: z.enum(["in_flight", "pending_usage", "finalized"]),
  finished_at: z.coerce.date().nullable(),
  reconcile_failures: integer,
  input_tokens: integer.nullable(),
  cached_input_tokens: integer.nullable(),
  cache_write_input_tokens: integer.nullable(),
  output_tokens: integer.nullable(),
  priced_micros: integer.nullable(),
  debited_micros: integer.nullable(),
});
export type CloudCall = z.infer<typeof CloudCallSchema>;

/** Shared call persistence for metered and unbilled cloud requests. No pricing or payment logic. */
export class CloudCallStore {
  constructor(readonly db: CloudQueryConnection) {}
  async create(
    context: CloudCallContext,
    model: CloudModelReference,
    rates: CloudTokenRates | null,
    connection = this.db,
  ): Promise<string> {
    const id = randomUUID();
    await connection.query(
      "INSERT INTO billing.attempts(id,account,agent_id,session_id,source,gateway,model,rates) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
      [id, context.accountId, context.agentId, context.sessionId, context.source, model.gateway, model.model, rates],
    );
    return id;
  }
  async get(id: string, connection = this.db): Promise<CloudCall> {
    const { rows } = await connection.query("SELECT * FROM billing.attempts WHERE id=$1", [id]);
    return CloudCallSchema.parse(rows[0]);
  }
  async finalize(
    id: string,
    raw: CloudCallResult,
    charge: { resolution: "charged" | "no_charge" | "unbilled"; pricedMicros: number; debitedMicros: number },
    connection = this.db,
  ): Promise<void> {
    const result = CloudCallResultSchema.parse(raw);
    const usage = result.status === "complete" ? result.usage : undefined;
    await connection.query(
      `UPDATE billing.attempts SET state='finalized',resolution=$2,input_tokens=$3,cached_input_tokens=$4,cache_write_input_tokens=$5,output_tokens=$6,priced_micros=$7,debited_micros=$8,finished_at=coalesce(finished_at,now()) WHERE id=$1 AND state <> 'finalized' AND (rates IS NULL OR $2 <> 'unbilled')`,
      [
        id,
        charge.resolution,
        usage?.inputTokens ?? null,
        usage?.cachedInputTokens ?? null,
        usage?.cacheWriteInputTokens ?? null,
        usage?.outputTokens ?? null,
        charge.pricedMicros,
        charge.debitedMicros,
      ],
    );
  }
  async markPending(id: string): Promise<void> {
    await this.db.query(
      "UPDATE billing.attempts SET state='pending_usage',finished_at=coalesce(finished_at,now()) WHERE id=$1 AND state <> 'finalized'",
      [id],
    );
  }
  async pending(now = new Date()): Promise<CloudCall[]> {
    return z
      .array(CloudCallSchema)
      .parse(
        (
          await this.db.query(
            "SELECT * FROM billing.attempts WHERE state='pending_usage' AND reconcile_after<=$1 ORDER BY reconcile_after,created_at LIMIT 100",
            [now.toISOString()],
          )
        ).rows,
      );
  }
  async defer(id: string): Promise<void> {
    await this.db.query(
      `UPDATE billing.attempts SET reconcile_after=now()+CASE WHEN finished_at>now()-$2*interval '1 second' THEN interval '5 seconds' ELSE interval '30 seconds' * least(power(2,reconcile_failures),120) END,reconcile_failures=CASE WHEN finished_at>now()-$2*interval '1 second' THEN reconcile_failures ELSE least(reconcile_failures+1,7) END WHERE id=$1 AND state='pending_usage'`,
      [id, CLOUD_USAGE_FAST_RETRY_SECONDS],
    );
  }
  async expire(before: Date): Promise<void> {
    await this.db.query(
      "UPDATE billing.attempts SET state='pending_usage',finished_at=coalesce(finished_at,now()) WHERE state='in_flight' AND created_at<$1",
      [before.toISOString()],
    );
  }
  /** Unfinished calls are recovered from router status, including billing-disabled calls. */
  async abandon(): Promise<void> {
    await this.db.query(
      "UPDATE billing.attempts SET state='pending_usage',finished_at=coalesce(finished_at,now()) WHERE state='in_flight'",
    );
  }
}
