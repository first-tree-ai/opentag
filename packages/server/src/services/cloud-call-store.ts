import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type CloudCallContext,
  type CloudModelReference,
  type CloudTokenRates,
  CloudTokenRatesSchema,
  type CloudUsageObservation,
  CloudUsageObservationSchema,
} from "../cloud-call-contracts.js";

export interface CloudQueryConnection {
  query(statement: string, parameters?: unknown[]): Promise<{ rows: unknown[] }>;
}
const integer = z.coerce.number().int().safe().nonnegative();
export const CloudCallSchema = z.object({
  id: z.string(),
  account: z.string(),
  agent_id: z.string(),
  session_id: z.string().nullable(),
  source: z.enum(["execution", "connectivity_probe"]),
  gateway: z.string(),
  model: z.string(),
  response_id: z.string().nullable(),
  provider_call_id: z.string().nullable(),
  rates: CloudTokenRatesSchema.nullable(),
  state: z.enum(["in_flight", "pending_usage", "finalized"]),
  usage_complete: z.boolean(),
  input_tokens: integer.nullable(),
  cached_input_tokens: integer.nullable(),
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
  async observe(id: string, raw: CloudUsageObservation, connection = this.db): Promise<void> {
    const value = CloudUsageObservationSchema.parse(raw);
    await connection.query(
      `UPDATE billing.attempts SET
      response_id=coalesce(response_id,$2),provider_call_id=coalesce(provider_call_id,$3),
      input_tokens=coalesce($4,input_tokens),cached_input_tokens=coalesce($5,cached_input_tokens),output_tokens=coalesce($6,output_tokens),usage_complete=usage_complete OR $7
      WHERE id=$1 AND state <> 'finalized' AND (NOT usage_complete OR state='pending_usage')`,
      [
        id,
        value.responseId ?? null,
        value.providerCallId ?? null,
        value.inputTokens ?? null,
        value.cachedInputTokens ?? null,
        value.outputTokens ?? null,
        value.complete,
      ],
    );
  }
  async finishUnbilled(id: string): Promise<void> {
    await this.db.query(
      "UPDATE billing.attempts SET state='finalized',resolution='unbilled',finished_at=now() WHERE id=$1 AND rates IS NULL AND state <> 'finalized'",
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
      "UPDATE billing.attempts SET reconcile_after=now()+interval '30 seconds' * least(power(2,reconcile_failures),120),reconcile_failures=least(reconcile_failures+1,7) WHERE id=$1 AND state='pending_usage'",
      [id],
    );
  }
  async expire(before: Date): Promise<void> {
    await this.db.query(
      "UPDATE billing.attempts SET state='pending_usage',finished_at=coalesce(finished_at,now()) WHERE state='in_flight' AND rates IS NOT NULL AND created_at<$1",
      [before.toISOString()],
    );
  }
  /** Single replica, stop-first deployments ensure the previous process has stopped. */
  async abandon(): Promise<void> {
    await this.db.query(
      "UPDATE billing.attempts SET state='pending_usage',finished_at=now() WHERE state='in_flight' AND rates IS NOT NULL",
    );
    await this.db.query(
      "UPDATE billing.attempts SET state='finalized',resolution='unbilled',finished_at=now() WHERE state='in_flight' AND rates IS NULL",
    );
  }
}
